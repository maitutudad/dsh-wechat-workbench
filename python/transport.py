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
  {"op":"sendResult","id":"...","ok":true}          text send ack (failure carries "error")
  {"op":"sendMediaResult","id":"...","ok":true}     media send ack (failure carries "error")
  {"op":"error","message":"..."}        fatal transport error

parent -> child:
  {"op":"start","accountId":"dsh"}      begin login + connect
  {"op":"send","id":"...","conversationId":"...","text":"..."}   reply; ack via sendResult
  {"op":"sendMedia","id":"...","conversationId":"...","path":"...",
   "kind":"image|video|file|voice","fileName":"..."}            ack via sendMediaResult
  {"op":"stop"}                         graceful shutdown
"""

from __future__ import annotations

import asyncio
import base64 as _b64
import json
import logging
import mimetypes
import sys

from wechat_agent_sdk import WeChatTransport
from wechat_agent_sdk.media.cdn import upload_media as _sdk_upload_media

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


def _qr_svg_b64(url: str) -> str:
    """Render the login QR as a base64 inline SVG (no Pillow dependency)."""
    try:
        import base64

        import qrcode

        qr = qrcode.QRCode(border=2)
        qr.add_data(url)
        qr.make(fit=True)
        matrix = qr.get_matrix()
        n = len(matrix)
        parts = []
        for y, row in enumerate(matrix):
            for x, on in enumerate(row):
                if on:
                    parts.append(f"M{x} {y}h1v1h-1z")
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" '
            f'shape-rendering="crispEdges"><path d="{"".join(parts)}"/></svg>'
        )
        return base64.b64encode(svg.encode()).decode()
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


async def _send(conversation_id: str, text: str, ack_id: str = "") -> None:
    """Send one text; ack the parent with ok/error so failures are visible."""
    transport = _state["transport"]
    if transport is None:
        logger.warning("send before connect ignored")
        if ack_id:
            _emit({"op": "sendResult", "id": ack_id, "ok": False, "error": "not connected"})
        return
    token = _context_tokens.get(conversation_id)
    try:
        if token:
            await transport.send_text(conversation_id, text, token)
        else:
            await transport.send_text(conversation_id, text)
        if ack_id:
            _emit({"op": "sendResult", "id": ack_id, "ok": True})
    except Exception as exc:
        logger.exception("send_text failed to %s", conversation_id)
        if ack_id:
            _emit({"op": "sendResult", "id": ack_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"})


async def _send_media(conversation_id: str, path: str, kind: str, file_name: str, ack_id: str = "") -> None:
    """Read a local file and push it to WeChat (image/video/file/voice).

    Every failure is reported to the parent (sendMediaResult ok=false): the
    old behavior logged to stderr only, so a failed upload surfaced to the
    user as a tool result claiming success while nothing arrived on WeChat.
    """
    transport = _state["transport"]

    def _fail(reason: str) -> None:
        logger.error("send_media failed to %s (%s): %s", conversation_id, path, reason)
        if ack_id:
            _emit({"op": "sendMediaResult", "id": ack_id, "ok": False, "error": reason})

    if transport is None:
        _fail("not connected")
        return
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except Exception as exc:
        _fail(f"read failed: {type(exc).__name__}: {exc}")
        return
    try:
        token = _context_tokens.get(conversation_id, "")
        transport = _state["transport"]
        http_client = await transport.client._ensure_client()
        # SDK upload (encrypt + getuploadurl + CDN POST) is protocol-correct;
        # only its item builder encodes aes_key wrong (see _build_media_item).
        cdn_info = await _sdk_upload_media(
            bot_client=transport.client,
            http_client=http_client,
            to_user_id=conversation_id,
            file_data=data,
            media_type={"image": 1, "video": 2, "file": 3, "voice": 4}.get(kind, 3),
            file_name=file_name,
        )
        import hashlib as _hashlib
        # PKCS7 padded ciphertext size (always at least one extra block byte):
        # matches what cdn_upload sends as `filesize` without re-encrypting.
        cdn_info["filesize"] = (len(data) // 16 + 1) * 16
        item = _build_media_item(kind, cdn_info, file_name,
                                 raw_size=len(data), raw_md5=_hashlib.md5(data).hexdigest())
        await transport.client.send_media_message(conversation_id, item, token or "")
        if ack_id:
            _emit({"op": "sendMediaResult", "id": ack_id, "ok": True})
    except Exception as exc:
        # The SDK logs and swallows some server-side rejections; the ack makes
        # the remaining real failures (upload, crypto, HTTP) caller-visible.
        _fail(f"{type(exc).__name__}: {exc}")


def _media_kind(media_type: str) -> str:
    return media_type if media_type in ("image", "video", "voice") else "file"


def _guess_mime(file_name: str) -> str:
    guessed = mimetypes.guess_type(file_name)[0]
    return guessed or "application/octet-stream"


def _build_media_item(media_type: str, cdn_info: dict, file_name: str = "", raw_size: int = 0, raw_md5: str = "") -> dict:
    """Build a sendmessage item the receiving WeChat client can actually use.

    Cross-checked against two independent working implementations
    (photon-hq/wechat-ilink-client, reverse-engineered from Tencent's
    openclaw-weixin; and lith0924/wechat-ilink-sdk-java):
      - media.aes_key is base64(hex 32 chars) for EVERY type
      - file_item carries file_name + len (plaintext size, string) + md5
      - image_item carries mid_size (ciphertext size) and the top-level hex
        aeskey real inbound messages carry
      - video_item carries video_size (ciphertext size)
    SDK 0.2.1's own builder encodes aes_key as base64(raw 16 bytes) for all
    types and adds none of the size fields: the server accepts the message
    (HTTP 200 + message_id), the bubble arrives, but the client cannot use
    the file — WeChat renders that as 已过期/无法下载.
    """
    raw_key = _b64.b64decode(cdn_info["aes_key"])  # 16 bytes
    media_ref = {
        "encrypt_query_param": cdn_info["encrypt_query_param"],
        "aes_key": _b64.b64encode(raw_key.hex().encode()).decode(),
        "encrypt_type": cdn_info.get("encrypt_type", 1),
    }
    if media_type == "image":
        return {
            "type": 2,
            "image_item": {
                "media": media_ref,
                "aeskey": raw_key.hex(),
                "mid_size": cdn_info.get("filesize"),
            },
        }
    if media_type == "video":
        return {"type": 5, "video_item": {"media": media_ref, "video_size": cdn_info.get("filesize")}}
    if media_type == "voice":
        return {"type": 3, "voice_item": {"media": media_ref}}
    item = {
        "type": 4,
        "file_item": {
            "media": media_ref,
            "file_name": file_name,
            "len": str(raw_size),
        },
    }
    if raw_md5:
        item["file_item"]["md5"] = raw_md5
    return item


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
            asyncio.create_task(_send(msg["conversationId"], msg["text"], msg.get("id", "")))
        elif op == "sendMedia":
            asyncio.create_task(
                _send_media(
                    msg["conversationId"],
                    msg["path"],
                    msg.get("kind") or msg.get("mediaType") or "file",
                    msg.get("fileName", ""),
                    msg.get("id", ""),
                )
            )
        elif op == "logout":
            # Clear the stored iLink token, then exit; the parent restarts the
            # child and the next start needs a fresh QR scan.
            async def _logout_and_exit():
                transport = _state["transport"]
                try:
                    if transport is not None:
                        await transport.logout()
                except Exception:
                    logger.exception("logout failed")
                _emit({"op": "logged-out"})
                stop.set()
            asyncio.create_task(_logout_and_exit())
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

    # Parent-death watchdog: a host that exits without sending `stop` (failed
    # startup, kill -9) must not leave this child polling forever. Reparenting
    # to launchd/init (ppid -> 1) means the parent is gone.
    import os

    parent_pid = os.getppid()

    async def _watch_parent() -> None:
        while not stop.is_set():
            await asyncio.sleep(2)
            if os.getppid() != parent_pid:
                logger.warning("parent process gone; exiting")
                stop.set()
                os._exit(0)

    asyncio.create_task(_watch_parent())
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
            _emit({"op": "login", "qrUrl": session.qr_url, "qrSvg": _qr_svg_b64(session.qr_url)})
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
                    _emit({"op": "login", "qrUrl": session.qr_url, "qrSvg": _qr_svg_b64(session.qr_url)})
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
