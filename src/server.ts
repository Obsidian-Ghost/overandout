import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Relay, RelayError, tokenIdentity } from "./relay.ts";
import { McpEndpoint, bearerOf } from "./mcp.ts";
import { Store, type Token } from "./store.ts";
import { ContractWatcher } from "./contract.ts";
import { agentOpenApi, inviteText } from "./invite.ts";
import { VERSION } from "./version.ts";

export { VERSION } from "./version.ts";

export interface ServeOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  contractsDir?: string;
  maxWaitMs?: number;
  staleAfterMs?: number;
  watchContracts?: boolean;
  /**
   * Public mode: every operator call needs the admin token and every agent needs an agent token.
   * Turn this on whenever the relay is reachable from outside localhost (0.0.0.0 bind, tunnel, VPS).
   */
  public?: boolean;
  /** Operator token for public mode. Auto-generated (and persisted next to the DB) when omitted. */
  adminToken?: string;
}

export interface RunningServer {
  relay: Relay;
  server: Server;
  url: string;
  mcpUrl: string;
  public: boolean;
  adminToken: string | null;
  close: () => Promise<void>;
}

// ----------------------------------------------------------------------------
// tiny router
// ----------------------------------------------------------------------------

type Auth = "none" | "admin" | "agent";
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  body: () => Promise<any>;
  token?: Token;
  identity?: string;
}
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
interface Route {
  method: string;
  pattern: RegExp;
  auth: Auth;
  handler: Handler;
}
/** Return this from a handler that has already written the response. */
const RAW = Symbol("raw");
/** Return this to send a specific status code. */
const reply = (status: number, json: unknown) => ({ [STATUS]: status, json });
const STATUS = Symbol("status");

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  return JSON.parse(text);
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function loadAdminToken(opts: ServeOptions): string {
  if (opts.adminToken) return opts.adminToken;
  if (process.env.OVERANDOUT_ADMIN_TOKEN) return process.env.OVERANDOUT_ADMIN_TOKEN;
  const dbPath = opts.dbPath ?? ".overandout/overandout.db";
  if (dbPath === ":memory:") return `ra_${randomBytes(24).toString("base64url")}`;
  const file = join(dirname(dbPath), "admin.token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = `ra_${randomBytes(24).toString("base64url")}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}

const secs = (s: unknown) => (typeof s === "number" ? s * 1000 : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length ? v : undefined);

// ----------------------------------------------------------------------------

export async function serve(opts: ServeOptions = {}): Promise<RunningServer> {
  const isPublic = opts.public === true;
  const adminToken = isPublic ? loadAdminToken(opts) : opts.adminToken ?? process.env.OVERANDOUT_ADMIN_TOKEN ?? null;

  const store = new Store(opts.dbPath ?? ".overandout/overandout.db");
  const relay = new Relay(store, { maxWaitMs: opts.maxWaitMs, staleAfterMs: opts.staleAfterMs, contractsDir: opts.contractsDir });
  const mcp = new McpEndpoint(relay, { required: isPublic });
  const watcher = opts.watchContracts === false ? null : new ContractWatcher(relay);
  if (watcher) {
    watcher.start();
    relay.onContractWrite = (path, content) => watcher.prime(path, content);
  }

  const dashboardHtml = readFileSync(new URL("./ui.html", import.meta.url), "utf8");
  const sseClients = new Set<ServerResponse>();

  const adminOk = (req: IncomingMessage) => {
    if (!isPublic) return true;
    return bearerOf(req) === adminToken;
  };

  /** Build the standard agent response: result + unread count for the agent's channel. */
  const agentResult = (ctx: Ctx, result: unknown) => ({
    ok: true,
    result,
    unread: relay.unread(ctx.identity!, ctx.token!.channel),
  });

  /** Base URL as the caller sees it (tunnel/proxy aware), for links inside self-description. */
  const publicBase = (req: IncomingMessage) => {
    const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] || "http";
    const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0] || req.headers.host || "127.0.0.1";
    return `${proto}://${host}`;
  };

  const routes: Route[] = [
    // ---- self-description for agents (the token in the path is the credential) ----
    { method: "GET", pattern: /^\/i\/([^/]+)$/, auth: "none", handler: ({ req, res, params }) => {
      const t = relay.resolveToken(params[0]);
      if (!t) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("unknown or revoked invite token\n");
        return RAW;
      }
      relay.seen(tokenIdentity(t.token));
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(inviteText(publicBase(req), t));
      return RAW;
    } },
    { method: "GET", pattern: /^\/agent\/help$/, auth: "agent", handler: (ctx) => {
      ctx.res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      ctx.res.end(inviteText(publicBase(ctx.req), ctx.token!));
      return RAW;
    } },
    { method: "GET", pattern: /^\/agent\/openapi\.json$/, auth: "none", handler: ({ req }) => agentOpenApi(publicBase(req)) },

    // ---- static / meta ----
    { method: "GET", pattern: /^\/(?:index\.html)?$/, auth: "none", handler: ({ res }) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(dashboardHtml);
      return RAW;
    } },
    { method: "GET", pattern: /^\/api\/health$/, auth: "none", handler: () => ({
      ok: true,
      version: VERSION,
      auth: isPublic ? "token" : "open",
      sessions: mcp.sessionCount(),
      channels: relay.listChannels().length,
    }) },

    // ---- MCP ----
    { method: "*", pattern: /^\/mcp$/, auth: "none", handler: async ({ req, res }) => {
      const body = req.method === "POST" ? await readJson(req) : undefined;
      await mcp.handle(req, res, body);
      return RAW;
    } },

    // ---- operator: live events ----
    { method: "GET", pattern: /^\/api\/events$/, auth: "admin", handler: ({ req, res }) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("event: change\ndata: {}\n\n");
      sseClients.add(res);
      let timer: NodeJS.Timeout | null = null;
      const off = relay.onChange(() => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          res.write("event: change\ndata: {}\n\n");
        }, 50);
      });
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        off();
        clearInterval(keepAlive);
        if (timer) clearTimeout(timer);
        sseClients.delete(res);
      });
      return RAW;
    } },

    // ---- operator: channels ----
    { method: "GET", pattern: /^\/api\/channels$/, auth: "admin", handler: () => relay.listChannels().map((c) => relay.status(c.name)) },
    { method: "POST", pattern: /^\/api\/channels$/, auth: "admin", handler: async ({ body }) => {
      const b = (await body()) as { name?: string; roles?: string[] } | undefined;
      if (!b?.name || !Array.isArray(b.roles)) return reply(400, { error: "expected { name, roles: [] }" });
      return reply(201, relay.createChannel(b.name, b.roles));
    } },
    { method: "GET", pattern: /^\/api\/channels\/([^/]+)$/, auth: "admin", handler: ({ params }) => relay.status(params[0]) },
    { method: "DELETE", pattern: /^\/api\/channels\/([^/]+)$/, auth: "admin", handler: ({ params }) => {
      relay.deleteChannel(params[0]);
      return { ok: true, deleted: params[0] };
    } },
    { method: "POST", pattern: /^\/api\/channels\/([^/]+)\/publish$/, auth: "admin", handler: async ({ params, body }) => {
      const b = (await body()) as { task?: string } | undefined;
      if (!b?.task) return reply(400, { error: "expected { task }" });
      return relay.publish(params[0], b.task);
    } },
    { method: "POST", pattern: /^\/api\/channels\/([^/]+)\/close$/, auth: "admin", handler: ({ params }) => relay.closeChannel(params[0]) },
    { method: "GET", pattern: /^\/api\/channels\/([^/]+)\/contract$/, auth: "admin", handler: ({ params }) => relay.contract(params[0]) },
    { method: "PUT", pattern: /^\/api\/channels\/([^/]+)\/contract$/, auth: "admin", handler: async ({ params, body }) => {
      const b = (await body()) as { content?: string } | undefined;
      if (typeof b?.content !== "string") return reply(400, { error: "expected { content }" });
      return relay.contractWrite(params[0], b.content, "operator");
    } },
    { method: "POST", pattern: /^\/api\/channels\/([^/]+)\/post$/, auth: "admin", handler: async ({ params, body }) => {
      const b = (await body()) as { body?: string; to_role?: string } | undefined;
      if (!b?.body) return reply(400, { error: "expected { body, to_role? }" });
      return relay.operatorPost(params[0], b.body, b.to_role || undefined);
    } },
    { method: "POST", pattern: /^\/api\/channels\/([^/]+)\/reply$/, auth: "admin", handler: async ({ params, body }) => {
      const b = (await body()) as { ask_id?: number; body?: string } | undefined;
      if (typeof b?.ask_id !== "number" || !b.body) return reply(400, { error: "expected { ask_id, body }" });
      const ask = relay.store.getMessage(b.ask_id);
      if (!ask || ask.channel !== params[0]) return reply(404, { error: `ask ${b.ask_id} not found in "${params[0]}"` });
      return relay.operatorReply(b.ask_id, b.body);
    } },
    { method: "GET", pattern: /^\/api\/channels\/([^/]+)\/messages$/, auth: "admin", handler: async ({ params, url }) => {
      const name = params[0];
      const since = Number(url.searchParams.get("since") ?? 0);
      const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 5000);
      const wait = url.searchParams.get("wait");
      relay.channel(name);
      if (wait) {
        const found = await relay.waitUntil(() => {
          const msgs = relay.messages(name, since, limit);
          return msgs.length ? msgs : undefined;
        }, Math.min(Number(wait) * 1000 || relay.maxWaitMs, relay.maxWaitMs));
        return found ?? [];
      }
      return relay.messages(name, since, limit);
    } },

    // ---- operator: agent tokens ----
    { method: "GET", pattern: /^\/api\/channels\/([^/]+)\/tokens$/, auth: "admin", handler: ({ params }) => relay.listTokens(params[0]) },
    { method: "POST", pattern: /^\/api\/channels\/([^/]+)\/tokens$/, auth: "admin", handler: async ({ params, body }) => {
      const b = (await body()) as { role?: string; label?: string } | undefined;
      if (!b?.role) return reply(400, { error: "expected { role, label? }" });
      return reply(201, relay.createToken(params[0], b.role, b.label ?? null));
    } },
    { method: "DELETE", pattern: /^\/api\/channels\/([^/]+)\/tokens\/([^/]+)$/, auth: "admin", handler: ({ params }) => {
      const t = relay.resolveToken(params[1]);
      if (!t || t.channel !== params[0]) return reply(404, { error: "token not found" });
      relay.revokeToken(params[1]);
      return { ok: true, revoked: params[1] };
    } },

    // ---- agent REST API (token identity; same semantics as the MCP tools) ----
    { method: "GET", pattern: /^\/agent\/me$/, auth: "agent", handler: (ctx) => {
      const t = ctx.token!;
      let role: string | null = null;
      try {
        role = relay.roleOf(ctx.identity!, t.channel);
      } catch {
        role = null;
      }
      return {
        ok: true,
        token: { channel: t.channel, role: t.role, label: t.label },
        joined: role !== null,
        channel: relay.status(t.channel),
        unread: relay.unread(ctx.identity!, t.channel),
      };
    } },
    { method: "POST", pattern: /^\/agent\/join$/, auth: "agent", handler: async (ctx) => {
      const b = ((await ctx.body()) ?? {}) as Record<string, unknown>;
      return agentResult(ctx, await relay.join(ctx.identity!, ctx.token!.channel, ctx.token!.role, str(b.scope) ?? null, secs(b.timeout_seconds)));
    } },
    { method: "GET", pattern: /^\/agent\/who$/, auth: "agent", handler: (ctx) => agentResult(ctx, relay.who(ctx.token!.channel)) },
    { method: "POST", pattern: /^\/agent\/post$/, auth: "agent", handler: async (ctx) => {
      const b = ((await ctx.body()) ?? {}) as Record<string, unknown>;
      if (b.type !== "INFO" && b.type !== "HOLD") return reply(400, { ok: false, error: "type must be INFO or HOLD", code: "invalid_type" });
      if (!str(b.body)) return reply(400, { ok: false, error: "body is required", code: "invalid_body" });
      return agentResult(ctx, relay.post(ctx.identity!, ctx.token!.channel, b.type, b.body as string, typeof b.reply_to === "number" ? b.reply_to : undefined, str(b.to_role)));
    } },
    { method: "POST", pattern: /^\/agent\/ask$/, auth: "agent", handler: async (ctx) => {
      const b = ((await ctx.body()) ?? {}) as Record<string, unknown>;
      if (!str(b.to_role) || !str(b.question)) return reply(400, { ok: false, error: "to_role and question are required", code: "invalid_body" });
      return agentResult(ctx, await relay.ask(ctx.identity!, ctx.token!.channel, b.to_role as string, b.question as string, secs(b.timeout_seconds)));
    } },
    { method: "POST", pattern: /^\/agent\/reply$/, auth: "agent", handler: async (ctx) => {
      const b = ((await ctx.body()) ?? {}) as Record<string, unknown>;
      if (typeof b.ask_id !== "number" || !str(b.body)) return reply(400, { ok: false, error: "ask_id and body are required", code: "invalid_body" });
      return agentResult(ctx, relay.reply(ctx.identity!, b.ask_id, b.body as string));
    } },
    { method: "*", pattern: /^\/agent\/inbox$/, auth: "agent", handler: async (ctx) => {
      const b = ctx.req.method === "POST" ? (((await ctx.body()) ?? {}) as Record<string, unknown>) : {};
      const sinceRaw = typeof b.since === "number" ? b.since : ctx.url.searchParams.get("since");
      const since = sinceRaw === null || sinceRaw === undefined ? undefined : Number(sinceRaw);
      return agentResult(ctx, relay.inbox(ctx.identity!, ctx.token!.channel, since));
    } },
    { method: "POST", pattern: /^\/agent\/wait$/, auth: "agent", handler: async (ctx) => {
      const b = ((await ctx.body()) ?? {}) as Record<string, unknown>;
      return agentResult(ctx, await relay.wait(ctx.identity!, ctx.token!.channel, secs(b.timeout_seconds)));
    } },
    { method: "POST", pattern: /^\/agent\/done$/, auth: "agent", handler: async (ctx) => {
      const b = ((await ctx.body()) ?? {}) as Record<string, unknown>;
      if (!str(b.summary)) return reply(400, { ok: false, error: "summary is required", code: "invalid_body" });
      return agentResult(ctx, await relay.done(ctx.identity!, ctx.token!.channel, b.summary as string, secs(b.timeout_seconds)));
    } },
    { method: "GET", pattern: /^\/agent\/contract$/, auth: "agent", handler: (ctx) => agentResult(ctx, relay.contract(ctx.token!.channel)) },
    { method: "PUT", pattern: /^\/agent\/contract$/, auth: "agent", handler: async (ctx) => {
      const b = ((await ctx.body()) ?? {}) as Record<string, unknown>;
      if (typeof b.content !== "string") return reply(400, { ok: false, error: "content is required", code: "invalid_body" });
      const ch = ctx.token!.channel;
      return agentResult(ctx, relay.contractWrite(ch, b.content, relay.roleOf(ctx.identity!, ch)));
    } },
  ];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (process.env.OVERANDOUT_DEBUG) console.error(`[req] ${method} ${url.pathname}${url.search} auth=${req.headers.authorization ? "yes" : "no"}`);
    const route = routes.find((r) => (r.method === "*" || r.method === method) && r.pattern.test(url.pathname));
    if (!route) {
      const anyMethod = routes.find((r) => r.pattern.test(url.pathname));
      return send(res, anyMethod ? 405 : 404, { error: anyMethod ? "method not allowed" : "not found" });
    }
    const params = [...(url.pathname.match(route.pattern) ?? [])].slice(1).map((p) => decodeURIComponent(p));
    const ctx: Ctx = { req, res, url, params, body: () => readJson(req) };
    try {
      if (route.auth === "admin" && !adminOk(req)) {
        if (process.env.OVERANDOUT_DEBUG) console.error(`[401] ${method} ${url.pathname} auth=${JSON.stringify(req.headers.authorization ?? null)} token=${url.searchParams.get("token")}`);
        return send(res, 401, { error: "admin token required" });
      }
      if (route.auth === "agent") {
        const bearer = bearerOf(req);
        const token = bearer ? relay.resolveToken(bearer) : undefined;
        if (!token) return send(res, 401, { ok: false, error: "valid agent token required (Authorization: Bearer ac_...)", code: "unauthorized" });
        ctx.token = token;
        ctx.identity = tokenIdentity(token.token);
        relay.seen(ctx.identity);
      }
      const out = await route.handler(ctx);
      if (out === RAW) return;
      if (out && typeof out === "object" && STATUS in (out as object)) {
        const o = out as { [STATUS]: number; json: unknown };
        return send(res, o[STATUS], o.json);
      }
      send(res, 200, out);
    } catch (err) {
      if (err instanceof RelayError) return send(res, 400, { ok: false, error: err.message, code: err.code });
      if (err instanceof SyntaxError) return send(res, 400, { ok: false, error: "invalid JSON", code: "invalid_json" });
      console.error(err);
      if (!res.headersSent) send(res, 500, { ok: false, error: "internal error", code: "internal" });
    }
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(opts.port ?? 7777, host, resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`;

  return {
    relay,
    server,
    url,
    mcpUrl: `${url}/mcp`,
    public: isPublic,
    adminToken,
    close: async () => {
      watcher?.stop();
      for (const c of sseClients) c.end();
      sseClients.clear();
      await mcp.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
