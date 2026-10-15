"""Fake of wechat_agent_sdk.media.cdn for the protocol tests.

Mirrors the real upload_media contract: takes the bot client, the raw bytes
and the integer media type, returns a CDN reference dict. The REAL module's
contract is protocol-correct (encrypt + getuploadurl + CDN POST); the bug
this fake helps pin down lives in item building, which the plugin now owns.
"""

from __future__ import annotations

import base64
import json
import os


def _log(event):
    path = os.environ.get("FAKE_LOG")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, ensure_ascii=False) + "\n")


# A fixed 16-byte key so tests can assert both encodings deterministically.
FAKE_RAW_KEY = bytes(range(16))


async def upload_media(bot_client, http_client, to_user_id, file_data, media_type, file_name=""):
    _log({
        "event": "upload_media",
        "conversationId": to_user_id,
        "mediaType": media_type,  # int: 1=image 2=video 3=file 4=voice
        "fileName": file_name,
        "bytes": len(file_data),
    })
    return {
        "encrypt_query_param": "fake-cdn-param",
        "aes_key": base64.b64encode(FAKE_RAW_KEY).decode(),
        "encrypt_type": 1,
    }
