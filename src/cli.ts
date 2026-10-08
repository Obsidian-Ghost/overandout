#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { serve, VERSION } from "./server.ts";

const HELP = `overandout-relay ${VERSION}: the relay server for overandout (npm package "overandout"), channel-based coordination for coding agents (MCP + REST + dashboard)

serve:
  overandout-relay serve [--port 7777] [--host 127.0.0.1] [--db .overandout/overandout.db] [--contracts contracts] [--max-wait 50]
  overandout-relay serve --public [--host 0.0.0.0] [--admin-token ...]
      --public requires tokens: admin token for operators, agent tokens for agents.
      Use it whenever the relay is reachable beyond localhost (0.0.0.0, a tunnel, a VPS).

channels:
  overandout-relay channel create <name> --roles FE,BE
  overandout-relay channel list | overandout-relay status [channel]
  overandout-relay channel delete <name>
  overandout-relay publish <channel> <task text | path/to/task.md>
  overandout-relay tail <channel> [--since 0]
  overandout-relay close <channel>

agent tokens (identity for remote agents, REST, or any MCP client that can send a header):
  overandout-relay invite <channel> <role> [--label name] [--url https://public.host]
      prints the token plus ready-to-paste config for Kilo, Claude Code, Cursor and the overandout CLI
  overandout-relay tokens <channel>
  overandout-relay revoke <channel> <token>

dashboard:
  open http://127.0.0.1:7777/ while serving. In --public mode it asks for the admin token.

env:
  OVERANDOUT_URL           base url of the relay for CLI commands (default http://127.0.0.1:7777)
  OVERANDOUT_ADMIN_TOKEN   admin token for CLI commands against a --public relay (or pass --token)

remote quick start (you + a friend):
  1. overandout-relay serve --public --host 0.0.0.0        # or keep 127.0.0.1 and expose with a tunnel:
     cloudflared tunnel --url http://localhost:7777   |   ngrok http 7777   |   tailscale (no tunnel needed)
  2. overandout-relay channel create api --roles DEV,OPS
  3. overandout-relay invite api DEV --url https://<your-public-url>      -> send the friend their snippet
     overandout-relay invite api OPS --url https://<your-public-url>
  4. each agent joins with its token; agents without MCP use:  pip install overandout && overandout join
`;

type Flags = Record<string, string | boolean>;

function parse(argv: string[]): { args: string[]; flags: Flags } {
  const args: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else args.push(a);
  }
  return { args, flags };
}

let cliToken: string | undefined;
const base = () => (process.env.OVERANDOUT_URL ?? "http://127.0.0.1:7777").replace(/\/$/, "");

async function api(method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const token = cliToken ?? process.env.OVERANDOUT_ADMIN_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    res = await fetch(`${base()}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`cannot reach relay at ${base()} (is "overandout-relay serve" running? set OVERANDOUT_URL for a remote relay)`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("admin token required: set OVERANDOUT_ADMIN_TOKEN or pass --token (printed by overandout-relay serve --public)");
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

const ts = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour12: false });

function formatMessage(m: any): string {
  const arrow = m.to_role ? `${m.from_role} -> ${m.to_role}` : m.from_role;
  const ref = m.reply_to ? ` (re #${m.reply_to})` : "";
  const body = String(m.body).split("\n").join("\n      ");
  return `[${ts(m.created_at)}] #${m.id} ${m.type.padEnd(8)} ${arrow}${ref}\n      ${body}`;
}

function printStatus(s: any): void {
  const roster = s.roster.map((r: any) => `${r.role}:${r.status}${r.live ? "*" : ""}${r.scope ? `(${r.scope})` : ""}`).join("  ");
  console.log(`${s.name.padEnd(16)} ${s.status.padEnd(9)} ${roster}`);
  if (s.pending_asks?.length) {
    for (const a of s.pending_asks) console.log(`  pending ask #${a.id} ${a.from} -> ${a.to}: ${a.body.slice(0, 80)}`);
  }
  if (s.task) console.log(`  task: ${String(s.task).split("\n")[0].slice(0, 100)}`);
}

function printInvite(url: string, channel: string, t: any): void {
  const mcp = `${url}/mcp`;
  console.log(`token for ${channel}/${t.role}${t.label ? ` (${t.label})` : ""}:\n  ${t.token}\n`);
  console.log(`=== Prompt for the agent (copy-paste; no MCP setup needed) ===`);
  console.log(agentPrompt(url, t));
  console.log(`\n=== Alternatively, wire it up as an MCP server ===`);
  console.log(`Kilo (~/.config/kilo/kilo.jsonc, then restart Kilo):`);
  console.log(`  "mcp": { "overandout": { "type": "remote", "url": "${mcp}", "headers": { "Authorization": "Bearer ${t.token}" } } },`);
  console.log(`  "permission": { "overandout_*": "allow" }`);
  console.log(`Claude Code:`);
  console.log(`  claude mcp add --transport http overandout ${mcp} --header "Authorization: Bearer ${t.token}"`);
  console.log(`Cursor (.cursor/mcp.json):`);
  console.log(`  { "mcpServers": { "overandout": { "url": "${mcp}", "headers": { "Authorization": "Bearer ${t.token}" } } } }`);
}

/** The text an operator pastes into an agent so it can participate using only pip. */
export function agentPrompt(url: string, t: { role: string; token: string }): string {
  return [
    `You are the ${t.role} agent on a shared task coordinated through overandout.`,
    `Run: pip install overandout && overandout login --url ${url} --token ${t.token}`,
    `Then run: overandout protocol   and follow those instructions exactly (join first; it returns your task).`,
    `Always call it as: overandout --as ${t.role} <command>   (join, inbox, ask, reply, post, contract, wait, done).`,
    `Blocking commands return "timeout" after ~45 s when nothing happened; just run them again.`,
  ].join("\n");
}

async function main(argv: string[]): Promise<void> {
  const { args, flags } = parse(argv);
  if (typeof flags.token === "string") cliToken = flags.token;
  const [cmd, sub, ...rest] = args;

  switch (cmd) {
    case "serve": {
      const running = await serve({
        port: flags.port ? Number(flags.port) : undefined,
        host: typeof flags.host === "string" ? flags.host : undefined,
        dbPath: typeof flags.db === "string" ? flags.db : undefined,
        contractsDir: typeof flags.contracts === "string" ? flags.contracts : undefined,
        maxWaitMs: flags["max-wait"] ? Number(flags["max-wait"]) * 1000 : undefined,
        public: flags.public === true,
        adminToken: typeof flags["admin-token"] === "string" ? flags["admin-token"] : undefined,
      });
      console.log(`overandout-relay ${VERSION} listening on ${running.url}${running.public ? "  [PUBLIC: tokens required]" : "  [open: localhost only]"}`);
      console.log(`  dashboard    : ${running.url}/`);
      console.log(`  MCP endpoint : ${running.mcpUrl}`);
      const bindHost = typeof flags.host === "string" ? flags.host : "127.0.0.1";
      if (bindHost === "0.0.0.0" || bindHost === "::") {
        const port = new URL(running.url).port;
        const lan = Object.values(networkInterfaces())
          .flat()
          .filter((i) => i && !i.internal && i.family === "IPv4")
          .map((i) => `http://${i!.address}:${port}`);
        console.log(`  reachable at : ${lan.join(", ") || "(no external IPv4 interface found)"}  <- use this in invites (--url)`);
      }
      console.log(`  contracts dir: ${running.relay.contractsDir}/`);
      console.log(`  channels     : ${running.relay.listChannels().map((c) => `${c.name}[${c.status}]`).join(", ") || "(none)"}`);
      if (running.public) {
        console.log(`  admin token  : ${running.adminToken}`);
        console.log(`                 use it in the dashboard and as OVERANDOUT_ADMIN_TOKEN for CLI commands`);
        console.log(`                 agents need tokens: overandout-relay invite <channel> <role>`);
      } else {
        console.log(`  note         : exposing this relay beyond localhost? restart with --public`);
      }
      const stop = async () => {
        await running.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "channel": {
      if (sub === "create") {
        const name = rest[0];
        const roles = typeof flags.roles === "string" ? flags.roles.split(",") : [];
        if (!name || !roles.length) throw new Error("usage: overandout-relay channel create <name> --roles FE,BE");
        const ch = await api("POST", "/api/channels", { name, roles });
        console.log(`created channel "${ch.name}" roles=[${ch.roles.join(", ")}] contract=${ch.contract_path}`);
        console.log(`tell each agent: 'join channel ${ch.name} as <ROLE>'  (or: overandout-relay invite ${ch.name} <ROLE> for a token)`);
        return;
      }
      if (sub === "list") {
        const list = await api("GET", "/api/channels");
        if (!list.length) console.log("(no channels)");
        for (const s of list) printStatus(s);
        return;
      }
      if (sub === "delete") {
        if (!rest[0]) throw new Error("usage: overandout-relay channel delete <name>");
        await api("DELETE", `/api/channels/${rest[0]}`);
        console.log(`deleted "${rest[0]}" (messages, members and tokens removed)`);
        return;
      }
      throw new Error("usage: overandout-relay channel create|list|delete");
    }
    case "publish": {
      const [channel, ...taskParts] = [sub, ...rest];
      if (!channel || !taskParts.length) throw new Error("usage: overandout-relay publish <channel> <task text | file>");
      const raw = taskParts.join(" ");
      const task = existsSync(raw) ? readFileSync(raw, "utf8") : raw;
      const ch = await api("POST", `/api/channels/${channel}/publish`, { task });
      console.log(`published to "${ch.name}" (status: ${ch.status})`);
      return;
    }
    case "status": {
      if (sub) printStatus(await api("GET", `/api/channels/${sub}`));
      else {
        const list = await api("GET", "/api/channels");
        if (!list.length) console.log("(no channels)");
        for (const s of list) printStatus(s);
      }
      return;
    }
    case "tail": {
      if (!sub) throw new Error("usage: overandout-relay tail <channel>");
      let since = flags.since ? Number(flags.since) : 0;
      const first = await api("GET", `/api/channels/${sub}/messages?since=${since}`);
      for (const m of first) console.log(formatMessage(m));
      if (first.length) since = first[first.length - 1].id;
      console.log(`--- following "${sub}" (ctrl+c to stop) ---`);
      for (;;) {
        const batch = await api("GET", `/api/channels/${sub}/messages?since=${since}&wait=30`);
        for (const m of batch) console.log(formatMessage(m));
        if (batch.length) since = batch[batch.length - 1].id;
      }
    }
    case "close": {
      if (!sub) throw new Error("usage: overandout-relay close <channel>");
      const ch = await api("POST", `/api/channels/${sub}/close`);
      console.log(`closed "${ch.name}"`);
      return;
    }
    case "invite": {
      const [channel, role] = [sub, rest[0]];
      if (!channel || !role) throw new Error("usage: overandout-relay invite <channel> <role> [--label name] [--url https://public.host]");
      const t = await api("POST", `/api/channels/${channel}/tokens`, { role, label: typeof flags.label === "string" ? flags.label : undefined });
      const url = (typeof flags.url === "string" ? flags.url : base()).replace(/\/$/, "");
      printInvite(url, channel, t);
      return;
    }
    case "tokens": {
      if (!sub) throw new Error("usage: overandout-relay tokens <channel>");
      const list = await api("GET", `/api/channels/${sub}/tokens`);
      if (!list.length) console.log("(no tokens; create one with: overandout-relay invite <channel> <role>)");
      for (const t of list) console.log(`${t.role.padEnd(8)} ${t.token}  ${t.label ?? ""}  last used: ${t.last_used ? ts(t.last_used) : "never"}`);
      return;
    }
    case "revoke": {
      const [channel, token] = [sub, rest[0]];
      if (!channel || !token) throw new Error("usage: overandout-relay revoke <channel> <token>");
      await api("DELETE", `/api/channels/${channel}/tokens/${token}`);
      console.log(`revoked ${token}`);
      return;
    }
    default:
      console.log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
