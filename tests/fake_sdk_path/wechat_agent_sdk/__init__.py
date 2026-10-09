"""Minimal fake wechat_agent_sdk for driving the REAL transport.py in tests.

Activated via PYTHONPATH so `import wechat_agent_sdk` resolves here first.
Behavior is scriptable through the FAKE_STATE environment variable (JSON):
  {"needsLogin": bool, "messages": [raw...], "failConnect": bool}
Side effects are recorded to the file named by FAKE_LOG (JSON lines):
  {"event": "send_text", "conversationId": ..., "text": ..., "token": ...}
"""

import json
import os
import threading


class LoginStatus:
    PENDING = "pending"
    SCANNED = "scanned"
    CONFIRMED = "confirmed"
    EXPIRED = "expired"
    ERROR = "error"


class LoginSession:
    def __init__(self, qr_url="", uuid=""):
        self.qr_url = qr_url
        self.uuid = uuid


class LoginResult:
    def __init__(self, status, token=None, error=None):
        self.status = status
        self.token = token
        self.error = error


class Parsed:
    def __init__(self, conversation_id, text, context_token, message_id="m1",
                 sender_id=None, sender_name=None, group_id=None, is_at_bot=False):
        self.conversation_id = conversation_id
        self.text = text
        self.context_token = context_token
        self.message_id = message_id
        self.sender_id = sender_id
        self.sender_name = sender_name
        self.group_id = group_id
        self.is_at_bot = is_at_bot


def _state():
    return json.loads(os.environ.get("FAKE_STATE", "{}"))


def _log(event):
    path = os.environ.get("FAKE_LOG")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, ensure_ascii=False) + "\n")


class FakeStorage:
    async def load_token(self, account_id):
        return None if _state().get("needsLogin") else "stored-token"

    async def save_token(self, account_id, token):
        _log({"event": "save_token", "token": token})


class FakeClient:
    def __init__(self):
        self.token = ""


class WeChatTransport:
    """Mirror of the real transport surface transport.py touches."""

    def __init__(self, account_id="dsh", storage=None):
        self._account_id = account_id
        self._storage = FakeStorage()
        self._client = FakeClient()
        self.connected = False
        self.sent = []
        # Synchronous preload mirrors real class: needs_login only sees
        # in-memory state until request_login() loads storage.
        self._token_loaded = False

    @property
    def needs_login(self):
        return not self._client.token

    async def request_login(self):
        stored = await self._storage.load_token(self._account_id)
        if stored:
            self._client.token = stored
            return LoginSession(qr_url="", uuid="stored")
        return LoginSession(qr_url="https://fake.weixin.qq.com/qr/xyz", uuid="u1")

    async def check_login(self, session):
        return LoginResult(LoginStatus.CONFIRMED, token="fresh-token")

    async def connect(self):
        if _state().get("failConnect"):
            raise RuntimeError("connect failed (simulated)")
        self.connected = True
        _log({"event": "connected"})

    async def disconnect(self):
        self.connected = False
        _log({"event": "disconnected"})

    async def messages(self):
        for raw in _state().get("messages", []):
            yield raw
        # Block forever, like the real long-poll stream.
        while True:
            await asyncio_sleep(3600)

    def parse(self, raw):
        if raw is None:
            return None
        return Parsed(
            conversation_id=raw.get("conversationId", "wxid_test"),
            text=raw.get("text", ""),
            context_token=raw.get("contextToken", "ctx-1"),
            message_id=raw.get("messageId", "m1"),
            group_id=raw.get("groupId"),
            is_at_bot=raw.get("isAtBot", False),
        )

    async def send_text(self, conversation_id, text, context_token=None):
        self.sent.append({"conversationId": conversation_id, "text": text})
        _log({"event": "send_text", "conversationId": conversation_id,
              "text": text, "token": context_token})


async def asyncio_sleep(seconds):
    import asyncio
    await asyncio.sleep(seconds)


WeChatBot = None
WeChatBotBuilder = None
Agent = None
ChatRequest = None
ChatResponse = None
