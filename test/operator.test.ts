import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
    const end = text.lastIndexOf("\n}") + 2;
    return { ...JSON.parse(text.slice(0, end)), _footer: text.slice(end).trim() };
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
  tmp = mkdtempSync(join(tmpdir(), "relay-op-"));
  running = await serve({ port: 0, dbPath: ":memory:", contractsDir: join(tmp, "contracts"), maxWaitMs: 2_000 });
});

after(async () => {
  await running.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("dashboard is served at / and the SSE stream emits on change", async () => {
  const page = await fetch(`${running.url}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await page.text(), /<title>overandout<\/title>/);

  const ac = new AbortController();
  const res = await fetch(`${running.url}/api/events`, { signal: ac.signal });
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const readEvent = async () => {
    let buf = "";
    while (!buf.includes("event: change")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buf += decoder.decode(value);
    }
    return buf;
  };
  await readEvent(); // initial hello
  await api("POST", "/api/channels", { name: "ui", roles: ["FE", "BE"] });
  await readEvent(); // change caused by createChannel
  ac.abort();
});

test("operator post reaches agents as OPERATOR and the wait hint marks it authoritative", async () => {
  await api("POST", "/api/channels/ui/publish", { task: "build a thing" });
  const fe = await agent("fe");
  const be = await agent("be");
  const [j1, j2] = await Promise.all([
    fe.call("join", { channel: "ui", role: "FE" }),
    be.call("join", { channel: "ui", role: "BE" }),
  ]);
  assert.equal(j1.status, "active");
  assert.equal(j2.status, "active");
  await fe.call("inbox", { channel: "ui" });
  await be.call("inbox", { channel: "ui" });

  // Broadcast operator message.
  const posted = await api("POST", "/api/channels/ui/post", { body: "switch to cookie sessions, drop the JWT" });
  assert.equal(posted.status, 200);
  assert.equal(posted.data.type, "OPERATOR");
  assert.equal(posted.data.from_role, "operator");

  const feWait = await fe.call("wait", { channel: "ui" });
  assert.equal(feWait.status, "messages");
  assert.equal(feWait.inbox.messages[0].type, "OPERATOR");
  assert.match(feWait.hint, /OPERATOR message.*override the task/);
  const beInbox = await be.call("inbox", { channel: "ui" });
  assert.equal(beInbox.messages.filter((m: any) => m.type === "OPERATOR").length, 1);

  // Targeted operator message only reaches that role.
  await api("POST", "/api/channels/ui/post", { body: "FE only: use the new button", to_role: "FE" });
  assert.equal((await fe.call("inbox", { channel: "ui" })).messages.length, 1);
  assert.equal((await be.call("inbox", { channel: "ui" })).messages.length, 0);

  // Validation.
  assert.equal((await api("POST", "/api/channels/ui/post", { body: "x", to_role: "QA" })).data.code, "bad_role");
  assert.equal((await api("POST", "/api/channels/ui/post", {})).status, 400);

  await fe.client.close();
  await be.client.close();
});

test("operator can answer a pending ask on behalf of a sleeping agent", async () => {
  await api("POST", "/api/channels", { name: "sleepy", roles: ["FE", "BE"] });
  await api("POST", "/api/channels/sleepy/publish", { task: "t" });
  const fe = await agent("fe2");
  const be = await agent("be2");
  await Promise.all([fe.call("join", { channel: "sleepy", role: "FE" }), be.call("join", { channel: "sleepy", role: "BE" })]);

  // FE asks; BE never answers (simulating an agent that finished its turn).
  const askPromise = fe.call("ask", { channel: "sleepy", to_role: "BE", question: "JWT or opaque token?" });
  await running.relay.waitUntil(() => (running.relay.status("sleepy").pending_asks.length ? true : undefined), 1_000);
  const st = await api("GET", "/api/channels/sleepy");
  assert.equal(st.data.pending_asks.length, 1);
  assert.equal(st.data.pending_asks[0].from, "FE");
  assert.ok(st.data.pending_asks[0].created_at);

  // Wrong channel is rejected; correct one resolves FE's blocking ask.
  const wrong = await api("POST", "/api/channels/ui/reply", { ask_id: st.data.pending_asks[0].id, body: "x" });
  assert.equal(wrong.status, 404);
  const ok = await api("POST", "/api/channels/sleepy/reply", { ask_id: st.data.pending_asks[0].id, body: "JWT" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.from_role, "operator");
  assert.equal(ok.data.to_role, "FE");

  const answered = await askPromise;
  assert.equal(answered.status, "answered");
  assert.match(answered.reply.body, /^\[answered by operator on behalf of BE\] JWT$/);
  assert.equal((await api("GET", "/api/channels/sleepy")).data.pending_asks.length, 0);

  // Cannot answer twice.
  const twice = await api("POST", "/api/channels/sleepy/reply", { ask_id: st.data.pending_asks[0].id, body: "again" });
  assert.equal(twice.data.code, "already_answered");

  await fe.client.close();
  await be.client.close();
});

test("contract endpoint reports missing then present file", async () => {
  const before = await api("GET", "/api/channels/ui/contract");
  assert.equal(before.data.exists, false);
  assert.match(before.data.path, /ui\.openapi\.yaml$/);

  mkdirSync(join(tmp, "contracts"), { recursive: true });
  writeFileSync(join(tmp, "contracts", "ui.openapi.yaml"), "openapi: 3.1.0\n");
  const after = await api("GET", "/api/channels/ui/contract");
  assert.equal(after.data.exists, true);
  assert.equal(after.data.content, "openapi: 3.1.0\n");

  // messages endpoint honours limit
  const limited = await api("GET", "/api/channels/ui/messages?limit=2");
  assert.equal(limited.data.length, 2);
});
