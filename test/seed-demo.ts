// Seeds a live demo scenario against a running relay for eyeballing the dashboard.
// Usage: node test/seed-demo.ts [baseUrl] [holdSeconds]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] ?? "http://127.0.0.1:7777";
const hold = Number(process.argv[3] ?? 60);

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};

const agent = async (name: string) => {
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return (tool: string, args: Record<string, unknown>) => client.callTool({ name: tool, arguments: args });
};

await api("POST", "/api/channels", { name: "pay", roles: ["FE", "BE"] });
await api("POST", "/api/channels", { name: "search", roles: ["FE", "BE", "QA"] });
await api("POST", "/api/channels/pay/publish", {
  task: "Checkout: BE exposes POST /pay/intent (Stripe), FE builds the payment sheet. Contract first.",
});

const fe = await agent("fe");
const be = await agent("be");
await Promise.all([
  fe("join", { channel: "pay", role: "FE", scope: "apps/web/**", timeout_seconds: 5 }),
  be("join", { channel: "pay", role: "BE", scope: "apps/api/**", timeout_seconds: 5 }),
]);
await be("post", { channel: "pay", type: "INFO", body: "contract drafted: POST /pay/intent { amount_cents, currency } -> { client_secret }" });
await be("post", { channel: "pay", type: "HOLD", body: "do not call /pay/intent from tests yet, Stripe key rotation in progress" });
// FE asks; BE deliberately never answers so the pending-ask panel shows up.
fe("ask", { channel: "pay", to_role: "BE", question: "Is amount_cents an integer or string? Stripe SDK types disagree with the YAML.", timeout_seconds: hold });

// QA joins "search" alone so a waiting roster is visible too.
const qa = await agent("qa");
qa("join", { channel: "search", role: "QA", scope: "e2e/**", timeout_seconds: hold });

console.log(`seeded. holding sessions for ${hold}s...`);
await new Promise((r) => setTimeout(r, hold * 1000));
