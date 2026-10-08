"""overandout: let coding agents coordinate on one task through a shared channel.

If you are an agent reading this: run ``python -m overandout`` (or ``overandout protocol``) for the
full instructions. Short version:

    from overandout import RelayClient
    c = RelayClient()                      # settings from `overandout login` or OVERANDOUT_URL / OVERANDOUT_TOKEN
    task = c.join(scope="apps/api/**")     # blocks until the channel is active; returns the task
    answer = c.ask("FE", "Which field name do you expect for the token?")   # blocks for the reply
    c.post("INFO", "contract updated: POST /auth/login now returns { token, expires_at }")
    c.done("endpoint + tests shipped"); c.wait()

Identity is a token created by the operator (``relay invite <channel> <role>``); it fixes your
channel and role. Blocking calls (join / ask / wait / done) are long-polls: the server answers in
~50-second chunks and this client re-polls until your own ``timeout`` elapses, so you see one call
with one answer. No MCP configuration is needed; this talks to the relay over plain HTTP.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from .instructions import INSTRUCTIONS

__version__ = "0.2.2"  # x-release-please-version


def protocol() -> str:
    """The instructions an agent should follow (same text as `overandout protocol`)."""
    return INSTRUCTIONS

# A single blocking request should never exceed the server's cap by much; the server returns
# "timeout" and we loop. Keep the socket timeout above the server cap (default 50s).
_REQUEST_TIMEOUT = 75
# Default total wait for blocking calls. Coding agents' shell tools usually kill a command after
# 60-120 s, so by default we return {"status": "timeout"} well before that and the agent re-runs.
DEFAULT_WAIT = 45
# Per-request cap we ask the server for. It clamps to its own maximum anyway.
_CHUNK_SECONDS = 40


class RelayError(Exception):
    """Raised when the relay rejects a call. ``code`` is the machine-readable reason."""

    def __init__(self, message: str, code: str = "error", status: int = 0):
        super().__init__(message)
        self.code = code
        self.status = status

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"{self.code}: {super().__str__()}"


def config_path() -> str:
    """Saved connection settings: $XDG_CONFIG_HOME/overandout/config.json (or ~/.config/...)."""
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "overandout", "config.json")


def load_config() -> Dict[str, Any]:
    """{"profiles": {"<channel>/<ROLE>": {"url": ..., "token": ...}, ...}}"""
    try:
        with open(config_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {"profiles": {}}
    if not isinstance(data, dict):
        return {"profiles": {}}
    data.setdefault("profiles", {})
    return data


def save_profile(name: str, url: str, token: str) -> str:
    """Add or replace one login profile (several agents can share a machine). Returns the file path."""
    cfg = load_config()
    cfg["profiles"][name] = {"url": url.rstrip("/"), "token": token}
    path = config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    return path


def resolve_profile(selector: Optional[str]) -> Optional[Dict[str, str]]:
    """Pick a saved profile. ``selector`` is a role ("DEV") or "channel/ROLE" (case-insensitive).

    With no selector: the only profile if exactly one exists, otherwise None. Raises RelayError when
    the selector matches nothing or several profiles.
    """
    profiles = load_config()["profiles"]
    if not profiles:
        return None
    if selector:
        sel = selector.lower()
        hits = [p for name, p in profiles.items() if name.lower() == sel or name.lower().endswith("/" + sel)]
        if len(hits) == 1:
            return hits[0]
        if not hits:
            raise RelayError(f"no saved login matches '{selector}'. Saved: {', '.join(profiles)}. Run overandout login first.", "no_profile")
        raise RelayError(f"'{selector}' matches several logins ({', '.join(profiles)}); use channel/ROLE.", "ambiguous_profile")
    if len(profiles) == 1:
        return next(iter(profiles.values()))
    return None


class RelayClient:
    """Connection settings resolve as: explicit argument > environment > saved profile > localhost.

    Several agents on one machine each ``overandout login`` with their own token; each then selects its
    profile with ``RelayClient(profile="DEV")`` / ``overandout --as DEV`` (or OVERANDOUT_PROFILE). With a
    single saved login no selector is needed.
    """

    def __init__(self, url: Optional[str] = None, token: Optional[str] = None, profile: Optional[str] = None):
        env_token = os.environ.get("OVERANDOUT_TOKEN")
        selector = profile or os.environ.get("OVERANDOUT_PROFILE")
        saved = None if (token or env_token) and not selector else resolve_profile(selector)
        self.url = (url or os.environ.get("OVERANDOUT_URL") or (saved or {}).get("url") or "http://127.0.0.1:7777").rstrip("/")
        self.token = token or env_token or (saved or {}).get("token") or ""
        self.profile = selector
        if not self.token:
            names = list(load_config()["profiles"])
            if len(names) > 1:
                raise RelayError(
                    f"several logins are saved on this machine ({', '.join(names)}); say which one: "
                    "overandout --as <ROLE> ... (or set OVERANDOUT_PROFILE / OVERANDOUT_TOKEN)",
                    "ambiguous_profile",
                )
            raise RelayError(
                "no agent token: run `overandout login --url URL --token TOKEN`, or set OVERANDOUT_TOKEN (the operator creates tokens with `relay invite`)",
                "no_token",
            )

    # ------------------------------------------------------------------ transport

    def _call(self, method: str, path: str, body: Optional[Dict[str, Any]] = None, timeout: float = _REQUEST_TIMEOUT) -> Dict[str, Any]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                payload = json.loads(res.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read().decode() or "{}")
            except Exception:  # pragma: no cover - non-JSON error body
                payload = {}
            raise RelayError(payload.get("error") or e.reason, payload.get("code") or "http_error", e.code) from None
        except urllib.error.URLError as e:
            raise RelayError(f"cannot reach relay at {self.url}: {e.reason}", "unreachable") from None
        if payload.get("ok") is False:
            raise RelayError(payload.get("error", "unknown error"), payload.get("code", "error"))
        return payload

    @staticmethod
    def _chunk(deadline: float) -> int:
        return max(0, min(_CHUNK_SECONDS, int(deadline - time.monotonic())))

    def _poll(self, path: str, body: Dict[str, Any], deadline: float) -> Dict[str, Any]:
        """One long-poll request. If the server answered 'nothing yet' faster than a second (a proxy
        or a relay with a small --max-wait), pace to at most one request per second."""
        t0 = time.monotonic()
        r = self._call("POST", path, {**body, "timeout_seconds": self._chunk(deadline)})["result"]
        elapsed = time.monotonic() - t0
        if r.get("status") in ("waiting", "timeout") and elapsed < 1:
            time.sleep(max(0.0, min(1 - elapsed, deadline - time.monotonic())))
        return r

    @staticmethod
    def _expired(deadline: float) -> bool:
        """True when less than a second of budget is left: never issue another poll in that window.

        Without this guard the final sub-second of a wait degenerates into a tight loop of
        zero-timeout requests (the server answers instantly, the loop spins until the deadline).
        """
        return deadline - time.monotonic() < 1

    # ------------------------------------------------------------------ identity

    def me(self) -> Dict[str, Any]:
        """Token binding, whether you have joined, channel status and your unread count."""
        return self._call("GET", "/agent/me")

    # ------------------------------------------------------------------ lifecycle

    def join(self, scope: Optional[str] = None, timeout: float = DEFAULT_WAIT) -> Dict[str, Any]:
        """Join as your token's role and block until the channel is active (or ``timeout`` seconds).

        Returns the join result; ``result["status"]`` is ``active``, ``waiting`` (timed out),
        ``complete`` or ``closed``. ``result["task"]`` is the published task text.
        """
        deadline = time.monotonic() + timeout
        while True:
            r = self._poll("/agent/join", {"scope": scope}, deadline)
            if r["status"] != "waiting" or self._expired(deadline):
                return r

    def who(self) -> Dict[str, Any]:
        return self._call("GET", "/agent/who")["result"]

    def post(self, type: str, body: str, to_role: Optional[str] = None, reply_to: Optional[int] = None) -> Dict[str, Any]:
        """INFO for material changes, HOLD for "do not touch X". Never acknowledgements."""
        payload: Dict[str, Any] = {"type": type, "body": body}
        if to_role:
            payload["to_role"] = to_role
        if reply_to is not None:
            payload["reply_to"] = reply_to
        return self._call("POST", "/agent/post", payload)["result"]

    def ask(self, to_role: str, question: str, timeout: float = DEFAULT_WAIT) -> Dict[str, Any]:
        """Ask a role and block until answered or ``timeout`` seconds.

        Returns ``{"status": "answered", "ask_id", "reply", "other_messages"}`` or
        ``{"status": "timeout", "ask_id", ...}``. ``other_messages`` are messages that arrived
        while waiting (including questions for you); handle them.
        """
        deadline = time.monotonic() + timeout
        r = self._poll("/agent/ask", {"to_role": to_role, "question": question}, deadline)
        others: List[Dict[str, Any]] = []
        while r["status"] == "timeout" and not self._expired(deadline):
            w = self._poll("/agent/wait", {}, deadline)
            for m in w["inbox"]["messages"]:
                if m["type"] == "REPLY" and m.get("reply_to") == r["ask_id"]:
                    r = {"status": "answered", "ask_id": r["ask_id"], "reply": m, "hint": "Continue with this answer."}
                else:
                    others.append(m)
            if w["status"] == "closed":
                break
        r["other_messages"] = others
        return r

    def reply(self, ask_id: int, body: str) -> Dict[str, Any]:
        return self._call("POST", "/agent/reply", {"ask_id": ask_id, "body": body})["result"]

    def inbox(self, since: Optional[int] = None) -> Dict[str, Any]:
        """Unread messages (advances your cursor). ``since=0`` re-reads the whole history."""
        return self._call("POST", "/agent/inbox", {"since": since} if since is not None else {})["result"]

    def wait(self, timeout: float = DEFAULT_WAIT) -> Dict[str, Any]:
        """Block until a message arrives for you or the channel closes. Returns the wait result."""
        deadline = time.monotonic() + timeout
        while True:
            r = self._poll("/agent/wait", {}, deadline)
            if r["status"] != "timeout" or self._expired(deadline):
                return r

    def done(self, summary: str, timeout: float = 0) -> Dict[str, Any]:
        """Mark your role finished. With ``timeout`` > 0 it then waits like ``wait``."""
        deadline = time.monotonic() + timeout
        r = self._poll("/agent/done", {"summary": summary}, deadline)
        while r["status"] == "timeout" and not self._expired(deadline):
            r = self._poll("/agent/done", {"summary": summary}, deadline)
        return r

    # ------------------------------------------------------------------ contract

    def contract_get(self) -> Dict[str, Any]:
        return self._call("GET", "/agent/contract")["result"]

    def contract_set(self, content: str) -> Dict[str, Any]:
        return self._call("PUT", "/agent/contract", {"content": content})["result"]


__all__ = ["RelayClient", "RelayError", "INSTRUCTIONS", "DEFAULT_WAIT", "protocol", "config_path", "load_config", "save_profile", "resolve_profile", "__version__"]
