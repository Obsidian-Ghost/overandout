"""Unit tests for the human chat mode (parser, formatter, command handling with a stub client)."""

from __future__ import annotations

import unittest
from typing import Any, Dict, List

from overandout import RelayError
from overandout.chat import Chat, format_message, parse_command


class StubClient:
    def __init__(self) -> None:
        self.calls: List[tuple] = []

    def post(self, type: str, body: str, **kw: Any) -> Dict[str, Any]:
        self.calls.append(("post", type, body)); return {"id": 7, "type": type}

    def ask(self, role: str, q: str, timeout: float = 0) -> Dict[str, Any]:
        self.calls.append(("ask", role, q)); return {"status": "timeout", "ask_id": 9}

    def reply(self, ask_id: int, body: str) -> Dict[str, Any]:
        self.calls.append(("reply", ask_id, body)); return {"id": 10, "to_role": "FE"}

    def contract_get(self) -> Dict[str, Any]:
        return {"path": "/c.yaml", "exists": True, "content": "openapi: 3.1.0\n"}

    def who(self) -> Dict[str, Any]:
        return {"roster": [{"role": "FE", "status": "present", "live": True, "scope": "web/**"}]}

    def inbox(self, since: int = None) -> Dict[str, Any]:
        return {"messages": [], "cursor": 0, "unread": 0}

    def done(self, summary: str, timeout: float = 0) -> Dict[str, Any]:
        self.calls.append(("done", summary)); return {"channel_complete": False}


class ChatTests(unittest.TestCase):
    def test_parse_command(self) -> None:
        self.assertEqual(parse_command("/ask FE which port?"), ("ask", ["FE", "which port?"]))
        self.assertEqual(parse_command("/reply 346 UTC with Z"), ("reply", ["346", "UTC with Z"]))
        self.assertEqual(parse_command("plain words"), ("info", ["plain words"]))
        self.assertEqual(parse_command("/info hi"), ("info", ["hi"]))
        self.assertEqual(parse_command("/hold do not touch"), ("hold", ["do not touch"]))
        self.assertEqual(parse_command("/contract"), ("contract", []))
        self.assertEqual(parse_command("/contract set api.yaml"), ("contract_set", ["api.yaml"]))
        self.assertEqual(parse_command("/done shipped it"), ("done", ["shipped it"]))
        self.assertEqual(parse_command("/exit"), ("quit", []))
        self.assertEqual(parse_command("?"), ("info", ["?"]))
        self.assertEqual(parse_command("/?"), ("help", []))
        self.assertEqual(parse_command("   "), ("noop", []))
        self.assertEqual(parse_command("/wat"), ("unknown", ["wat"]))

    def test_format_message_hints(self) -> None:
        ask = {"id": 346, "type": "ASK", "from_role": "FE", "to_role": "BE", "body": "UTC?", "reply_to": None, "created_at": "2026-10-08T18:40:00.000Z"}
        s = format_message(ask, "BE")
        self.assertIn("ASK", s); self.assertIn("FE → BE", s); self.assertIn("/reply 346", s)
        self.assertNotIn("/reply", format_message(ask, "FE"), "only the addressee gets the reply hint")
        op = {"id": 1, "type": "OPERATOR", "from_role": "operator", "to_role": None, "body": "use cookies", "reply_to": None, "created_at": "2026-10-08T18:40:00.000Z"}
        self.assertIn("overrides the task", format_message(op, "BE"))

    def test_handle_routes_to_client(self) -> None:
        stub = StubClient(); out: List[str] = []
        chat = Chat(stub, out=out.append, inp=lambda _: ""); chat.me = "BE"; chat.task = "the task"
        self.assertTrue(chat.handle("contract ready"))
        self.assertTrue(chat.handle("/hold migrating"))
        self.assertTrue(chat.handle("/ask FE which field?"))
        self.assertTrue(chat.handle("/reply 346 UTC with Z"))
        self.assertTrue(chat.handle("/done shipped"))
        self.assertTrue(chat.handle("/who")); self.assertTrue(chat.handle("/contract")); self.assertTrue(chat.handle("/task"))
        self.assertTrue(chat.handle("/reply nope text"))  # usage error, still running
        self.assertFalse(chat.handle("/quit"))
        self.assertEqual(stub.calls, [
            ("post", "INFO", "contract ready"), ("post", "HOLD", "migrating"), ("ask", "FE", "which field?"),
            ("reply", 346, "UTC with Z"), ("done", "shipped"),
        ])
        text = "\n".join(out)
        self.assertIn("asked FE (#9)", text); self.assertIn("usage: /reply", text); self.assertIn("openapi: 3.1.0", text)

    def test_relay_errors_do_not_crash_the_loop(self) -> None:
        class Boom(StubClient):
            def post(self, *a: Any, **k: Any) -> Dict[str, Any]:
                raise RelayError("channel is closed", "closed")
        out: List[str] = []
        chat = Chat(Boom(), out=out.append, inp=lambda _: ""); chat.me = "BE"
        self.assertTrue(chat.handle("hello"))
        self.assertIn("relay refused: closed", "\n".join(out))


if __name__ == "__main__":
    unittest.main()
