"""Headless WeChat transport child process for the dsh-wechat-remote plugin.

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
        elif op in ("start", "stop"):
            if op == "stop":
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
            }
        )


async def main() -> None:
    stop = asyncio.Event()
    account_id = "dsh"
    transport = WeChatTransport(account_id=account_id)
    _state["transport"] = transport

    # Login if needed. `needs_login` only reflects in-memory state, so on a
    # fresh process it is always True; `request_login()` itself loads any
    # stored token and then returns an EMPTY qr_url session meaning
    # "already logged in" — only a non-empty qr_url needs scanning.
    if transport.needs_login:
        session = await transport.request_login()
        if session.qr_url:
            _emit({"op": "login", "qrUrl": session.qr_url})
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
                    _emit({"op": "login", "qrUrl": session.qr_url})
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
