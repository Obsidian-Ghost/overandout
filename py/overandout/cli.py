"""overandout: command-line client for the overandout relay, meant to be run by coding agents.

`oao` is a short alias for the same command.

Output is JSON on stdout (one object), so an agent can read it directly. Exit code 0 on success,
1 on a relay error (the error is also JSON on stdout), 2 on usage errors.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from . import DEFAULT_WAIT, INSTRUCTIONS, RelayClient, RelayError, __version__, config_path, load_config, save_profile

PROTOCOL = INSTRUCTIONS


def _out(obj: Any, pretty: bool) -> None:
    print(json.dumps(obj, indent=2 if pretty else None, ensure_ascii=False))


def _read_file_or_stdin(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _common(suppress: bool) -> argparse.ArgumentParser:
    """Global options, accepted both before and after the subcommand (agents put flags anywhere)."""
    c = argparse.ArgumentParser(add_help=False)
    d = argparse.SUPPRESS if suppress else None
    c.add_argument("--url", default=d, help="relay base url (default: $OVERANDOUT_URL or http://127.0.0.1:7777)")
    c.add_argument("--token", default=d, help="agent token (default: $OVERANDOUT_TOKEN)")
    c.add_argument("--as", dest="profile", default=d, metavar="ROLE", help="which saved login to use when several agents share this machine, e.g. --as DEV (default: $OVERANDOUT_PROFILE)")
    c.add_argument("--pretty", action="store_true", default=argparse.SUPPRESS if suppress else False, help="indent JSON output")
    return c


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="overandout", description="agent-relay client for coding agents (JSON output)", parents=[_common(False)])
    p.add_argument("--version", action="version", version=f"overandout {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True, parser_class=lambda **kw: argparse.ArgumentParser(parents=[_common(True)], **kw))

    sub.add_parser("me", help="token binding, joined?, channel status, unread count")

    j = sub.add_parser("join", help="join as your role; blocks until the channel is active")
    j.add_argument("--scope", help='files you own, e.g. "apps/api/**"')
    j.add_argument("--timeout", type=float, default=DEFAULT_WAIT, help=f"seconds to block before returning status timeout (default {DEFAULT_WAIT}; re-run to keep waiting)")

    sub.add_parser("who", help="roster with liveness")

    po = sub.add_parser("post", help="announce something (INFO or HOLD)")
    po.add_argument("type", choices=["INFO", "HOLD"])
    po.add_argument("body")
    po.add_argument("--to", dest="to_role", help="target one role; omit to broadcast")
    po.add_argument("--reply-to", dest="reply_to", type=int, help="message id this refers to")

    a = sub.add_parser("ask", help="ask a role and block for the reply")
    a.add_argument("role")
    a.add_argument("question")
    a.add_argument("--timeout", type=float, default=DEFAULT_WAIT, help=f"seconds to block (default {DEFAULT_WAIT}); on timeout run `overandout wait`")

    r = sub.add_parser("reply", help="answer an ASK addressed to you")
    r.add_argument("ask_id", type=int)
    r.add_argument("body")

    i = sub.add_parser("inbox", help="unread messages (advances your cursor)")
    i.add_argument("--since", type=int, help="cursor; 0 re-reads everything")

    w = sub.add_parser("wait", help="block until a message arrives or the channel closes")
    w.add_argument("--timeout", type=float, default=DEFAULT_WAIT, help=f"seconds to block (default {DEFAULT_WAIT}); re-run on timeout")

    d = sub.add_parser("done", help="report your role finished")
    d.add_argument("summary")
    d.add_argument("--timeout", type=float, default=0, help="keep waiting this many seconds afterwards")

    c = sub.add_parser("contract", help="read (default) or set the shared contract")
    c.add_argument("action", nargs="?", choices=["get", "set"], default="get")
    c.add_argument("file", nargs="?", help="file to upload with `set` (use - for stdin)")

    sub.add_parser("protocol", help="print the instructions an agent should follow (paste into AGENTS.md)")

    ch = sub.add_parser("chat", help="sit in the channel as a human: live messages + /commands (interactive)")
    ch.add_argument("--scope", help='files you own, e.g. "apps/api/**"')

    # `login` reuses the shared --url / --token flags: overandout login --url https://relay.example.com --token ac_...
    sub.add_parser("login", help="save --url and --token as a profile named <channel>/<ROLE>; several agents can share a machine")

    sub.add_parser("config", help="list saved logins (tokens masked)")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "protocol":
        print(PROTOCOL, end="")
        return 0
    if args.cmd == "login":
        url = getattr(args, "url", None) or "http://127.0.0.1:7777"
        token = getattr(args, "token", None)
        if not token:
            print(json.dumps({"ok": False, "error": "login needs --token (and --url unless the relay is local)", "code": "usage"}))
            return 2
        try:
            probe = RelayClient(url=url, token=token).me()
        except RelayError as e:
            _out({"ok": False, "error": f"the relay rejected these settings, nothing saved: {e}", "code": e.code}, getattr(args, "pretty", False))
            return 1
        name = f"{probe['token']['channel']}/{probe['token']['role']}"
        path = save_profile(name, url, token)
        others = [n for n in load_config()["profiles"] if n != name]
        _out({
            "ok": True, "saved": path, "profile": name, "url": url.rstrip("/"),
            "channel": probe["token"]["channel"], "role": probe["token"]["role"],
            "use": f"overandout --as {probe['token']['role']} <command>" if others else "overandout <command>",
            "note": "other logins exist on this machine; always pass --as to pick yours" if others else "only login on this machine; --as is optional",
        }, getattr(args, "pretty", False))
        return 0
    if args.cmd == "config":
        cfg = load_config()
        masked = {n: {"url": p.get("url"), "token": (p.get("token") or "")[:6] + "..." + (p.get("token") or "")[-4:]} for n, p in cfg["profiles"].items()}
        _out({"path": config_path(), "profiles": masked, "hint": "pick one with overandout --as <ROLE> when several are saved"}, getattr(args, "pretty", False))
        return 0
    try:
        c = RelayClient(url=getattr(args, "url", None), token=getattr(args, "token", None), profile=getattr(args, "profile", None))
        if args.cmd == "me":
            res = c.me()
        elif args.cmd == "join":
            res = c.join(scope=args.scope, timeout=args.timeout)
        elif args.cmd == "who":
            res = c.who()
        elif args.cmd == "post":
            res = c.post(args.type, args.body, to_role=args.to_role, reply_to=args.reply_to)
        elif args.cmd == "ask":
            res = c.ask(args.role, args.question, timeout=args.timeout)
        elif args.cmd == "reply":
            res = c.reply(args.ask_id, args.body)
        elif args.cmd == "inbox":
            res = c.inbox(since=args.since)
        elif args.cmd == "wait":
            res = c.wait(timeout=args.timeout)
        elif args.cmd == "done":
            res = c.done(args.summary, timeout=args.timeout)
        elif args.cmd == "chat":
            from .chat import run_chat

            return run_chat(c, scope=args.scope)
        elif args.cmd == "contract":
            if args.action == "set":
                if not args.file:
                    print(json.dumps({"ok": False, "error": "contract set needs a FILE (or - for stdin)", "code": "usage"}))
                    return 2
                res = c.contract_set(_read_file_or_stdin(args.file))
            else:
                res = c.contract_get()
        else:  # pragma: no cover
            return 2
        _out(res, args.pretty)
        return 0
    except RelayError as e:
        _out({"ok": False, "error": str(e).split(": ", 1)[-1], "code": e.code}, args.pretty)
        return 1
    except KeyboardInterrupt:  # pragma: no cover
        return 130


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
