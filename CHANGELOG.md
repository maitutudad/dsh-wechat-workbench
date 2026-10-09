# Changelog

## 0.1.0 — 2026-10-08

First release.

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
- Fail-closed authorization (`allowWxids`), group-chat gating with @-mention,
  bootstrap mode that reveals the caller's conversation id.
- Follower degrades to `sessionQuery` polling when the live follow stream
  throws; assistant text extraction follows the canonical
  `data.message.content` block shape.

### Added (unreleased)

- **Media inbound**: WeChat images download to `~/.dsh-wechat-workbench/media/`
  and are inlined into the session prompt as base64 image parts (vision);
  files/voice/video are saved and referenced by path in the prompt text.
- **`wechat_send_file` tool**: any session's agent can push a local file to
  the notification conversation; extension decides image/video/file rendering.
- Renamed from `dsh-wechat-remote` to `dsh-wechat-workbench` — the plugin is a
  second workbench client, not just a remote control. npm name `dsh-wechat-remote`
  was taken by an unrelated package.
