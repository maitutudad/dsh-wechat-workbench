"""Minimal fake wechat_agent_sdk for driving the REAL transport.py in tests.

Activated via PYTHONPATH so `import wechat_agent_sdk` resolves here first.
Behavior is scriptable through the FAKE_STATE environment variable (JSON):
  {"needsLogin": bool, "messages": [raw...], "failConnect": bool,
   "mediaBytes": "base64-of-download"}
Side effects are recorded to the file named by FAKE_LOG (JSON lines):
  {"event": "send_text"|"send_media"|"download_media"|"connected", ...}
"""

import base64
import json
import os


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


class MediaInfo:
    def __init__(self, type="image", cdn_param="", aes_key="", aeskey_hex="", file_name=""):
        self.type = type
        self.cdn_param = cdn_param
        self.aes_key = aes_key
        self.aeskey_hex = aeskey_hex
        self.file_name = file_name


class Parsed:
    def __init__(self, conversation_id, text, context_token, message_id="m1",
                 sender_id=None, sender_name=None, group_id=None, is_at_bot=False,
                 media=None):
        self.conversation_id = conversation_id
        self.text = text
        self.context_token = context_token
        self.message_id = message_id
        self.sender_id = sender_id
        self.sender_name = sender_name
        self.group_id = group_id
        self.is_at_bot = is_at_bot
        self.media = media or []


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
        while True:
            import asyncio
            await asyncio.sleep(3600)

    def parse(self, raw):
        if raw is None:
            return None
        media = [
            MediaInfo(
                type=m.get("type", "file"),
                cdn_param=m.get("cdnParam", ""),
                aes_key=m.get("aesKey", ""),
                file_name=m.get("fileName", ""),
            )
            for m in raw.get("media", [])
        ]
        return Parsed(
            conversation_id=raw.get("conversationId", "wxid_test"),
            text=raw.get("text", ""),
            context_token=raw.get("contextToken", "ctx-1"),
            message_id=raw.get("messageId", "m1"),
            group_id=raw.get("groupId"),
            is_at_bot=raw.get("isAtBot", False),
            media=media,
        )

    async def send_text(self, conversation_id, text, context_token=None):
        self.sent.append({"conversationId": conversation_id, "text": text})
        _log({"event": "send_text", "conversationId": conversation_id,
              "text": text, "token": context_token})

    async def download_media(self, media):
        _log({"event": "download_media", "type": media.type,
              "fileName": media.file_name})
        encoded = _state().get("mediaBytes")
        return b"" if not encoded else base64.b64decode(encoded)

    async def send_media(self, chat_id, file_data, media_type, file_name="", context_token=""):
        _log({"event": "send_media", "conversationId": chat_id,
              "mediaType": media_type, "fileName": file_name,
              "bytes": len(file_data), "token": context_token})


WeChatBot = None
WeChatBotBuilder = None
Agent = None
ChatRequest = None
ChatResponse = None
