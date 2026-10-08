import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ChannelStatus = "waiting" | "active" | "complete" | "closed";
export type MemberStatus = "present" | "done" | "left";
export type MsgType = "INFO" | "ASK" | "REPLY" | "HOLD" | "DONE" | "SYSTEM" | "OPERATOR";

export interface Channel {
  name: string;
  roles: string[];
  status: ChannelStatus;
  task: string | null;
  contract_path: string | null;
  created_at: string;
}

export interface Member {
  channel: string;
  role: string;
  session_id: string;
  scope: string | null;
  status: MemberStatus;
  joined_at: string;
  last_read: number;
}

export interface Token {
  token: string;
  channel: string;
  role: string;
  label: string | null;
  created_at: string;
  last_used: string | null;
}

export interface Message {
  id: number;
  channel: string;
  from_role: string;
  to_role: string | null;
  type: MsgType;
  body: string;
  reply_to: number | null;
  created_at: string;
}

type ChannelRow = Omit<Channel, "roles"> & { roles: string };

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS channels (
        name TEXT PRIMARY KEY,
        roles TEXT NOT NULL,
        status TEXT NOT NULL,
        task TEXT,
        contract_path TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        channel TEXT NOT NULL,
        role TEXT NOT NULL,
        session_id TEXT NOT NULL,
        scope TEXT,
        status TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        last_read INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel, role)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        from_role TEXT NOT NULL,
        to_role TEXT,
        type TEXT NOT NULL,
        body TEXT NOT NULL,
        reply_to INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_channel_id ON messages(channel, id);
      CREATE TABLE IF NOT EXISTS tokens (
        token TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        role TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL,
        last_used TEXT
      );
    `);
  }

  private now(): string {
    return new Date().toISOString();
  }

  private toChannel(row: ChannelRow): Channel {
    return { ...row, roles: JSON.parse(row.roles) as string[] };
  }

  // ---- channels ----

  createChannel(name: string, roles: string[], contractPath: string | null): Channel {
    this.db
      .prepare(
        `INSERT INTO channels (name, roles, status, task, contract_path, created_at) VALUES (?, ?, 'waiting', NULL, ?, ?)`,
      )
      .run(name, JSON.stringify(roles), contractPath, this.now());
    return this.getChannel(name)!;
  }

  getChannel(name: string): Channel | undefined {
    const row = this.db.prepare(`SELECT * FROM channels WHERE name = ?`).get(name) as ChannelRow | undefined;
    return row ? this.toChannel(row) : undefined;
  }

  listChannels(): Channel[] {
    const rows = this.db.prepare(`SELECT * FROM channels ORDER BY created_at`).all() as ChannelRow[];
    return rows.map((r) => this.toChannel(r));
  }

  setChannelStatus(name: string, status: ChannelStatus): void {
    this.db.prepare(`UPDATE channels SET status = ? WHERE name = ?`).run(status, name);
  }

  setChannelTask(name: string, task: string): void {
    this.db.prepare(`UPDATE channels SET task = ? WHERE name = ?`).run(task, name);
  }

  // ---- members ----

  upsertMember(m: Omit<Member, "joined_at" | "last_read">): Member {
    const existing = this.getMember(m.channel, m.role);
    if (existing) {
      this.db
        .prepare(`UPDATE members SET session_id = ?, scope = ?, status = ? WHERE channel = ? AND role = ?`)
        .run(m.session_id, m.scope, m.status, m.channel, m.role);
    } else {
      this.db
        .prepare(
          `INSERT INTO members (channel, role, session_id, scope, status, joined_at, last_read) VALUES (?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(m.channel, m.role, m.session_id, m.scope, m.status, this.now());
    }
    return this.getMember(m.channel, m.role)!;
  }

  getMember(channel: string, role: string): Member | undefined {
    return this.db.prepare(`SELECT * FROM members WHERE channel = ? AND role = ?`).get(channel, role) as
      | Member
      | undefined;
  }

  getMemberBySession(channel: string, sessionId: string): Member | undefined {
    return this.db
      .prepare(`SELECT * FROM members WHERE channel = ? AND session_id = ? AND status != 'left'`)
      .get(channel, sessionId) as Member | undefined;
  }

  listMembers(channel: string): Member[] {
    return this.db.prepare(`SELECT * FROM members WHERE channel = ? ORDER BY joined_at`).all(channel) as unknown as Member[];
  }

  listMembersBySession(sessionId: string): Member[] {
    return this.db.prepare(`SELECT * FROM members WHERE session_id = ?`).all(sessionId) as unknown as Member[];
  }

  setMemberStatus(channel: string, role: string, status: MemberStatus): void {
    this.db.prepare(`UPDATE members SET status = ? WHERE channel = ? AND role = ?`).run(status, channel, role);
  }

  setLastRead(channel: string, role: string, lastRead: number): void {
    this.db
      .prepare(`UPDATE members SET last_read = MAX(last_read, ?) WHERE channel = ? AND role = ?`)
      .run(lastRead, channel, role);
  }

  // ---- messages ----

  insertMessage(m: Omit<Message, "id" | "created_at">): Message {
    const result = this.db
      .prepare(
        `INSERT INTO messages (channel, from_role, to_role, type, body, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.channel, m.from_role, m.to_role, m.type, m.body, m.reply_to, this.now());
    return this.getMessage(Number(result.lastInsertRowid))!;
  }

  getMessage(id: number): Message | undefined {
    return this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as Message | undefined;
  }

  countMessages(channel: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE channel = ?`).get(channel) as { n: number };
    return row.n;
  }

  /** All messages in a channel after `since` (for humans / tail). */
  listMessages(channel: string, since = 0, limit = 200): Message[] {
    return this.db
      .prepare(`SELECT * FROM messages WHERE channel = ? AND id > ? ORDER BY id LIMIT ?`)
      .all(channel, since, limit) as unknown as Message[];
  }

  /** Messages visible to `role`: not authored by it, broadcast or addressed to it. */
  listVisibleMessages(channel: string, role: string, since: number, limit = 100): Message[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE channel = ? AND id > ? AND from_role != ? AND (to_role IS NULL OR to_role = ?)
         ORDER BY id LIMIT ?`,
      )
      .all(channel, since, role, role, limit) as unknown as Message[];
  }

  countVisibleMessages(channel: string, role: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
         WHERE channel = ? AND id > ? AND from_role != ? AND (to_role IS NULL OR to_role = ?)`,
      )
      .get(channel, since, role, role) as { n: number };
    return row.n;
  }

  findReply(askId: number): Message | undefined {
    return this.db.prepare(`SELECT * FROM messages WHERE type = 'REPLY' AND reply_to = ? ORDER BY id LIMIT 1`).get(askId) as
      | Message
      | undefined;
  }

  /** Unanswered ASKs from `fromRole` to `toRole` in a channel. */
  pendingAsks(channel: string, fromRole: string, toRole: string): Message[] {
    return this.db
      .prepare(
        `SELECT a.* FROM messages a
         LEFT JOIN messages r ON r.type = 'REPLY' AND r.reply_to = a.id
         WHERE a.channel = ? AND a.type = 'ASK' AND a.from_role = ? AND a.to_role = ? AND r.id IS NULL
         ORDER BY a.id`,
      )
      .all(channel, fromRole, toRole) as unknown as Message[];
  }

  /** Remove a channel and everything attached to it. */
  deleteChannel(name: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM tokens WHERE channel = ?`).run(name);
      this.db.prepare(`DELETE FROM messages WHERE channel = ?`).run(name);
      this.db.prepare(`DELETE FROM members WHERE channel = ?`).run(name);
      this.db.prepare(`DELETE FROM channels WHERE name = ?`).run(name);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- tokens (agent identity for remote / REST use) ----

  insertToken(t: Omit<Token, "created_at" | "last_used">): Token {
    this.db
      .prepare(`INSERT INTO tokens (token, channel, role, label, created_at, last_used) VALUES (?, ?, ?, ?, ?, NULL)`)
      .run(t.token, t.channel, t.role, t.label, this.now());
    return this.getToken(t.token)!;
  }

  getToken(token: string): Token | undefined {
    return this.db.prepare(`SELECT * FROM tokens WHERE token = ?`).get(token) as Token | undefined;
  }

  listTokens(channel: string): Token[] {
    return this.db.prepare(`SELECT * FROM tokens WHERE channel = ? ORDER BY created_at`).all(channel) as unknown as Token[];
  }

  deleteToken(token: string): boolean {
    return this.db.prepare(`DELETE FROM tokens WHERE token = ?`).run(token).changes > 0;
  }

  deleteTokensForRole(channel: string, role: string): string[] {
    const old = this.db.prepare(`SELECT token FROM tokens WHERE channel = ? AND role = ?`).all(channel, role) as unknown as Array<{ token: string }>;
    this.db.prepare(`DELETE FROM tokens WHERE channel = ? AND role = ?`).run(channel, role);
    return old.map((o) => o.token);
  }

  touchToken(token: string): void {
    this.db.prepare(`UPDATE tokens SET last_used = ? WHERE token = ?`).run(this.now(), token);
  }

  close(): void {
    this.db.close();
  }
}
