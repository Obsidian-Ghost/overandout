"""`overandout --as ROLE chat`: a human sits in a channel as a role.

The same protocol an agent follows, driven by a person at a terminal: incoming messages print as
they arrive (a background `wait` loop), and slash commands send. Agents and humans are
interchangeable in a channel; this is how a teammate answers an agent's questions personally, how
a human plays reviewer, or how you stand in for an agent that died.
"""

from __future__ import annotations

import shlex
import sys
import threading
import time
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import RelayClient, RelayError

HELP = """\
commands (anything without a leading / is posted as INFO to everyone):
  /ask ROLE <question>     ask one role; the reply shows up here when it arrives
  /reply ID <answer>       answer an ASK addressed to you (ID is shown as #ID)
  /info <text>             announce a material change (same as plain text)
  /hold <text>             "do not touch X until I say so"
  /contract                show the shared contract
  /contract set FILE       replace the contract with FILE (announced to everyone)
  /who                     roster with liveness
  /task                    show the task again
  /history                 re-print everything in this channel
  /done <summary>          report your role finished (you stay to answer questions)
  /quit                    leave the terminal (your role stays present until it goes stale)
"""


def _ts(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%H:%M:%S")
    except Exception:  # pragma: no cover - defensive
        return iso[11:19]


def format_message(m: Dict[str, Any], me: str) -> str:
    """One readable line (plus a hint line for questions addressed to me)."""
    who = m["from_role"] + (f" → {m['to_role']}" if m.get("to_role") else "")
    ref = f" (re #{m['reply_to']})" if m.get("reply_to") else ""
    body = m["body"].replace("\n", "\n" + " " * 11)
    line = f"[{_ts(m['created_at'])}] {m['type']:<8} #{m['id']} {who}{ref}\n           {body}"
    if m["type"] == "ASK" and m.get("to_role") == me:
        line += f"\n           ↳ answer with: /reply {m['id']} <your answer>"
    if m["type"] == "OPERATOR":
        line += "\n           ↳ from the human operator: overrides the task where they conflict"
    return line


def parse_command(line: str) -> Tuple[str, List[str]]:
    """('ask', ['FE', 'question text']) | ('reply', ['12', 'text']) | ('info', ['text']) | ... | ('text', [line])"""
    s = line.strip()
    if not s:
        return ("noop", [])
    if not s.startswith("/"):
        return ("info", [s])
    head, _, rest = s[1:].partition(" ")
    cmd = head.lower()
    rest = rest.strip()
    if cmd in ("ask", "reply"):
        target, _, text = rest.partition(" ")
        return (cmd, [target, text.strip()])
    if cmd == "contract":
        if rest.lower().startswith("set"):
            return ("contract_set", [rest[3:].strip()])
        return ("contract", [])
    if cmd in ("info", "post"):
        return ("info", [rest])
    if cmd in ("hold", "who", "task", "history", "done", "quit", "exit", "help", "h", "?"):
        return ({"exit": "quit", "h": "help", "?": "help"}.get(cmd, cmd), [rest] if rest else [])
    return ("unknown", [cmd])


class Chat:
    def __init__(self, client: RelayClient, out: Callable[[str], None] = None, inp: Callable[[str], str] = None):
        self.c = client
        self.out = out or (lambda s: sys.stdout.write(s + "\n") or sys.stdout.flush())
        self.inp = inp or input
        self.me: Optional[str] = None
        self.task: Optional[str] = None
        self.stop = threading.Event()
        self.lock = threading.Lock()

    def say(self, text: str) -> None:
        with self.lock:
            self.out(text)

    # ------------------------------------------------------------------ lifecycle

    def join(self, scope: Optional[str]) -> bool:
        me = self.c.me()
        self.me = me["token"]["role"]
        self.say(f"overandout chat · channel {me['token']['channel']} · you are {self.me}")
        last_missing = None
        while not self.stop.is_set():
            r = self.c.join(scope=scope, timeout=45)
            if r["status"] == "waiting":
                missing = r.get("missing", [])
                note = f"waiting for roles {missing}" if missing else "waiting for the operator to publish a task"
                if note != last_missing:
                    self.say(f"  {note} ... (Ctrl-C to stop)")
                    last_missing = note
                continue
            if r["status"] == "closed":
                self.say("  channel is closed.")
                return False
            self.task = r.get("task")
            self.say(f"  channel is {r['status'].upper()}. roster: " + ", ".join(f"{x['role']}:{x['status']}" for x in r["roster"]))
            if self.task:
                self.say("\n--- task ---\n" + self.task.rstrip() + "\n------------")
            for a in r.get("your_pending_asks", []):
                self.say(f"  you still have an open question #{a['id']} to {a['to']}; its reply will show up here")
            return True
        return False

    def listen(self) -> None:
        """Background: print whatever arrives. Pacing/retries are handled by the client."""
        while not self.stop.is_set():
            try:
                r = self.c.wait(timeout=30)
            except RelayError as e:
                self.say(f"  (relay error while waiting: {e}; retrying)")
                time.sleep(3)
                continue
            for m in r["inbox"]["messages"]:
                self.say("\n" + format_message(m, self.me or ""))
            if r["status"] == "closed":
                self.say("\n  channel closed by the operator. bye.")
                self.stop.set()
                return
            if r.get("channel_status") == "complete" and r["status"] == "messages":
                self.say("  (every role reported done; the channel is COMPLETE, waiting for the operator to close it)")

    # ------------------------------------------------------------------ commands

    def handle(self, line: str) -> bool:
        cmd, args = parse_command(line)
        try:
            if cmd == "noop":
                return True
            if cmd == "help":
                self.say(HELP)
            elif cmd == "quit":
                return False
            elif cmd == "info":
                m = self.c.post("INFO", args[0])
                self.say(f"  posted INFO #{m['id']} to everyone")
            elif cmd == "hold":
                m = self.c.post("HOLD", args[0])
                self.say(f"  posted HOLD #{m['id']}")
            elif cmd == "ask":
                role, text = args
                if not role or not text:
                    self.say("  usage: /ask ROLE <question>")
                else:
                    r = self.c.ask(role, text, timeout=1)
                    if r["status"] == "answered":
                        self.say(f"  {role} replied: {r['reply']['body']}")
                    else:
                        self.say(f"  asked {role} (#{r['ask_id']}); the reply will show up here when it arrives")
            elif cmd == "reply":
                ask_id, text = args
                if not ask_id.isdigit() or not text:
                    self.say("  usage: /reply ID <answer>")
                else:
                    m = self.c.reply(int(ask_id), text)
                    self.say(f"  replied to #{ask_id} → {m['to_role']}")
            elif cmd == "contract":
                r = self.c.contract_get()
                self.say(f"--- contract {r['path']} ---\n{r['content'].rstrip() if r['exists'] else '(not written yet)'}\n---")
            elif cmd == "contract_set":
                path = args[0]
                if not path:
                    self.say("  usage: /contract set FILE")
                else:
                    with open(path, "r", encoding="utf-8") as f:
                        r = self.c.contract_set(f.read())
                    self.say(f"  contract updated: {r['summary'].splitlines()[0]}")
            elif cmd == "who":
                r = self.c.who()
                for x in r["roster"]:
                    self.say(f"  {x['role']:<8} {x['status']:<8} {'live' if x['live'] else 'quiet':<6} {x.get('scope') or ''}")
            elif cmd == "task":
                self.say("--- task ---\n" + (self.task or "(none yet)").rstrip() + "\n------------")
            elif cmd == "history":
                r = self.c.inbox(since=0)
                for m in r["messages"]:
                    self.say(format_message(m, self.me or ""))
            elif cmd == "done":
                if not args or not args[0]:
                    self.say("  usage: /done <what you built, how you verified it>")
                else:
                    r = self.c.done(args[0])
                    self.say("  marked done." + (" every role is done; the channel is COMPLETE." if r.get("channel_complete") else " stay here to answer questions."))
            else:
                self.say(f"  unknown command /{args[0]}; /help lists them")
        except RelayError as e:
            self.say(f"  relay refused: {e}")
        except OSError as e:
            self.say(f"  {e}")
        return True

    def run(self, scope: Optional[str]) -> int:
        try:
            if not self.join(scope):
                return 1
        except KeyboardInterrupt:
            self.say("\n  stopped while waiting; your role stays present until it goes stale.")
            return 130
        self.say("type a message (INFO to everyone) or a /command; /help for the list.\n")
        t = threading.Thread(target=self.listen, daemon=True)
        t.start()
        try:
            while not self.stop.is_set():
                try:
                    line = self.inp(f"{self.me}> ")
                except EOFError:
                    break
                if not self.handle(line):
                    break
        except KeyboardInterrupt:
            self.say("")
        finally:
            self.stop.set()
        return 0


def run_chat(client: RelayClient, scope: Optional[str] = None) -> int:
    if not sys.stdin.isatty():
        sys.stdout.write('{"ok": false, "error": "chat is interactive; agents should use the plain commands", "code": "usage"}\n')
        return 2
    return Chat(client).run(scope)
