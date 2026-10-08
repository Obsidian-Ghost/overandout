/**
 * `overandout-relay new`: guided channel setup for the human operator.
 *
 * Asks for the channel name and roles, gets the task text (editor, paste, or file), creates the
 * channel, publishes the task, mints one token per role and prints each agent's ready-to-paste
 * prompt. Everything it does is the same REST calls `channel create` / `publish` / `invite` make.
 */
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WizardIO {
  ask: (prompt: string) => Promise<string>;
  say: (text: string) => void;
}

export interface WizardApi {
  (method: string, path: string, body?: unknown): Promise<any>;
}

export const isChannelName = (s: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(s);

/** The task skeleton that produced good coordination in practice: ownership, contract first, done-then-wait. */
export function taskTemplate(roles: string[]): string {
  const [first, ...rest] = roles;
  const lines = [
    "<one line: what we are building>",
    "",
    `${first} (owns <folder>/**):`,
    `  1. Write the contract first: \`overandout --as ${first} contract set <file>\` (or the contract_set tool). Post INFO "contract ready".`,
    "  2. Implement <what>.",
    "  3. Answer questions from the other roles with reply, immediately and precisely.",
  ];
  for (const r of rest) {
    lines.push(
      "",
      `${r} (owns <folder>/**):`,
      `  1. wait for "contract ready", then read the contract (\`overandout --as ${r} contract\` or contract_get). Ask anything ambiguous; never guess.`,
      "  2. Implement <what>.",
    );
  }
  lines.push("", "Both: stay inside your own folder. When finished call done with a summary, then keep calling wait until the channel is closed.", "");
  return lines.join("\n");
}

export function agentPrompt(url: string, role: string, token: string): string {
  return [
    `You are the ${role} agent on a shared task coordinated through overandout.`,
    `Run: pip install overandout && overandout login --url ${url} --token ${token}`,
    `Then run: overandout protocol   and follow those instructions exactly (join first; it returns your task).`,
    `Always call it as: overandout --as ${role} <command>   (join, inbox, ask, reply, post, contract, wait, done).`,
    `Blocking commands return "timeout" after ~45 s when nothing happened; just run them again.`,
  ].join("\n");
}

function copyToClipboard(text: string): boolean {
  const cmd = process.platform === "darwin" ? ["pbcopy"] : process.platform === "win32" ? ["clip"] : ["xclip", "-selection", "clipboard"];
  const r = spawnSync(cmd[0], cmd.slice(1), { input: text, stdio: ["pipe", "ignore", "ignore"] });
  return r.status === 0;
}

function editInEditor(initial: string, name: string): string | null {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) return null;
  const file = join(tmpdir(), `overandout-${name}-${process.pid}.md`);
  writeFileSync(file, initial);
  const [bin, ...args] = editor.split(" ");
  const r = spawnSync(bin, [...args, file], { stdio: "inherit" });
  if (r.status !== 0) return null;
  return readFileSync(file, "utf8");
}

const yes = (s: string, dflt: boolean) => (s.trim() === "" ? dflt : /^y(es)?$/i.test(s.trim()));

export async function runNew(api: WizardApi, baseUrl: string, io: WizardIO, nameArg?: string): Promise<void> {
  const health = await api("GET", "/api/health");
  io.say(`relay ${health.version} at ${baseUrl} (${health.auth === "token" ? "public mode" : "local, open"})\n`);

  // name
  let name = nameArg ?? "";
  while (!isChannelName(name)) {
    if (name) io.say("  use letters, digits, - or _ (max 64)");
    name = (await io.ask("channel name: ")).trim();
  }

  // roles
  let roles: string[] = [];
  while (roles.length < 1) {
    const raw = (await io.ask("roles, comma separated [FE,BE]: ")).trim() || "FE,BE";
    roles = [...new Set(raw.split(",").map((r) => r.trim()).filter(Boolean))];
  }

  // task
  const taskPath = join("tasks", `${name}.md`);
  let task = "";
  const choice = (await io.ask(`task text: (e)ditor, (p)aste, (f)ile, or (s)kip for now [${process.env.VISUAL || process.env.EDITOR ? "e" : "p"}]: `)).trim().toLowerCase();
  const mode = choice || (process.env.VISUAL || process.env.EDITOR ? "e" : "p");
  if (mode.startsWith("e")) {
    const edited = editInEditor(existsSync(taskPath) ? readFileSync(taskPath, "utf8") : taskTemplate(roles), name);
    if (edited === null) io.say("  no editor available ($EDITOR unset or it failed); paste instead.");
    else task = edited;
  }
  if (mode.startsWith("f")) {
    const p = (await io.ask("path to task file: ")).trim();
    if (existsSync(p)) task = readFileSync(p, "utf8");
    else io.say(`  ${p} not found; paste instead.`);
  }
  if (!task && !mode.startsWith("s")) {
    io.say("paste the task, finish with a line containing only a dot (.):");
    const lines: string[] = [];
    for (;;) {
      const line = await io.ask("");
      if (line.trim() === ".") break;
      lines.push(line);
    }
    task = lines.join("\n").trim();
  }
  if (task.trim() && task.includes("<one line:")) io.say("  note: the task still contains template placeholders (<...>); you can republish later from the dashboard.");

  // create + publish
  const ch = await api("POST", "/api/channels", { name, roles });
  io.say(`\ncreated channel "${ch.name}" with roles [${roles.join(", ")}]`);
  if (task.trim()) {
    if (yes(await io.ask(`save the task to ${taskPath}? [Y/n]: `), true)) {
      mkdirSync("tasks", { recursive: true });
      writeFileSync(taskPath, task.endsWith("\n") ? task : task + "\n");
      io.say(`  saved ${taskPath}`);
    }
    await api("POST", `/api/channels/${name}/publish`, { task });
    io.say("  task published");
  } else {
    io.say("  no task yet: agents will wait in join until you publish one (dashboard → Task tab, or `overandout-relay publish`)");
  }

  // invites
  const urlAnswer = (await io.ask(`URL agents will use to reach this relay [${baseUrl}]: `)).trim();
  const url = (urlAnswer || baseUrl).replace(/\/$/, "");
  const canCopy = process.stdout.isTTY && process.platform !== "linux" || !!process.env.DISPLAY;
  const copy = canCopy && yes(await io.ask("copy each agent prompt to the clipboard one at a time? [y/N]: "), false);
  for (const role of roles) {
    const t = await api("POST", `/api/channels/${name}/tokens`, { role });
    const prompt = agentPrompt(url, role, t.token);
    io.say(`\n=== prompt for the ${role} agent ===\n${prompt}`);
    if (copy) {
      if (copyToClipboard(prompt)) await io.ask(`  copied to clipboard; paste it into the ${role} agent, then press Enter`);
      else io.say("  (clipboard copy failed; copy it from above)");
    }
  }

  io.say(`\ndone. Watch the room: ${baseUrl}/#${encodeURIComponent(name)}`);
  io.say(`  terminal: overandout-relay status ${name}   |   overandout-relay tail ${name}`);
  io.say(`  join as a human yourself: overandout-relay invite ${name} <ROLE>, then: overandout login ... && overandout --as <ROLE> chat`);
}

/** Readline-backed IO for the real CLI. */
export function terminalIO(): WizardIO & { close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (prompt) => rl.question(prompt),
    say: (text) => console.log(text),
    close: () => rl.close(),
  };
}
