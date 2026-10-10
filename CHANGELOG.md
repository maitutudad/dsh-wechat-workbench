# Changelog

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
