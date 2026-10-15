# Changelog

## 0.1.1 — 2026-10-14

Three fixes confirmed against live session logs (`~/.dsh/sessions`):

- **ask_user_question now reaches WeChat even while the Web GUI is open.**
  The host's api-remotes forwarder registers its `user-questions/request`
  listener before any plugin, so a browser with the session open claimed
  every question first; WeChat only saw the `🔧 ask_user_question` progress
  line (live case: question at 15:45 answered in the GUI at 22:45). The
  answerer now registers with `{ prepend: true }`: WeChat-driven sessions
  (and `'all'`-mode away approvals) are claimed before the forwarder, and
  `next()` keeps the GUI fallback on timeout exactly as before. The
  WeChat-driven session set is durable (`driven-sessions.json`), so a hot
  plugin reload no longer silently hands questions back to the GUI.
- **`wechat_send_file` reports real delivery.** The old flow returned
  success once the op was queued to the child's stdin; a failed CDN
  upload/download logged to stderr only and the user received nothing (live
  case: tool said "File delivered", WeChat never got the .md). Sends now
  carry an `id` and the child answers `sendResult`/`sendMediaResult`
  (ok/error); the tool awaits the ack, reports failures with the reason,
  and pushes a WeChat text fallback carrying the local path. Text send
  failures are logged loudly too.
- **Media sends are actually delivered now.** Root cause of the silent drop:
  SDK 0.2.1's `_build_media_item` emits `aes_key = base64(raw 16 bytes)` for
  every type and omits all size metadata. Working reference implementations
  (photon-hq/wechat-ilink-client, reverse-engineered from Tencent's
  openclaw-weixin; lith0924/wechat-ilink-sdk-java) build the item as:
  `aes_key = base64(hex 32 chars)` for EVERY type, file_item + `len`
  (plaintext size, string) + `md5`, image_item + `mid_size` (ciphertext
  size) + top-level hex `aeskey`, video_item + `video_size` — and always
  send with a fresh context_token. Without these the server accepts the
  sendmessage (HTTP 200 + message_id) and either drops the bubble or shows
  已过期/无法下载 on tap. The plugin now builds the item itself and prefers
  the newest cached context_token. A/B-verified live: only the
  hex32-encoded file arrives.
- **Progress lines carry tool-call content.** `tool/call` events include the
  raw `arguments` JSON string; summaries now digest it per tool (bash's
  description/command, file paths, search queries, an ask_user_question's
  first question, …), single-line, capped at ~90 chars — a long task's
  progress reads like `🔧 bash · 跑测试` instead of `🔧 bash`.

## 0.1.0 — 2026-10-08

First release. Developed as `dsh-wechat-remote`, renamed before publishing:
the plugin is a second workbench client, not just a remote control, and the
npm name `dsh-wechat-remote` was taken by an unrelated package.

- WeChat ⇄ DSH workbench bridge over the iLink Bot long connection
  (community `wechat-agent-sdk` transport child, supervised with backoff).
- Workbench navigation from WeChat: `/ws`, `/cd`, `/ss`, `/new`, `/tail`,
  `/info`; free text is an ordinary follow-up prompt on the pointed session.
- Per-conversation pointer (`{workspaceId, sessionId}`) persisted under
  `$DSH_HOME/wechat-workbench/`; WeChat and the Web GUI share the same durable
  sessions bidirectionally.
- Progress + final-reply push for WeChat-initiated turns only (GUI turns stay
  silent); tool summaries throttled to one line per 15 s.
- Approval channel on the `user-questions/request` waterfall:
  `approvalMode: 'wechat-driven' | 'all'`, structured answers
  (index / label / y / n / custom), timeout fallback to the GUI.
- Automatic at-desk detection (macOS `ioreg`, Linux `xprintidle`) switching
  the approval channel by keyboard/mouse idle; `/atdesk on|off|auto` override.
- `wechat_notify` tool: any session's agent can proactively push a message to
  the notification conversation.
- **Media inbound**: WeChat images download to `~/.dsh-wechat-workbench/media/`
  and are inlined into the session prompt as base64 image parts (vision);
  files/voice/video are saved and referenced by path in the prompt text.
- **`wechat_send_file` tool**: any session's agent can push a local file to
  the notification conversation; extension decides image/video/file rendering.
- Fail-closed authorization (`allowWxids`) and bootstrap mode that reveals
  the caller's conversation id; group chats are out of scope (dropped).
- Follower degrades to `sessionQuery` polling when the live follow stream
  throws; assistant text extraction follows the canonical
  `data.message.content` block shape.
- `/ss` and `/info` show session titles from the list projection
  (`projections.values.title`); `/info` also names the workspace and reports
  the approval-channel state.
- Volatile config fields (`allowWxids`, `bootstrap`,
  `approvalMode`, `idleAwayMinutes`, `answerTimeoutMs`) edit live over
  WeChat through the new `/config` command (list, set, `+item`/`-item`
  array edits), which writes the profile patch through the Host settings
  service; `pythonBin`/`accountId` apply on restart. A Web plugin-manager
  config form would need a client-side companion registering the
  `plugins.row.config` slot — documented as not shipped.
- Media download failures surface as an explicit `[媒体接收失败]` note in
  the session prompt, with a `/c2c/download` retry variant against
  `wechat-agent-sdk` 0.2.1's CDN `400`s; inbound images sniff their magic
  bytes so extension-less WeChat payloads map to an accepted image type.
- Browser companion (`client/client.js`, declared by `dsh.client`): the
  「插件」 bundle page renders the configuration form inline
  (`plugins.bundle.config`) with the row 「配置」 control beside it, and the
  detail page shows the WeChat login QR and connection status from the
  authenticated `/api/wechat-workbench/status` route.
- Python environment self-management: with the default `pythonBin`, the
  first start creates the plugin's `.venv` and installs from PyPI
  (configurable `pipIndexUrl` mirror; `autoSetupPython: false` opts out) —
  no manual setup step.
