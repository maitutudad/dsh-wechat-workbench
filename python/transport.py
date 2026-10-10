"""Headless WeChat transport child process for the dsh-wechat-workbench plugin.

Runs the iLink Bot long connection via wechat-agent-sdk's transport layer and
speakes a tiny JSON-line protocol with the parent (the DSH Cordis plugin) on
stdio. The parent owns all decisions; this process only connects, receives,
parses, and sends.

Protocol (one JSON object per line)
-----------------------------------
child -> parent:
  {"op":"login","qrUrl":"..."}          login QR available (scan with WeChat)
  {"op":"ready"}                        long connection established
  {"op":"message","conversationId":"...","senderId":null,"senderName":null,
   "groupId":null,"isAtBot":false,"text":"...","messageId":"..."}
  {"op":"error","message":"..."}        fatal transport error

parent -> child:
  {"op":"start","accountId":"dsh"}      begin login + connect
  {"op":"send","conversationId":"...","text":"..."}   reply to that chat
  {"op":"stop"}                         graceful shutdown
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys

from wechat_agent_sdk import WeChatTransport

# SDK 0.2.1's download goes to GET /c2c?encrypted_query_param=... which the CDN
# answers with 400 even for fresh images; /c2c/download is the fallback shape.
CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c"
from wechat_agent_sdk.api.auth import LoginStatus

logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format="%(asctime)s wechat-transport %(levelname)s %(message)s",
)
logger = logging.getLogger("wechat-transport")

_state: dict[str, WeChatTransport | None] = {"transport": None}
# conversation_id -> last context_token (must be echoed on replies)
_context_tokens: dict[str, str] = {}


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _qr_png_b64(url: str) -> str:
    """Render the login QR as a base64 PNG for the Web detail panel."""
    try:
        import base64
        import io

        import qrcode

        img = qrcode.make(url)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return ""


def _render_qr(url: str) -> None:
    """Print a scannable ASCII QR to stderr (no [qr] extra required)."""
    try:
        import qrcode  # pure-python fallback renderer

        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        qr.print_ascii(out=sys.stderr, invert=True)
    except Exception:
        logger.warning("qrcode lib unavailable; open the URL and scan it: %s", url)


async def _send(conversation_id: str, text: str) -> None:
    transport = _state["transport"]
    if transport is None:
        logger.warning("send before connect ignored")
        return
    token = _context_tokens.get(conversation_id)
    try:
        if token:
            await transport.send_text(conversation_id, text, token)
        else:
            await transport.send_text(conversation_id, text)
    except Exception:
        logger.exception("send_text failed to %s", conversation_id)


async def _send_media(conversation_id: str, path: str, kind: str, file_name: str) -> None:
    """Read a local file and push it to WeChat (image/video/file/voice)."""
    transport = _state["transport"]
    if transport is None:
        logger.warning("sendMedia before connect ignored")
        return
    try:
        with open(path, "rb") as fh:
            data = fh.read()
        token = _context_tokens.get(conversation_id, "")
        if token:
            await transport.send_media(conversation_id, data, kind, file_name, token)
        else:
            await transport.send_media(conversation_id, data, kind, file_name)
    except Exception:
        logger.exception("send_media failed to %s (%s)", conversation_id, path)


def _media_kind(media_type: str) -> str:
    return media_type if media_type in ("image", "video", "voice") else "file"


def _guess_mime(file_name: str) -> str:
    import mimetypes

    guessed = mimetypes.guess_type(file_name)[0]
    return guessed or "application/octet-stream"


async def _cdn_variant_download(media) -> bytes:
    """Direct CDN GET via the /download subpath, decrypting like the SDK."""
    import httpx
    from wechat_agent_sdk.media.crypto import decode_aes_key, decrypt

    url = f"{CDN_BASE}/download?encrypted_query_param={media.cdn_param}"
    async with httpx.AsyncClient() as client:
        resp = await client.get(url, timeout=60.0)
        resp.raise_for_status()
    key = decode_aes_key(media.aes_key, getattr(media, "aeskey_hex", "") or "")
    return decrypt(resp.content, key)


async def _download_bytes(transport, media) -> bytes:
    """SDK download with the /download fallback for SDK 0.2.1's CDN 400s."""
    try:
        return await transport.download_media(media)
    except Exception:
        return await _cdn_variant_download(media)


def _sniff_image_mime(data: bytes) -> str:
    """Map magic bytes to one of the attachment path's accepted image types."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


async def _download_and_save(message_id: str, index: int, media) -> dict | None:
    transport = _state["transport"]
    media_dir = _state.get("media_dir")
    if transport is None or not media_dir:
        return None
    import os

    os.makedirs(media_dir, exist_ok=True)
    file_name = media.file_name or f"{message_id}-{index}.{media.type}"
    safe_name = os.path.basename(file_name) or f"{message_id}-{index}.bin"
    path = os.path.join(media_dir, f"{message_id}-{index}-{safe_name}")
    data = await _download_bytes(transport, media)
    with open(path, "wb") as fh:
        fh.write(data)
    kind = _media_kind(media.type)
    media_type = _guess_mime(safe_name)
    file_name = safe_name
    if kind == "image":
        # WeChat image payloads often carry no extension; the attachment
        # path rejects non-image media types, so sniff the actual bytes.
        sniffed = _sniff_image_mime(data)
        if sniffed != "application/octet-stream":
            media_type = sniffed
            stem, _, ext = safe_name.rpartition(".")
            if not ext or ext.lower() not in ("png", "jpg", "jpeg", "gif", "webp"):
                file_name = f"{stem or 'image'}.{sniffed.rsplit('/', 1)[-1]}"
        elif media_type not in ("image/png", "image/jpeg", "image/webp", "image/gif"):
            # Unknown bytes advertised as an image: keep them as a file part.
            kind = "file"
    return {
        "path": path,
        "fileName": file_name,
        "kind": kind,
        "mediaType": media_type,
        "bytes": len(data),
    }


async def _reader_loop(stop: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    while not stop.is_set():
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:  # parent closed stdin -> shut down
            stop.set()
            return
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("bad json from parent: %r", line[:200])
            continue
        op = msg.get("op")
        if op == "send":
            asyncio.create_task(_send(msg["conversationId"], msg["text"]))
        elif op == "sendMedia":
            asyncio.create_task(
                _send_media(
                    msg["conversationId"],
                    msg["path"],
                    msg.get("kind", "file"),
                    msg.get("fileName", ""),
                )
            )
        elif op in ("start", "stop"):
            if op == "start":
                if msg.get("mediaDir"):
                    _state["media_dir"] = msg["mediaDir"]
            else:
                stop.set()
        else:
            logger.warning("unknown op %r", op)


async def _message_loop(transport: WeChatTransport, stop: asyncio.Event) -> None:
    async for raw in transport.messages():
        if stop.is_set():
            return
        parsed = transport.parse(raw)
        if parsed is None:
            continue
        if parsed.context_token:
            _context_tokens[parsed.conversation_id] = parsed.context_token
        # Download attachments (lazy CDN references) into the media dir.
        media_entries = []
        for index, media in enumerate(parsed.media or []):
            try:
                descriptor = await _download_and_save(
                    parsed.message_id or "m", index, media
                )
                if descriptor:
                    media_entries.append(descriptor)
            except Exception as exc:
                logger.exception("media download failed (%s)", media.type)
                # Surface the failure to the session prompt instead of
                # silently dropping the attachment.
                media_entries.append({
                    "kind": "failed",
                    "fileName": getattr(media, "file_name", "") or "",
                    "mediaType": _media_kind(media.type),
                    "bytes": 0,
                    "error": f"{type(exc).__name__}: {exc}",
                })
        _emit(
            {
                "op": "message",
                "conversationId": parsed.conversation_id,
                "senderId": parsed.sender_id,
                "senderName": parsed.sender_name,
                "groupId": parsed.group_id,
                "isAtBot": parsed.is_at_bot,
                "text": parsed.text or "",
                "messageId": parsed.message_id,
                "media": media_entries,
            }
        )


async def main() -> None:
    stop = asyncio.Event()
    account_id = "dsh"
    transport = WeChatTransport(account_id=account_id)
    _state["transport"] = transport
    # Default media dir up front: inbound messages may be processed before
    # the parent's start op arrives. `start` overrides it when provided.
    import os

    _state["media_dir"] = os.path.join(
        os.path.expanduser("~"), ".dsh-wechat-workbench", "media"
    )

    # Login if needed. `needs_login` only reflects in-memory state, so on a
    # fresh process it is always True; `request_login()` itself loads any
    # stored token and then returns an EMPTY qr_url session meaning
    # "already logged in" — only a non-empty qr_url needs scanning.
    if transport.needs_login:
        session = await transport.request_login()
        if session.qr_url:
            _emit({"op": "login", "qrUrl": session.qr_url, "qrPng": _qr_png_b64(session.qr_url)})
            _render_qr(session.qr_url)
            while True:
                result = await transport.check_login(session)
                if result.status == LoginStatus.CONFIRMED:
                    break
                if result.status == LoginStatus.EXPIRED:
                    # QR expired: issue a fresh one instead of polling forever.
                    logger.info("login QR expired; re-issuing")
                    session = await transport.request_login()
                    if not session.qr_url:
                        break  # a stored token appeared; skip scanning
                    _emit({"op": "login", "qrUrl": session.qr_url, "qrPng": _qr_png_b64(session.qr_url)})
                    _render_qr(session.qr_url)
                elif result.status == LoginStatus.ERROR:
                    logger.warning("login poll error: %s", result.error)
                await asyncio.sleep(2)
        else:
            logger.info("using saved iLink token; no scan needed")

    await transport.connect()
    _emit({"op": "ready"})
    logger.info("iLink long connection established")

    reader = asyncio.create_task(_reader_loop(stop))
    messages = asyncio.create_task(_message_loop(transport, stop))
    done, _ = await asyncio.wait({reader, messages}, return_when=asyncio.FIRST_COMPLETED)
    for task in (reader, messages):
        task.cancel()
    await transport.disconnect()
    for finished in done:
        exc = finished.exception() if not finished.cancelled() else None
        if exc:
            logger.error("loop failed: %s", exc)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:  # noqa: BLE001 - report any fatal to parent
        _emit({"op": "error", "message": str(exc)})
        raise
