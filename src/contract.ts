import { existsSync, mkdirSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import type { Relay } from "./relay.ts";

/**
 * Watches `<contractsDir>/<channel>.*` and posts a SYSTEM message to the channel when a contract
 * file changes, with a compact summary of added/removed lines. Contract-first: agents read the
 * file, not the chat, so the message is a nudge rather than the payload.
 */
export class ContractWatcher {
  private watcher: FSWatcher | null = null;
  private readonly snapshots = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly relay: Relay;
  private readonly debounceMs: number;

  constructor(relay: Relay, debounceMs = 300) {
    this.relay = relay;
    this.debounceMs = debounceMs;
  }

  get dir(): string {
    return this.relay.contractsDir;
  }

  start(): void {
    mkdirSync(this.dir, { recursive: true });
    for (const file of readdirSync(this.dir)) this.snapshots.set(file, this.read(file));
    this.watcher = watch(this.dir, (_event, filename) => {
      if (!filename) return;
      const name = filename.toString();
      clearTimeout(this.timers.get(name));
      this.timers.set(
        name,
        setTimeout(() => {
          this.timers.delete(name);
          this.check(name);
        }, this.debounceMs),
      );
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Record content the relay itself just wrote, so the next fs event for it is not re-announced. */
  prime(path: string, content: string): void {
    const file = basename(path);
    this.snapshots.set(file, content);
    clearTimeout(this.timers.get(file));
    this.timers.delete(file);
  }

  /** Force a check of one file (used by tests). */
  check(file: string): void {
    const channel = file.split(".")[0];
    if (!channel) return;
    const before = this.snapshots.get(file) ?? "";
    const after = this.read(file);
    if (before === after) return;
    this.snapshots.set(file, after);
    let ch;
    try {
      ch = this.relay.channel(channel);
    } catch {
      return; // file does not correspond to a channel
    }
    if (ch.status === "closed") return;
    const summary = summarize(before, after);
    const path = join(this.dir, file);
    const verb = !before ? "created" : !after ? "deleted" : "changed";
    this.relay.systemPost(channel, `contract ${verb}: ${path}\n${summary}\nRe-read the contract before touching anything that depends on it.`);
  }

  private read(file: string): string {
    const path = join(this.dir, file);
    if (!existsSync(path)) return "";
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  }
}

/** Cheap line-level diff summary: lines present in one version but not the other (multiset). */
export function summarize(before: string, after: string, max = 8): string {
  const count = (text: string) => {
    const m = new Map<string, number>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      m.set(line, (m.get(line) ?? 0) + 1);
    }
    return m;
  };
  const a = count(before);
  const b = count(after);
  const removed: string[] = [];
  const added: string[] = [];
  for (const [line, n] of a) for (let i = 0; i < n - (b.get(line) ?? 0); i++) removed.push(line);
  for (const [line, n] of b) for (let i = 0; i < n - (a.get(line) ?? 0); i++) added.push(line);
  const lines = [`+${added.length} -${removed.length} lines`];
  for (const l of removed.slice(0, max)) lines.push(`- ${l}`);
  if (removed.length > max) lines.push(`- ... ${removed.length - max} more`);
  for (const l of added.slice(0, max)) lines.push(`+ ${l}`);
  if (added.length > max) lines.push(`+ ... ${added.length - max} more`);
  return lines.join("\n");
}
