import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type RunningServer } from "../src/server.ts";
import { runNew, taskTemplate, agentPrompt, type WizardIO } from "../src/wizard.ts";

let running: RunningServer;
let tmp: string;
let cwd: string;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "oao-wizard-"));
  running = await serve({ port: 0, dbPath: ":memory:", contractsDir: join(tmp, "contracts"), watchContracts: false });
  cwd = process.cwd();
  process.chdir(tmp); // the wizard writes tasks/<name>.md relative to cwd
});

after(async () => {
  process.chdir(cwd);
  await running.close();
  rmSync(tmp, { recursive: true, force: true });
});

const api = async (method: string, path: string, body?: unknown): Promise<any> => {
  const res = await fetch(`${running.url}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
};

/** Scripted terminal: answers are consumed in order; everything said is captured. */
function scripted(answers: string[]): WizardIO & { said: string[] } {
  const said: string[] = [];
  return {
    said,
    ask: async (prompt) => {
      said.push(prompt);
      if (!answers.length) throw new Error(`wizard asked an unexpected question: ${prompt}`);
      return answers.shift()!;
    },
    say: (t) => said.push(t),
  };
}

test("task template names every role and keeps the three rules", () => {
  const t = taskTemplate(["API", "WEB", "QA"]);
  assert.match(t, /^API \(owns/m);
  assert.match(t, /^WEB \(owns/m);
  assert.match(t, /^QA \(owns/m);
  assert.match(t, /contract set/);
  assert.match(t, /done with a summary, then keep calling wait/);
  assert.match(agentPrompt("https://r.example", "WEB", "ac_x"), /overandout login --url https:\/\/r.example --token ac_x/);
});

test("wizard: creates the channel, saves + publishes the pasted task, mints one token per role, prints prompts", async () => {
  const io = scripted([
    "demo",            // channel name
    "API, WEB",        // roles
    "p",               // paste the task
    "Build the thing.", // task line 1
    "API first.",       // task line 2
    ".",               // end of paste
    "",                // save to tasks/demo.md? [Y/n] -> default yes
    "https://relay.example.com", // public URL for invites
    "n",               // clipboard
  ]);
  await runNew(api, running.url, io);

  const status = await api("GET", "/api/channels/demo");
  assert.deepEqual(status.roles, ["API", "WEB"]);
  assert.equal(status.status, "waiting");
  assert.match(status.task, /Build the thing\.\nAPI first\./);
  assert.ok(existsSync(join(tmp, "tasks", "demo.md")));
  assert.match(readFileSync(join(tmp, "tasks", "demo.md"), "utf8"), /API first/);

  const tokens = await api("GET", "/api/channels/demo/tokens");
  assert.deepEqual(tokens.map((t: any) => t.role).sort(), ["API", "WEB"]);
  const out = io.said.join("\n");
  for (const t of tokens) assert.match(out, new RegExp(`overandout login --url https://relay.example.com --token ${t.token}`));
  assert.match(out, /prompt for the API agent/);
  assert.match(out, /prompt for the WEB agent/);
  assert.match(out, /overandout --as WEB <command>/);
});

test("wizard: rejects bad names until a valid one, allows skipping the task", async () => {
  const io = scripted(["bad name!", "ok-name", "", "s", running.url, "n"]);
  await runNew(api, running.url, io);
  const st = await api("GET", "/api/channels/ok-name");
  assert.deepEqual(st.roles, ["FE", "BE"]); // default roles
  assert.equal(st.task, null);
  assert.match(io.said.join("\n"), /use letters, digits/);
  assert.match(io.said.join("\n"), /no task yet/);
});
