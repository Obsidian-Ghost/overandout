import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serve, type RunningServer } from "../src/server.ts";

/** Public-mode relay: admin token for operators, agent tokens for agents. */
let running: RunningServer;
let tmp: string;
const ADMIN = "ra_test_admin_token";

const api = async (method: string, path: string, body?: unknown, token: string | null = ADMIN) => {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${running.url}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};

/** Agent REST helper bound to one agent token. */
const rest = (token: string) => ({
  get: (path: string) => api("GET", path, undefined, token),
  post: (path: string, body: unknown = {}) => api("POST", path, body, token),
  put: (path: string, body: unknown) => api("PUT", path, body, token),
});

const mcpAgent = async (name: string, token?: string) => {
  const client = new Client({ name, version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined);
  await client.connect(transport);
  const call = async (tool: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    if (res.isError) return { error: text };
    const end = text.lastIndexOf("\n}") + 2;
    return { ...JSON.parse(text.slice(0, end)), _footer: text.slice(end).trim() };
  };
  return { client, transport, call };
};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "relay-remote-"));
  running = await serve({
    port: 0,
    dbPath: join(tmp, "relay.db"),
    contractsDir: join(tmp, "contracts"),
    maxWaitMs: 2_000,
    staleAfterMs: 600,
    public: true,
    adminToken: ADMIN,
  });
});

after(async () => {
  await running.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("public mode: operator API needs the admin token, health and dashboard stay open", async () => {
  assert.equal(running.public, true);
  assert.equal(running.adminToken, ADMIN);
  const health = await api("GET", "/api/health", undefined, null);
  assert.equal(health.status, 200);
  assert.equal(health.data.auth, "token");
  const page = await fetch(`${running.url}/`);
  assert.equal(page.status, 200);

  assert.equal((await api("GET", "/api/channels", undefined, null)).status, 401);
  assert.equal((await api("GET", "/api/channels", undefined, "wrong")).status, 401);
  assert.equal((await api("GET", "/api/channels")).status, 200);
  // SSE accepts ?token= because EventSource cannot set headers.
  const ac = new AbortController();
  const sse = await fetch(`${running.url}/api/events?token=${ADMIN}`, { signal: ac.signal });
  assert.equal(sse.status, 200);
  ac.abort();
});

test("public mode: anonymous MCP sessions are rejected, token sessions are bound to channel+role", async () => {
  const created = await api("POST", "/api/channels", { name: "remote", roles: ["DEV", "OPS"] });
  assert.equal(created.status, 201);

  // Anonymous initialize -> 401 (the SDK surfaces it as a connect error).
  await assert.rejects(mcpAgent("anon"), /requires an agent token/);

  const devTok = (await api("POST", "/api/channels/remote/tokens", { role: "DEV", label: "vaishnav" })).data;
  const opsTok = (await api("POST", "/api/channels/remote/tokens", { role: "OPS", label: "friend" })).data;
  assert.match(devTok.token, /^ac_/);
  assert.equal(devTok.role, "DEV");
  const listed = await api("GET", "/api/channels/remote/tokens");
  assert.deepEqual(listed.data.map((t: any) => t.role).sort(), ["DEV", "OPS"]);

  const dev = await mcpAgent("dev", devTok.token);
  // Token-bound: channel/role may be omitted, and a mismatch is refused.
  const mismatch = await dev.call("join", { channel: "other", timeout_seconds: 0 });
  assert.match(mismatch.error, /token_bound/);
  const j = await dev.call("join", { scope: "services/api/**", timeout_seconds: 0 });
  assert.equal(j.status, "waiting");
  assert.equal(j.role, "DEV");
  assert.deepEqual(j.missing, ["OPS"]);
  const who = await dev.call("who", {});
  const devEntry = who.roster.find((r: any) => r.role === "DEV");
  assert.equal(devEntry.status, "present");
  assert.equal(devEntry.live, true);
  assert.ok(devEntry.last_seen);

  // OPS joins over REST with its token (no MCP at all), the operator publishes, both become active.
  const ops = rest(opsTok.token);
  const me = await ops.get("/agent/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.token.role, "OPS");
  assert.equal(me.data.joined, false);
  const opsJoin = ops.post("/agent/join", { scope: "infra/**", timeout_seconds: 5 });
  await new Promise((r) => setTimeout(r, 50));
  await api("POST", "/api/channels/remote/publish", { task: "Ship the API behind the gateway." });
  const opsJoined = await opsJoin;
  assert.equal(opsJoined.status, 200);
  assert.equal(opsJoined.data.ok, true);
  assert.equal(opsJoined.data.result.status, "active");

  // Cross-transport ask/reply: MCP DEV asks, REST OPS answers.
  const drained = await ops.get("/agent/inbox");
  assert.ok(drained.data.result.messages.some((m: any) => m.type === "SYSTEM"));
  assert.equal(drained.data.unread, 0);
  const askP = dev.call("ask", { to_role: "OPS", question: "Which port should the API listen on?" });
  const waited = await ops.post("/agent/wait", { timeout_seconds: 5 });
  const ask = waited.data.result.inbox.messages.find((m: any) => m.type === "ASK");
  assert.ok(ask, "OPS should receive the ASK over REST");
  const rep = await ops.post("/agent/reply", { ask_id: ask.id, body: "8080, behind /api prefix" });
  assert.equal(rep.data.ok, true);
  const answered = await askP;
  assert.equal(answered.status, "answered");
  assert.equal(answered.reply.body, "8080, behind /api prefix");

  // REST validation and the unread footer.
  const bad = await ops.post("/agent/post", { type: "NOPE", body: "x" });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "invalid_type");
  await ops.post("/agent/post", { type: "INFO", body: "gateway route added: /api -> api:8080" });
  const devWho = await dev.call("who", {});
  assert.match(devWho._footer, /unread: \d+ message/);
  const inbox = await dev.call("inbox", {});
  assert.equal(inbox.messages.filter((m: any) => m.type === "INFO").length, 1);

  // Contract via tools: DEV writes, OPS reads over REST, watcher does not double-announce.
  const written = await dev.call("contract_set", { content: "openapi: 3.1.0\npaths:\n  /api/health:\n    get: {}\n" });
  assert.match(written.summary, /\+4 -0/);
  assert.ok(existsSync(join(tmp, "contracts", "remote.openapi.yaml")));
  const opsContract = await ops.get("/agent/contract");
  assert.equal(opsContract.data.result.exists, true);
  assert.match(opsContract.data.result.content, /\/api\/health/);
  await new Promise((r) => setTimeout(r, 500)); // let any fs event settle
  const announcements = running.relay.messages("remote").filter((m) => m.type === "SYSTEM" && /^contract (created|updated)/.test(m.body));
  assert.equal(announcements.length, 1, "contract_set should be announced exactly once");
  assert.match(announcements[0].body, /by DEV/);

  // Unauthenticated / wrong-token agent calls fail.
  assert.equal((await api("GET", "/agent/me", undefined, null)).status, 401);
  assert.equal((await api("GET", "/agent/me", undefined, "ac_bogus")).status, 401);

  // Regenerating a role's token revokes the old one: old DEV session is marked left.
  const devTok2 = (await api("POST", "/api/channels/remote/tokens", { role: "DEV" })).data;
  assert.notEqual(devTok2.token, devTok.token);
  assert.equal((await api("GET", "/agent/me", undefined, devTok.token)).status, 401);
  const after = running.relay.who("remote").roster.find((r) => r.role === "DEV")!;
  assert.equal(after.status, "left");
  const dev2 = rest(devTok2.token);
  const rejoin = await dev2.post("/agent/join", { timeout_seconds: 0 });
  assert.equal(rejoin.data.result.status, "active");
  assert.ok(rejoin.data.result.your_pending_asks.length === 0);

  // Revoke explicitly.
  const revoked = await api("DELETE", `/api/channels/remote/tokens/${devTok2.token}`);
  assert.equal(revoked.data.ok, true);
  assert.equal((await dev2.get("/agent/me")).status, 401);
  assert.equal((await api("DELETE", `/api/channels/remote/tokens/${devTok2.token}`)).status, 404);

  await dev.client.close();
});

test("delete channel removes everything attached to it", async () => {
  await api("POST", "/api/channels", { name: "gone", roles: ["A"] });
  const tok = (await api("POST", "/api/channels/gone/tokens", { role: "A" })).data;
  await rest(tok.token).post("/agent/join", { timeout_seconds: 0 });
  await api("POST", "/api/channels/gone/publish", { task: "x" });
  assert.ok((await api("GET", "/api/channels/gone")).data.message_count > 0);

  const del = await api("DELETE", "/api/channels/gone");
  assert.equal(del.status, 200);
  assert.equal((await api("GET", "/api/channels/gone")).status, 400);
  assert.equal((await api("GET", "/agent/me", undefined, tok.token)).status, 401, "tokens die with the channel");
  assert.equal((await api("DELETE", "/api/channels/gone")).status, 400);
  assert.ok(!(await api("GET", "/api/channels")).data.some((c: any) => c.name === "gone"));
});

test("admin token is persisted next to the database when not supplied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-admin-"));
  const a = await serve({ port: 0, dbPath: join(dir, "relay.db"), contractsDir: join(dir, "c"), public: true, watchContracts: false });
  assert.match(a.adminToken!, /^ra_/);
  assert.equal(readFileSync(join(dir, "admin.token"), "utf8").trim(), a.adminToken);
  await a.close();
  const b = await serve({ port: 0, dbPath: join(dir, "relay.db"), contractsDir: join(dir, "c"), public: true, watchContracts: false });
  assert.equal(b.adminToken, a.adminToken, "same token across restarts");
  await b.close();
  rmSync(dir, { recursive: true, force: true });
});

test("deleting a channel under a blocked waiter fails that waiter only; the relay keeps working", async () => {
  await api("POST", "/api/channels", { name: "doomed", roles: ["A", "B"] });
  const tok = (await api("POST", "/api/channels/doomed/tokens", { role: "A" })).data;
  const a = rest(tok.token);
  await a.post("/agent/join", { timeout_seconds: 0 });
  await a.get("/agent/inbox");
  const waiter = a.post("/agent/wait", { timeout_seconds: 5 }); // blocks: nothing to read
  await new Promise((r) => setTimeout(r, 50));

  const del = await api("DELETE", "/api/channels/doomed");
  assert.equal(del.status, 200);
  const w = await waiter;
  assert.equal(w.status, 400, "the orphaned waiter gets a clean error, not a hang or a 500");
  assert.equal(w.data.code, "no_channel");

  // Mutations after the deletion must still succeed (this used to throw inside the emitter).
  const next = await api("POST", "/api/channels", { name: "alive", roles: ["A"] });
  assert.equal(next.status, 201);
  const t2 = await api("POST", "/api/channels/alive/tokens", { role: "A" });
  assert.equal(t2.status, 201);
  assert.equal((await api("POST", "/api/channels/alive/publish", { task: "ok" })).status, 200);
});
