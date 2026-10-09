# 集成笔记（贡献者必读）

集成 DSH 服务时逐一验证过的事实。改动涉及以下服务的代码前先读，能省一轮
"猜接口 → 运行报错 → 读源码"的循环。

## Loader 与配置

- **Loader 只认大写 `Config` 导出**（`vendor/cordis` `registry.ts`: `Config: plugin.Config`）。只导小写 `config` 时 schema 不挂载、默认值不填充，原始配置直接透传——字段缺失时就是 `undefined.xxx` 崩溃，且静默。
- **patch 层的 `config` 是整体替换**，不是深合并（base bundle patch 头注释明说）。用户 patch 覆盖某行时要写全所需字段，未写的靠 schema 默认值兜底。
- **`insert:` 带 `id` 只对 group 行合法**；对普通行会 warn 后静默跳过。想覆盖普通行的 config，用不带 `insert` 的 `{ id, config }` 条目。
- 同 id 的行被 insert 两次会直接启动崩溃：`duplicate loader entry id`。

## API 形状（session-controller / workspace-controller）

- `sessionController.follow()` 要 **`SessionFollowRequest`**：`{ address: { kind: 'session', sessionId }, maxMessages? }`——不是裸 `sessionId`。宿主读 `address.kind`，传错就是 `Cannot read properties of undefined (reading 'kind')`。
- `sessionController.page()` 需要 `address` + 必填游标 `throughSeq`（来自 follow opening）。只是想读整段日志的话，`ctx.sessionQuery.readSession(sessionId)` 返回 `{ session, events }`，更简单。
- **工作区投影帧**：`workspaceController.follow()` 首帧为
  `{ type: 'baseline', value: { items: WorkspaceView[] } }`，行字段
  `workspaceId / path / title / sessionIds / createdAt / updatedAt`；后续帧是 `upsert / remove / order / archived` 增量。
- **事件词表**（owner-defined 字符串，从源码统计）：`assistant/message`、`assistant/attempt`、`tool/call`、`tool/result`、`tool/ptc-dispatch`、`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`。assistant 正文在 `data.message.content[]`（content blocks，取 `type === 'text'` 的 `text` 拼接）；tool 名在 `data.name`；`turn/end` 原因在 `data.reason.kind`。
- **`userQuestions` 应答器**：`ctx.on('user-questions/request', (request, next) => …)`。返回 `{ answers: [...] }` 即 claim 该请求；不归你管就 `return next()` 落回 GUI。问题自带 `intent.approve` 标注批准选项。

## 工具注册

- `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`（`@deepseek-ai/dsh-tools`）。`defineTool` 会把 `parameters` 编译成 JSON-schema 对象（`{ type: 'object', properties, required }`），注册后断言形状时注意。
- `execute(args, exec)` 里 `exec.agent` / `exec.signal` 可选使用。

## wechat-agent-sdk（iLink 传输）

- **`needs_login` 只看内存**（`not self._client.token`），新进程恒为 True；构造函数不从存储加载 token。
- **`request_login()` 会先加载已存 token**：加载成功时直接返回 `qr_url=""` 的空会话表示"已登录"。必须区分空会话与真二维码——把空会话当真二维码轮询，重启后就陷入"等扫码"死循环，表现是永远连不上但进程活着。
- `check_login` 返回 `LoginResult.status`（`LoginStatus` 枚举：pending / scanned / confirmed / expired / error），不是 `logged_in` 布尔。CONFIRMED 时 SDK 自行持久化 token。
- `send_text(chat_id, text, context_token="")` 的 context_token 可选。
- token 持久化在 `~/.wechat-agent-sdk/accounts.json`（`JsonFileStorage`，`DEFAULT_STATE_DIR`）。
