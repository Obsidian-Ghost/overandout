import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Store, type Channel, type Member, type Message, type MsgType, type Token } from "./store.ts";
import { summarize } from "./contract.ts";

export class RelayError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "RelayError";
    this.code = code;
  }
}

export interface RelayOptions {
  /** Upper bound for any single blocking call. Keep below the MCP client's tool timeout. */
  maxWaitMs?: number;
  /** Directory where contract files live; used to derive a channel's contract path. */
  contractsDir?: string;
  /**
   * A session that has made no request for this long is considered gone, so a new agent may take
   * over its role. MCP clients that die without sending DELETE never notify the server otherwise.
   * Must exceed maxWaitMs, since an idle agent inside `wait` re-polls every maxWaitMs.
   */
  staleAfterMs?: number;
}

export interface JoinResult {
  status: "active" | "waiting" | "complete" | "closed";
  channel: string;
  role: string;
  task: string | null;
  roster: RosterEntry[];
  missing: string[];
  contract_path: string | null;
  /** Questions you asked earlier that are still unanswered (relevant after a reconnect). */
  your_pending_asks: Array<{ id: number; to: string; body: string }>;
  hint: string;
}

export interface InboxResult {
  messages: Message[];
  cursor: number;
  unread: number;
}

export interface AskResult {
  status: "answered" | "timeout";
  ask_id: number;
  reply: Message | null;
  hint: string;
}

export interface WaitResult {
  status: "messages" | "timeout" | "closed";
  channel_status: string;
  inbox: InboxResult;
  hint: string;
}

export interface RosterEntry {
  role: string;
  status: string;
  scope: string | null;
  /** ISO timestamp of the last request from the agent holding this role, if any. */
  last_seen: string | null;
  /** True when the holder has made a request recently (within staleAfterMs). */
  live: boolean;
}

/**
 * Identity keys: "ses:<mcp-session-id>" for anonymous local sessions, "tok:<token>" for
 * token-authenticated agents (remote, REST, or any MCP client sending a bearer token).
 */
export const sessionIdentity = (mcpSessionId: string) => `ses:${mcpSessionId}`;
export const tokenIdentity = (token: string) => `tok:${token}`;

const isChannelName = (s: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(s);

/**
 * Core coordination logic, transport-agnostic. All blocking primitives are built on
 * `waitUntil`, which re-evaluates a predicate whenever any state changes.
 */
export class Relay {
  readonly store: Store;
  readonly maxWaitMs: number;
  readonly staleAfterMs: number;
  readonly contractsDir: string;
  private readonly events = new EventEmitter();

  constructor(store: Store, opts: RelayOptions = {}) {
    this.store = store;
    this.maxWaitMs = opts.maxWaitMs ?? 50_000;
    this.staleAfterMs = opts.staleAfterMs ?? Math.max(90_000, this.maxWaitMs * 2);
    this.contractsDir = resolve(opts.contractsDir ?? "contracts");
    this.events.setMaxListeners(0);
  }

  // ------------------------------------------------------------------
  // change notification + generic long-poll
  // ------------------------------------------------------------------

  private touch(): void {
    this.events.emit("change");
  }

  onChange(listener: () => void): () => void {
    this.events.on("change", listener);
    return () => this.events.off("change", listener);
  }

  private clampWait(ms: number | undefined): number {
    if (ms === undefined || !Number.isFinite(ms)) return this.maxWaitMs;
    return Math.max(0, Math.min(ms, this.maxWaitMs));
  }

  /**
   * Resolve with the first defined value from `check`, re-running it on every change; undefined on
   * timeout. If `check` throws (e.g. the channel was deleted under a waiter) the promise rejects with
   * that error; the exception never escapes into the emitter, so other waiters and mutations are safe.
   */
  waitUntil<T>(check: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
    const first = check();
    if (first !== undefined || timeoutMs <= 0) return Promise.resolve(first);
    return new Promise<T | undefined>((resolve, reject) => {
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        this.events.off("change", onChange);
        fn();
      };
      const onChange = () => {
        try {
          const v = check();
          if (v !== undefined) settle(() => resolve(v));
        } catch (err) {
          settle(() => reject(err));
        }
      };
      const timer = setTimeout(() => settle(() => resolve(undefined)), timeoutMs);
      this.events.on("change", onChange);
    });
  }

  // ------------------------------------------------------------------
  // channel management (human side)
  // ------------------------------------------------------------------

  createChannel(name: string, roles: string[]): Channel {
    if (!isChannelName(name)) throw new RelayError(`invalid channel name "${name}"`, "invalid_name");
    const clean = [...new Set(roles.map((r) => r.trim()).filter(Boolean))];
    if (clean.length < 1) throw new RelayError("a channel needs at least one role", "invalid_roles");
    if (this.store.getChannel(name)) throw new RelayError(`channel "${name}" already exists`, "exists");
    const ch = this.store.createChannel(name, clean, `${this.contractsDir}/${name}.openapi.yaml`);
    this.touch();
    return ch;
  }

  listChannels(): Channel[] {
    return this.store.listChannels();
  }

  channel(name: string): Channel {
    const ch = this.store.getChannel(name);
    if (!ch) throw new RelayError(`channel "${name}" does not exist`, "no_channel");
    return ch;
  }

  publish(name: string, task: string): Channel {
    const ch = this.channel(name);
    if (ch.status === "closed") throw new RelayError(`channel "${name}" is closed`, "closed");
    if (!task.trim()) throw new RelayError("task is empty", "invalid_task");
    this.store.setChannelTask(name, task);
    this.systemPost(name, ch.task ? `task updated:\n${task}` : `task published:\n${task}`);
    this.recomputeStatus(name);
    this.touch();
    return this.channel(name);
  }

  closeChannel(name: string): Channel {
    this.channel(name);
    this.store.setChannelStatus(name, "closed");
    this.systemPost(name, "channel closed by operator");
    this.touch();
    return this.channel(name);
  }

  deleteChannel(name: string): void {
    this.channel(name);
    for (const t of this.store.listTokens(name)) this.lastSeen.delete(tokenIdentity(t.token));
    this.store.deleteChannel(name);
    this.touch();
  }

  status(name: string) {
    const ch = this.channel(name);
    const members = this.store.listMembers(name);
    const pending: Array<{ id: number; from: string; to: string; body: string; created_at: string }> = [];
    for (const a of members) {
      for (const b of members) {
        if (a.role === b.role) continue;
        for (const m of this.store.pendingAsks(name, a.role, b.role)) {
          pending.push({ id: m.id, from: m.from_role, to: m.to_role!, body: m.body, created_at: m.created_at });
        }
      }
    }
    pending.sort((x, y) => x.id - y.id);
    return {
      ...ch,
      roster: this.roster(name),
      missing: this.missingRoles(name),
      pending_asks: pending,
      message_count: this.store.countMessages(name),
    };
  }

  messages(name: string, since = 0, limit = 200): Message[] {
    this.channel(name);
    return this.store.listMessages(name, since, limit);
  }

  /** Human operator injects an authoritative instruction into the channel (broadcast or to one role). */
  operatorPost(name: string, body: string, toRole?: string): Message {
    this.assertOpen(name);
    if (!body.trim()) throw new RelayError("body is empty", "invalid_body");
    if (toRole) this.assertRole(name, toRole);
    const msg = this.store.insertMessage({
      channel: name,
      from_role: "operator",
      to_role: toRole ?? null,
      type: "OPERATOR",
      body,
      reply_to: null,
    });
    this.touch();
    return msg;
  }

  /** Human operator answers a pending ASK on behalf of the addressee; the asker's blocking ask resolves. */
  operatorReply(askId: number, body: string): Message {
    const ask = this.store.getMessage(askId);
    if (!ask || ask.type !== "ASK") throw new RelayError(`ask ${askId} not found`, "no_message");
    this.assertOpen(ask.channel);
    if (this.store.findReply(askId)) throw new RelayError(`ask ${askId} already answered`, "already_answered");
    if (!body.trim()) throw new RelayError("body is empty", "invalid_body");
    const msg = this.store.insertMessage({
      channel: ask.channel,
      from_role: "operator",
      to_role: ask.from_role,
      type: "REPLY",
      body: `[answered by operator on behalf of ${ask.to_role}] ${body}`,
      reply_to: askId,
    });
    this.touch();
    return msg;
  }

  /** Current contract file for a channel, if any. */
  contract(name: string): { path: string | null; exists: boolean; content: string } {
    const ch = this.channel(name);
    if (!ch.contract_path) return { path: null, exists: false, content: "" };
    try {
      return { path: ch.contract_path, exists: true, content: readFileSync(ch.contract_path, "utf8") };
    } catch {
      return { path: ch.contract_path, exists: false, content: "" };
    }
  }

  systemPost(channel: string, body: string): Message {
    const msg = this.store.insertMessage({
      channel,
      from_role: "relay",
      to_role: null,
      type: "SYSTEM",
      body,
      reply_to: null,
    });
    this.touch();
    return msg;
  }

  // ------------------------------------------------------------------
  // roster helpers
  // ------------------------------------------------------------------

  private roster(name: string): RosterEntry[] {
    const ch = this.channel(name);
    const members = new Map(this.store.listMembers(name).map((m) => [m.role, m]));
    return ch.roles.map((role) => {
      const m = members.get(role);
      const seen = m ? this.lastSeen.get(m.session_id) : undefined;
      // Token identities persist their last use in the DB, so "last seen" survives relay restarts.
      const persisted = m?.session_id.startsWith("tok:") ? this.store.getToken(m.session_id.slice(4))?.last_used ?? null : null;
      return {
        role,
        status: m ? m.status : "absent",
        scope: m?.scope ?? null,
        last_seen: seen ? new Date(seen).toISOString() : persisted,
        live: m ? m.status !== "left" && this.isLive(m.session_id) : false,
      };
    });
  }

  private missingRoles(name: string): string[] {
    return this.roster(name)
      .filter((r) => r.status === "absent" || r.status === "left")
      .map((r) => r.role);
  }

  /** waiting -> active when everyone is here and a task exists; active -> complete when everyone is done. */
  private recomputeStatus(name: string): void {
    const ch = this.channel(name);
    if (ch.status === "closed") return;
    const roster = this.roster(name);
    const allPresent = roster.every((r) => r.status === "present" || r.status === "done");
    const allDone = roster.every((r) => r.status === "done");
    let next = ch.status;
    if (allPresent && allDone && ch.task) next = "complete";
    else if (allPresent && ch.task) next = "active";
    else next = "waiting";
    if (next !== ch.status) {
      this.store.setChannelStatus(name, next);
      if (next === "active") this.systemPost(name, "all roles present, channel is ACTIVE. Start work.");
      if (next === "complete") this.systemPost(name, "all roles reported DONE, channel is COMPLETE. Awaiting operator review.");
    }
  }

  private member(identity: string, channel: string): Member {
    this.channel(channel);
    const m = this.store.getMemberBySession(channel, identity);
    if (!m) throw new RelayError(`you have not joined channel "${channel}"; call join first`, "not_joined");
    return m;
  }

  // ------------------------------------------------------------------
  // agent side
  // ------------------------------------------------------------------

  /** Register this session as `role` and block until the channel is active (or timeout). */
  async join(identity: string, name: string, role: string, scope: string | null, timeoutMs?: number): Promise<JoinResult> {
    const ch = this.channel(name);
    if (!ch.roles.includes(role)) {
      throw new RelayError(`role "${role}" is not in channel roster [${ch.roles.join(", ")}]`, "bad_role");
    }
    if (ch.status === "closed") throw new RelayError(`channel "${name}" is closed`, "closed");
    const existing = this.store.getMember(name, role);
    if (existing && existing.status !== "left" && existing.session_id !== identity) {
      // Another agent holds this role. Allow takeover only if that agent is gone or stale.
      if (this.isLive(existing.session_id)) {
        throw new RelayError(`role "${role}" is already taken by a connected agent`, "role_taken");
      }
      this.systemPost(name, `${role} session went stale; role released`);
    }
    // Drop any other role this identity held in this channel.
    for (const m of this.store.listMembersBySession(identity)) {
      if (m.channel === name && m.role !== role) this.store.setMemberStatus(name, m.role, "left");
    }
    this.seen(identity);
    const alreadyHere = existing !== undefined && existing.session_id === identity && existing.status !== "left";
    if (alreadyHere) {
      // Agents call join repeatedly while waiting for the roster; that is a poll, not a new arrival.
      if (scope && scope !== existing.scope) {
        this.store.upsertMember({ channel: name, role, session_id: identity, scope, status: existing.status });
        this.systemPost(name, `${role} scope is now ${scope}`);
      }
    } else {
      const wasDone = existing?.status === "done";
      this.store.upsertMember({ channel: name, role, session_id: identity, scope, status: wasDone ? "done" : "present" });
      this.systemPost(name, `${role} joined${scope ? ` (scope: ${scope})` : ""}${existing ? " (rejoin)" : ""}`);
      this.recomputeStatus(name);
      this.touch();
    }

    const result = await this.waitUntil(() => {
      const c = this.channel(name);
      return c.status === "waiting" ? undefined : c;
    }, this.clampWait(timeoutMs));

    return this.joinResult(name, role, result?.status ?? "waiting");
  }

  private joinResult(name: string, role: string, status: JoinResult["status"]): JoinResult {
    const ch = this.channel(name);
    const missing = this.missingRoles(name);
    const hints: Record<JoinResult["status"], string> = {
      waiting: `Still waiting${missing.length ? ` for roles [${missing.join(", ")}]` : ""}${!ch.task ? " and for the operator to publish a task" : ""}. Call join again with the same arguments to keep waiting.`,
      active: `Channel is active. Read the task, then work. Call inbox before cross-boundary changes, ask for anything you need from another role, post INFO on material changes, wait when idle, done when finished.`,
      complete: `All roles are done. Call wait to stay reachable until the operator closes the channel.`,
      closed: `Channel is closed. No further coordination is possible.`,
    };
    const yourPending = ch.roles
      .filter((r) => r !== role)
      .flatMap((r) => this.store.pendingAsks(name, role, r))
      .map((m) => ({ id: m.id, to: m.to_role!, body: m.body }));
    return {
      status,
      channel: name,
      role,
      task: ch.task,
      roster: this.roster(name),
      missing,
      contract_path: ch.contract_path,
      your_pending_asks: yourPending,
      hint: yourPending.length
        ? `${hints[status]} You have ${yourPending.length} unanswered question(s) from before; call wait to receive the reply, or ask again if it is no longer relevant.`
        : hints[status],
    };
  }

  /** Role held by this identity in a channel (throws not_joined). */
  roleOf(identity: string, name: string): string {
    return this.member(identity, name).role;
  }

  who(name: string) {
    const ch = this.channel(name);
    return { channel: name, status: ch.status, roster: this.roster(name), missing: this.missingRoles(name) };
  }

  post(identity: string, name: string, type: Extract<MsgType, "INFO" | "HOLD">, body: string, replyTo?: number, toRole?: string): Message {
    const me = this.member(identity, name);
    this.assertOpen(name);
    if (!body.trim()) throw new RelayError("body is empty", "invalid_body");
    if (toRole) this.assertRole(name, toRole);
    if (replyTo !== undefined && !this.store.getMessage(replyTo)) throw new RelayError(`message ${replyTo} not found`, "no_message");
    const msg = this.store.insertMessage({
      channel: name,
      from_role: me.role,
      to_role: toRole ?? null,
      type,
      body,
      reply_to: replyTo ?? null,
    });
    this.touch();
    return msg;
  }

  /** Post an ASK to `toRole` and block until it is answered (or timeout). */
  async ask(identity: string, name: string, toRole: string, question: string, timeoutMs?: number): Promise<AskResult> {
    const me = this.member(identity, name);
    this.assertOpen(name);
    this.assertRole(name, toRole);
    if (toRole === me.role) throw new RelayError("cannot ask yourself", "self_ask");
    if (!question.trim()) throw new RelayError("question is empty", "invalid_body");
    const target = this.store.getMember(name, toRole);
    if (!target || target.status === "left") {
      throw new RelayError(`${toRole} is not connected right now; post INFO instead or wait for them to join`, "target_absent");
    }
    // Deadlock guard: if the target is already waiting on me, answer them first.
    const theirs = this.store.pendingAsks(name, toRole, me.role);
    if (theirs.length) {
      throw new RelayError(
        `${toRole} is already waiting on you (ask #${theirs[0].id}: "${theirs[0].body.slice(0, 120)}"). Reply to it before asking.`,
        "deadlock",
      );
    }
    const ask = this.store.insertMessage({
      channel: name,
      from_role: me.role,
      to_role: toRole,
      type: "ASK",
      body: question,
      reply_to: null,
    });
    this.touch();
    const reply = await this.waitUntil(() => this.store.findReply(ask.id), this.clampWait(timeoutMs));
    if (!reply) {
      return {
        status: "timeout",
        ask_id: ask.id,
        reply: null,
        hint: `No reply yet (ask #${ask.id}). Call wait: the answer arrives in your inbox as a REPLY with reply_to=${ask.id}. Also check whether ${toRole} asked you something in the meantime.`,
      };
    }
    // If the reply is the only thing unread, mark it read so inbox does not echo it back.
    const fresh = this.store.getMember(name, me.role)!;
    if (this.store.countVisibleMessages(name, me.role, fresh.last_read) === 1 && reply.id > fresh.last_read) {
      this.store.setLastRead(name, me.role, reply.id);
    }
    return { status: "answered", ask_id: ask.id, reply, hint: "Continue with this answer." };
  }

  reply(identity: string, askId: number, body: string): Message {
    const ask = this.store.getMessage(askId);
    if (!ask || ask.type !== "ASK") throw new RelayError(`ask ${askId} not found`, "no_message");
    const me = this.member(identity, ask.channel);
    this.assertOpen(ask.channel);
    if (ask.to_role !== me.role) throw new RelayError(`ask ${askId} was addressed to ${ask.to_role}, not ${me.role}`, "not_addressee");
    if (this.store.findReply(askId)) throw new RelayError(`ask ${askId} already answered`, "already_answered");
    if (!body.trim()) throw new RelayError("body is empty", "invalid_body");
    const msg = this.store.insertMessage({
      channel: ask.channel,
      from_role: me.role,
      to_role: ask.from_role,
      type: "REPLY",
      body,
      reply_to: askId,
    });
    this.touch();
    return msg;
  }

  inbox(identity: string, name: string, since?: number): InboxResult {
    const me = this.member(identity, name);
    const from = since ?? me.last_read;
    const messages = this.store.listVisibleMessages(name, me.role, from);
    const cursor = messages.length ? messages[messages.length - 1].id : from;
    this.store.setLastRead(name, me.role, cursor);
    const fresh = this.store.getMember(name, me.role)!;
    const unread = this.store.countVisibleMessages(name, me.role, fresh.last_read);
    return { messages, cursor, unread };
  }

  unread(identity: string, name: string): number {
    const me = this.store.getMemberBySession(name, identity);
    return me ? this.store.countVisibleMessages(name, me.role, me.last_read) : 0;
  }

  /** Block until something arrives for me or the channel closes. */
  async wait(identity: string, name: string, timeoutMs?: number): Promise<WaitResult> {
    const me = this.member(identity, name);
    const hit = await this.waitUntil(() => {
      const ch = this.channel(name);
      if (ch.status === "closed") return "closed" as const;
      const m = this.store.getMember(name, me.role)!;
      return this.store.countVisibleMessages(name, me.role, m.last_read) > 0 ? ("messages" as const) : undefined;
    }, this.clampWait(timeoutMs));
    const ch = this.channel(name);
    const inbox = this.inbox(identity, name);
    if (hit === "closed") {
      return { status: "closed", channel_status: ch.status, inbox, hint: "Channel closed by operator. You are finished here." };
    }
    if (hit === "messages") {
      const asks = inbox.messages.filter((m) => m.type === "ASK");
      const operator = inbox.messages.filter((m) => m.type === "OPERATOR");
      const parts: string[] = [];
      if (operator.length) parts.push(`${operator.length} OPERATOR message(s): these come from the human and override the task where they conflict. Follow them.`);
      if (asks.length) parts.push(`${asks.length} question(s) addressed to you: reply to each with reply(ask_id, body).`);
      if (!parts.length) parts.push("Read the messages, act if they affect your work.");
      parts.push("Then call wait again if idle.");
      return { status: "messages", channel_status: ch.status, inbox, hint: parts.join(" ") };
    }
    return { status: "timeout", channel_status: ch.status, inbox, hint: "Nothing new. Call wait again to stay reachable." };
  }

  /** Mark this role finished, then behave like `wait`. */
  async done(identity: string, name: string, summary: string, timeoutMs?: number): Promise<WaitResult & { channel_complete: boolean }> {
    const me = this.member(identity, name);
    this.assertOpen(name);
    if (!summary.trim()) throw new RelayError("summary is empty", "invalid_body");
    if (me.status !== "done") {
      this.store.setMemberStatus(name, me.role, "done");
      this.store.insertMessage({ channel: name, from_role: me.role, to_role: null, type: "DONE", body: summary, reply_to: null });
      this.recomputeStatus(name);
      this.touch();
    }
    const result = await this.wait(identity, name, timeoutMs);
    const ch = this.channel(name);
    return {
      ...result,
      channel_complete: ch.status === "complete" || ch.status === "closed",
      hint:
        ch.status === "complete"
          ? "Every role is done. Keep calling wait so you can still answer questions until the operator closes the channel."
          : result.hint,
    };
  }

  // ------------------------------------------------------------------
  // identity liveness (driven by the transport layers)
  // ------------------------------------------------------------------

  /** identity -> last request timestamp (ms) */
  private readonly lastSeen = new Map<string, number>();
  /** identity -> open MCP connection ids */
  private readonly connections = new Map<string, Set<string>>();

  /** An MCP session (connection) opened for this identity. */
  connectionOpened(identity: string, connId: string): void {
    if (!this.connections.has(identity)) this.connections.set(identity, new Set());
    this.connections.get(identity)!.add(connId);
    this.lastSeen.set(identity, Date.now());
  }

  /** Any request (MCP or REST) from this identity. */
  seen(identity: string): void {
    this.lastSeen.set(identity, Date.now());
    if (identity.startsWith("tok:")) {
      const t = this.store.getToken(identity.slice(4));
      if (t) this.store.touchToken(t.token);
    }
  }

  isLive(identity: string): boolean {
    const seen = this.lastSeen.get(identity);
    return seen !== undefined && Date.now() - seen < this.staleAfterMs;
  }

  /** An MCP connection closed (client sent DELETE). When it was the last one, the agent has left. */
  connectionClosed(identity: string, connId: string): void {
    const set = this.connections.get(identity);
    if (set) {
      set.delete(connId);
      if (set.size > 0) return;
      this.connections.delete(identity);
    }
    this.markLeft(identity);
  }

  private markLeft(identity: string): void {
    this.lastSeen.delete(identity);
    for (const m of this.store.listMembersBySession(identity)) {
      if (m.status === "present") {
        this.store.setMemberStatus(m.channel, m.role, "left");
        this.systemPost(m.channel, `${m.role} disconnected`);
        this.recomputeStatus(m.channel);
      }
    }
    this.touch();
  }

  // ------------------------------------------------------------------
  // tokens: durable agent identity bound to one channel + role
  // ------------------------------------------------------------------

  /** Create (or regenerate) the token for a role. Any previous token for that role is revoked. */
  createToken(name: string, role: string, label: string | null = null): Token {
    this.assertRole(name, role);
    for (const old of this.store.deleteTokensForRole(name, role)) this.markLeft(tokenIdentity(old));
    const token = `ac_${randomBytes(24).toString("base64url")}`;
    const t = this.store.insertToken({ token, channel: name, role, label });
    this.touch();
    return t;
  }

  listTokens(name: string): Token[] {
    this.channel(name);
    return this.store.listTokens(name);
  }

  revokeToken(token: string): boolean {
    const ok = this.store.deleteToken(token);
    if (ok) this.markLeft(tokenIdentity(token));
    return ok;
  }

  /** Resolve a bearer token to its binding, or undefined if unknown. */
  resolveToken(token: string): Token | undefined {
    return this.store.getToken(token);
  }

  // ------------------------------------------------------------------
  // contract storage (so remote agents can read/write without disk access)
  // ------------------------------------------------------------------

  /** Called after the relay itself writes a contract, so a file watcher can skip the echo. */
  onContractWrite: ((path: string, content: string) => void) | null = null;

  contractWrite(name: string, content: string, by: string): { path: string; summary: string } {
    const ch = this.channel(name);
    this.assertOpen(name);
    if (!ch.contract_path) throw new RelayError("channel has no contract path", "no_contract");
    const before = this.contract(name).content;
    if (before === content) return { path: ch.contract_path, summary: "unchanged" };
    mkdirSync(dirname(ch.contract_path), { recursive: true });
    writeFileSync(ch.contract_path, content);
    this.onContractWrite?.(ch.contract_path, content);
    const summary = summarize(before, content);
    this.systemPost(name, `contract ${before ? "updated" : "created"} by ${by}: ${ch.contract_path}
${summary}
Re-read the contract before touching anything that depends on it.`);
    return { path: ch.contract_path, summary };
  }

  // ------------------------------------------------------------------

  private assertOpen(name: string): void {
    if (this.channel(name).status === "closed") throw new RelayError(`channel "${name}" is closed`, "closed");
  }

  private assertRole(name: string, role: string): void {
    const ch = this.channel(name);
    if (!ch.roles.includes(role)) throw new RelayError(`role "${role}" is not in channel roster [${ch.roles.join(", ")}]`, "bad_role");
  }
}
