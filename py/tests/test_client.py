"""Unit tests for overandout against a scripted fake relay (stdlib only; run with `python -m unittest`)."""

from __future__ import annotations

import io
import json
import os
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Callable, Dict, List, Tuple

from overandout import INSTRUCTIONS, RelayClient, RelayError, load_config, save_profile
from overandout.cli import main, parse_invite, FEATURES

TOKEN = "ac_test"

# Each entry: (method, path) -> list of scripted responses consumed in order (last one repeats).
Script = Dict[Tuple[str, str], List[Tuple[int, Any]]]


class FakeRelay:
    def __init__(self, script: Script):
        self.script = script
        self.calls: List[Tuple[str, str, Any]] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_: Any) -> None:  # silence
                pass

            def _handle(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}") if length else None
                path = self.path.split("?")[0]
                fake.calls.append((self.command, path, body))
                if self.headers.get("authorization") != f"Bearer {TOKEN}":
                    status, payload = 401, {"ok": False, "error": "valid agent token required", "code": "unauthorized"}
                else:
                    queue = fake.script.get((self.command, path))
                    if not queue:
                        status, payload = 404, {"ok": False, "error": "not found", "code": "not_found"}
                    else:
                        status, payload = queue.pop(0) if len(queue) > 1 else queue[0]
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = _handle

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def ok(result: Any, unread: int = 0) -> Tuple[int, Any]:
    return 200, {"ok": True, "result": result, "unread": unread}


class ClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["XDG_CONFIG_HOME"] = self.tmp.name
        os.environ.pop("OVERANDOUT_URL", None)
        os.environ.pop("OVERANDOUT_TOKEN", None)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_requires_token(self) -> None:
        with self.assertRaises(RelayError) as cm:
            RelayClient(url="http://127.0.0.1:1")
        self.assertEqual(cm.exception.code, "no_token")

    def test_join_repolls_until_active(self) -> None:
        relay = FakeRelay({
            ("POST", "/agent/join"): [
                ok({"status": "waiting", "missing": ["BE"], "task": None}),
                ok({"status": "waiting", "missing": ["BE"], "task": None}),
                ok({"status": "active", "missing": [], "task": "build it", "roster": []}),
            ],
        })
        try:
            c = RelayClient(url=relay.url, token=TOKEN)
            r = c.join(scope="apps/web/**", timeout=30)
            self.assertEqual(r["status"], "active")
            self.assertEqual(r["task"], "build it")
            joins = [b for m, p, b in relay.calls if p == "/agent/join"]
            self.assertEqual(len(joins), 3)
            self.assertEqual(joins[0]["scope"], "apps/web/**")
            self.assertLessEqual(joins[0]["timeout_seconds"], 50)
        finally:
            relay.close()

    def test_join_does_not_spin_at_the_deadline(self) -> None:
        relay = FakeRelay({("POST", "/agent/join"): [ok({"status": "waiting", "missing": ["BE"], "task": None})]})
        try:
            c = RelayClient(url=relay.url, token=TOKEN)
            r = c.join(timeout=1.5)  # the fake answers instantly, so a naive loop would spin for 1.5 s
            self.assertEqual(r["status"], "waiting")
            calls = [b for m, p, b in relay.calls if p == "/agent/join"]
            self.assertLessEqual(len(calls), 3, f"expected a handful of polls, got {len(calls)}")
            self.assertTrue(all(b["timeout_seconds"] >= 0 for b in calls))
        finally:
            relay.close()

    def test_ask_timeout_then_reply_via_wait(self) -> None:
        relay = FakeRelay({
            ("POST", "/agent/ask"): [ok({"status": "timeout", "ask_id": 7, "reply": None, "hint": "call wait"})],
            ("POST", "/agent/wait"): [
                ok({"status": "messages", "channel_status": "active", "inbox": {"messages": [
                    {"id": 8, "type": "INFO", "from_role": "BE", "to_role": None, "body": "fyi", "reply_to": None},
                ], "cursor": 8, "unread": 0}}),
                ok({"status": "messages", "channel_status": "active", "inbox": {"messages": [
                    {"id": 9, "type": "REPLY", "from_role": "BE", "to_role": "FE", "body": "JWT", "reply_to": 7},
                ], "cursor": 9, "unread": 0}}),
            ],
        })
        try:
            c = RelayClient(url=relay.url, token=TOKEN)
            r = c.ask("BE", "JWT or opaque?", timeout=30)
            self.assertEqual(r["status"], "answered")
            self.assertEqual(r["reply"]["body"], "JWT")
            self.assertEqual([m["id"] for m in r["other_messages"]], [8], "non-reply traffic is handed back to the caller")
        finally:
            relay.close()

    def test_wait_stops_on_closed_and_errors_surface_codes(self) -> None:
        relay = FakeRelay({
            ("POST", "/agent/wait"): [
                ok({"status": "timeout", "channel_status": "active", "inbox": {"messages": [], "cursor": 0, "unread": 0}}),
                ok({"status": "closed", "channel_status": "closed", "inbox": {"messages": [], "cursor": 0, "unread": 0}}),
            ],
            ("POST", "/agent/post"): [(400, {"ok": False, "error": "channel is closed", "code": "closed"})],
        })
        try:
            c = RelayClient(url=relay.url, token=TOKEN)
            self.assertEqual(c.wait(timeout=30)["status"], "closed")
            with self.assertRaises(RelayError) as cm:
                c.post("INFO", "too late")
            self.assertEqual(cm.exception.code, "closed")
            with self.assertRaises(RelayError) as cm2:
                RelayClient(url=relay.url, token="ac_wrong").me()
            self.assertEqual(cm2.exception.code, "unauthorized")
            self.assertEqual(cm2.exception.status, 401)
        finally:
            relay.close()

    def test_profiles_env_precedence_and_ambiguity(self) -> None:
        path = save_profile("pay/DEV", "http://saved:1", "ac_dev")
        self.assertTrue(os.path.exists(path))
        self.assertEqual(oct(os.stat(path).st_mode & 0o777), "0o600")
        # single profile: picked implicitly
        c = RelayClient()
        self.assertEqual((c.url, c.token), ("http://saved:1", "ac_dev"))
        # two profiles: must choose
        save_profile("pay/OPS", "http://saved:1", "ac_ops")
        with self.assertRaises(RelayError) as cm:
            RelayClient()
        self.assertEqual(cm.exception.code, "ambiguous_profile")
        self.assertEqual(RelayClient(profile="OPS").token, "ac_ops")
        self.assertEqual(RelayClient(profile="pay/dev").token, "ac_dev")
        os.environ["OVERANDOUT_PROFILE"] = "DEV"
        self.assertEqual(RelayClient().token, "ac_dev")
        with self.assertRaises(RelayError) as cm2:
            RelayClient(profile="QA")
        self.assertEqual(cm2.exception.code, "no_profile")
        # env token and explicit token beat profiles
        os.environ["OVERANDOUT_TOKEN"] = "ac_env"
        self.assertEqual(RelayClient().token, "ac_env")
        self.assertEqual(RelayClient(token="ac_arg").token, "ac_arg")
        self.assertEqual(sorted(load_config()["profiles"]), ["pay/DEV", "pay/OPS"])

    def test_discovery_surface(self) -> None:
        self.assertEqual(parse_invite("https://relay.example.com/i/ac_abc-123"), ("https://relay.example.com", "ac_abc-123"))
        self.assertEqual(parse_invite("http://127.0.0.1:7777/i/ac_x/"), ("http://127.0.0.1:7777", "ac_x"))
        self.assertIsNone(parse_invite("https://relay.example.com/agent/me"))
        self.assertIsNone(parse_invite("ac_token_only"))
        names = [c["name"] for c in FEATURES["commands"]]
        for n in ("connect", "join", "inbox", "ask", "reply", "post", "contract", "wait", "done", "protocol", "chat"):
            self.assertIn(n, names)
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(main([]), 0)
        self.assertIn("overandout connect", out.getvalue())
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(main(["features"]), 0)
        self.assertEqual(json.loads(out.getvalue())["package"], "overandout")
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(main(["connect", "nonsense"]), 2)
        self.assertEqual(json.loads(out.getvalue())["code"], "usage")

    def test_connect_from_invite_url(self) -> None:
        relay = FakeRelay({("GET", "/agent/me"): [(200, {"ok": True, "token": {"channel": "c", "role": "QA", "label": None}, "joined": False})]})
        try:
            out = io.StringIO()
            with redirect_stdout(out):
                code = main(["connect", f"{relay.url}/i/{TOKEN}"])
            self.assertEqual(code, 0)
            r = json.loads(out.getvalue())
            self.assertEqual(r["profile"], "c/QA")
            self.assertTrue(any("join" in step for step in r["next"]))
            self.assertEqual(RelayClient(profile="QA").token, TOKEN)
        finally:
            relay.close()

    def test_cli_json_output_and_exit_codes(self) -> None:
        relay = FakeRelay({
            ("GET", "/agent/me"): [(200, {"ok": True, "token": {"channel": "c", "role": "FE", "label": None}, "joined": False})],
            ("POST", "/agent/reply"): [ok({"id": 3, "type": "REPLY"})],
        })
        try:
            out = io.StringIO()
            with redirect_stdout(out):
                code = main(["login", "--url", relay.url, "--token", TOKEN])
            self.assertEqual(code, 0)
            login = json.loads(out.getvalue())
            self.assertEqual(login["role"], "FE")
            self.assertEqual(login["profile"], "c/FE")

            out = io.StringIO()
            with redirect_stdout(out):
                code = main(["reply", "3", "yes", "--pretty"])  # flags after the subcommand are accepted
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out.getvalue())["type"], "REPLY")

            out = io.StringIO()
            with redirect_stdout(out):
                code = main(["--url", relay.url, "--token", "ac_wrong", "me"])
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(out.getvalue())["code"], "unauthorized")

            out = io.StringIO()
            with redirect_stdout(out):
                code = main(["protocol"])
            self.assertEqual(code, 0)
            self.assertEqual(out.getvalue(), INSTRUCTIONS)
        finally:
            relay.close()


if __name__ == "__main__":
    unittest.main()
