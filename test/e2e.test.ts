import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serve, type RunningServer } from "../src/server.ts";

let running: RunningServer;
let tmp: string;

const agent = async (name: string) => {
  const client = new Client({ name, version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl));
  await client.connect(transport);
  const call = async (tool: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    if (res.isError) return { error: text };
    // Tool output is JSON followed by an optional "unread:" footer.
    const end = text.lastIndexOf("\n}") + 2;
    const json = text.startsWith("{") ? text.slice(0, end) : text;
    return { ...JSON.parse(json), _footer: text.slice(end).trim() };
  };
  return { client, transport, call };
};

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${running.url}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as any };
};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "relay-"));
  running = await serve({
    port: 0,
    dbPath: ":memory:",
    contractsDir: join(tmp, "contracts"),
    maxWaitMs: 2_000,
    staleAfterMs: 600,
  });
});

after(async () => {
  await running.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("operator can create and list channels; bad input is rejected", async () => {
  const created = await api("POST", "/api/channels", { name: "auth", roles: ["FE", "BE"] });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, "waiting");
  assert.deepEqual(created.data.roles, ["FE", "BE"]);

  const dup = await api("POST", "/api/channels", { name: "auth", roles: ["FE"] });
  assert.equal(dup.status, 400);
  assert.equal(dup.data.code, "exists");

  const bad = await api("POST", "/api/channels", { name: "bad name!", roles: ["FE"] });
  assert.equal(bad.status, 400);

  const list = await api("GET", "/api/channels");
  assert.equal(list.data.length, 1);
  assert.deepEqual(list.data[0].missing, ["FE", "BE"]);
});

test("full FE/BE flow: join blocks until active, ask/reply, done -> complete, close", async () => {
  const fe = await agent("fe-agent");
  const be = await agent("be-agent");

  // Both tools are exposed.
  const tools = (await fe.client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["ask", "contract_get", "contract_set", "done", "inbox", "join", "post", "reply", "wait", "who"]);

  // Wrong role is refused.
  const badRole = await fe.call("join", { channel: "auth", role: "QA" });
  assert.match(badRole.error, /bad_role/);

  // FE joins; nobody else is here and no task, so join returns "waiting" after the (short) cap.
  const feWait = await fe.call("join", { channel: "auth", role: "FE", scope: "apps/web/**", timeout_seconds: 1 });
  assert.equal(feWait.status, "waiting");
  assert.deepEqual(feWait.missing, ["BE"]);

  // BE joins and keeps blocking; meanwhile FE re-joins (long-poll loop) and the operator publishes.
  const bePromise = be.call("join", { channel: "auth", role: "BE", scope: "apps/api/**" });
  const fePromise = fe.call("join", { channel: "auth", role: "FE", scope: "apps/web/**" });
  await new Promise((r) => setTimeout(r, 100));

  let status = await api("GET", "/api/channels/auth");
  assert.equal(status.data.status, "waiting"); // roster full, but no task yet
  assert.deepEqual(status.data.missing, []);

  const published = await api("POST", "/api/channels/auth/publish", { task: "Build login: BE exposes POST /auth/login, FE builds the page." });
  assert.equal(published.data.status, "active");

  const [beJoin, feJoin] = await Promise.all([bePromise, fePromise]);
  assert.equal(beJoin.status, "active");
  assert.equal(feJoin.status, "active");
  assert.match(feJoin.task, /POST \/auth\/login/);
  assert.equal(feJoin.contract_path, join(tmp, "contracts") + "/auth.openapi.yaml");
  assert.deepEqual(
    feJoin.roster.map((r: any) => [r.role, r.status]),
    [
      ["FE", "present"],
      ["BE", "present"],
    ],
  );

  // BE posts INFO; FE sees it in inbox with unread footer on the next call.
  const info = await be.call("post", { channel: "auth", type: "INFO", body: "contract drafted at contracts/auth.openapi.yaml" });
  assert.equal(info.type, "INFO");
  const who = await fe.call("who", { channel: "auth" });
  assert.match(who._footer, /unread: \d+ message/);

  const feInbox = await fe.call("inbox", { channel: "auth" });
  const infoMsgs = feInbox.messages.filter((m: any) => m.type === "INFO");
  assert.equal(infoMsgs.length, 1);
  assert.equal(infoMsgs[0].from_role, "BE");
  assert.equal(feInbox.unread, 0);
  // Own messages never come back to the author.
  const beInbox = await be.call("inbox", { channel: "auth" });
  assert.equal(beInbox.messages.filter((m: any) => m.type === "INFO").length, 0);

  // FE asks BE (blocking). BE picks it up via wait, replies. FE's ask resolves.
  const askPromise = fe.call("ask", { channel: "auth", to_role: "BE", question: "Is the token a JWT or opaque?" });
  const beWait = await be.call("wait", { channel: "auth" });
  assert.equal(beWait.status, "messages");
  const ask = beWait.inbox.messages.find((m: any) => m.type === "ASK");
  assert.ok(ask, "BE should see the ASK");
  assert.equal(ask.to_role, "BE");
  assert.match(beWait.hint, /1 question/);

  // Deadlock guard: BE may not ask FE while FE is waiting on BE.
  const deadlock = await be.call("ask", { channel: "auth", to_role: "FE", question: "what colour is the button?" });
  assert.match(deadlock.error, /deadlock/);

  // Wrong addressee cannot reply.
  const wrongReply = await fe.call("reply", { ask_id: ask.id, body: "nope" });
  assert.match(wrongReply.error, /not_addressee/);

  const reply = await be.call("reply", { ask_id: ask.id, body: "JWT, 15 minute expiry, in `token` field." });
  assert.equal(reply.reply_to, ask.id);
  const answered = await askPromise;
  assert.equal(answered.status, "answered");
  assert.equal(answered.reply.body, "JWT, 15 minute expiry, in `token` field.");

  // Double reply is refused.
  const again = await be.call("reply", { ask_id: ask.id, body: "again" });
  assert.match(again.error, /already_answered/);

  // The reply was consumed by ask, so FE's inbox is clean.
  const feInbox2 = await fe.call("inbox", { channel: "auth" });
  assert.equal(feInbox2.messages.length, 0);

  // Ask timeout returns a resumable hint, then reply lands in inbox via wait.
  const slow = await fe.call("ask", { channel: "auth", to_role: "BE", question: "Error body shape?", timeout_seconds: 0 });
  assert.equal(slow.status, "timeout");
  assert.match(slow.hint, /reply_to=\d+/);
  const beWait2 = await be.call("wait", { channel: "auth" });
  const ask2 = beWait2.inbox.messages.find((m: any) => m.type === "ASK" && m.id === slow.ask_id);
  assert.ok(ask2);
  await be.call("reply", { ask_id: ask2.id, body: "{ error: { code, message } }" });
  const feWait2 = await fe.call("wait", { channel: "auth" });
  assert.equal(feWait2.status, "messages");
  const gotReply = feWait2.inbox.messages.find((m: any) => m.type === "REPLY" && m.reply_to === slow.ask_id);
  assert.ok(gotReply);

  // Contract file change is announced to the channel.
  const contractPath = join(tmp, "contracts", "auth.openapi.yaml");
  writeFileSync(contractPath, "openapi: 3.1.0\npaths:\n  /auth/login:\n    post: {}\n");
  const contractMsg = await running.relay.waitUntil(
    () => running.relay.messages("auth").find((m) => m.type === "SYSTEM" && m.body.includes("contract created")),
    3_000,
  );
  assert.ok(contractMsg, "contract watcher should post on new contract file");
  assert.match(contractMsg!.body, /\+4 -0 lines/);

  // Both report done; channel becomes complete.
  const feDone = await fe.call("done", { channel: "auth", summary: "login page wired to POST /auth/login", timeout_seconds: 0 });
  assert.equal(feDone.channel_complete, false);
  status = await api("GET", "/api/channels/auth");
  assert.equal(status.data.status, "active");

  const beDone = await be.call("done", { channel: "auth", summary: "endpoint + tests", timeout_seconds: 0 });
  assert.equal(beDone.channel_complete, true);
  status = await api("GET", "/api/channels/auth");
  assert.equal(status.data.status, "complete");
  assert.deepEqual(
    status.data.roster.map((r: any) => r.status),
    ["done", "done"],
  );

  // FE drains BE's DONE + the COMPLETE notice, then blocks in wait.
  const drained = await fe.call("inbox", { channel: "auth" });
  assert.ok(drained.messages.some((m: any) => m.type === "DONE" && m.from_role === "BE"));
  assert.equal(drained.unread, 0);

  // Operator closes; a blocked wait unblocks with status closed; further posts are refused.
  const feFinal = fe.call("wait", { channel: "auth" });
  await new Promise((r) => setTimeout(r, 50));
  await api("POST", "/api/channels/auth/close");
  assert.equal((await feFinal).status, "closed");
  const afterClose = await be.call("post", { channel: "auth", type: "INFO", body: "too late" });
  assert.match(afterClose.error, /closed/);

  // Human transcript has the whole story in order.
  const transcript = (await api("GET", "/api/channels/auth/messages")).data;
  const types = transcript.map((m: any) => m.type);
  assert.ok(types.includes("SYSTEM") && types.includes("INFO") && types.includes("ASK") && types.includes("REPLY") && types.includes("DONE"));

  await fe.client.close();
  await be.client.close();
});

test("graceful disconnect (MCP DELETE) marks the role left", async () => {
  await api("POST", "/api/channels", { name: "pay", roles: ["FE", "BE"] });
  await api("POST", "/api/channels/pay/publish", { task: "payments" });

  const be = await agent("be-1");
  await be.call("join", { channel: "pay", role: "BE", timeout_seconds: 0 });
  assert.equal(running.relay.who("pay").roster[1].status, "present");

  await be.transport.terminateSession();
  await be.client.close();
  const left = await running.relay.waitUntil(
    () => (running.relay.who("pay").roster[1].status === "left" ? true : undefined),
    2_000,
  );
  assert.ok(left, "role should be marked left after DELETE");
  assert.ok(running.relay.messages("pay").some((m) => m.body === "BE disconnected"));
});

test("crashed agent (no DELETE): role is protected while fresh, released once stale", async () => {
  const be = await agent("be-1");
  await be.call("join", { channel: "pay", role: "BE", timeout_seconds: 0 });

  // A second live session cannot steal the role while the holder is fresh.
  const thief = await agent("be-2");
  const stolen = await thief.call("join", { channel: "pay", role: "BE", timeout_seconds: 0 });
  assert.match(stolen.error, /role_taken/);

  // Holder dies without DELETE. Server hears nothing; after staleAfterMs the role is released.
  await be.client.close();
  await new Promise((r) => setTimeout(r, 700));
  const retaken = await thief.call("join", { channel: "pay", role: "BE", timeout_seconds: 0 });
  assert.equal(retaken.status, "waiting"); // FE still missing
  assert.deepEqual(retaken.missing, ["FE"]);
  assert.ok(running.relay.messages("pay").some((m) => m.body.includes("went stale")));

  // Thief now owns the role and can act.
  const posted = await thief.call("post", { channel: "pay", type: "INFO", body: "taking over BE" });
  assert.equal(posted.from_role, "BE");
  await thief.transport.terminateSession();
  await thief.client.close();
});

test("tools refuse to act before join", async () => {
  await api("POST", "/api/channels", { name: "solo", roles: ["FE"] });
  const a = await agent("stranger");
  const r = await a.call("post", { channel: "solo", type: "INFO", body: "hi" });
  assert.match(r.error, /not_joined/);
  const w = await a.call("wait", { channel: "nope" });
  assert.match(w.error, /no_channel/);
  await a.client.close();
});
