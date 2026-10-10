# dsh-wechat-workbench — 微信远程工作台

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness)（DSH）的 Cordis 插件：通过微信官方开放的 **iLink Bot 长连接**，把微信变成 DSH 工作台的**第二个客户端**。在手机上浏览工作区、切换/新建会话、续聊、看进展推送、审批 Agent 提问。操作的是与 Web GUI 完全相同的持久会话，不做任何复制。

架构与能力总览见[英文 README](README.md#what-it-does)。

## 微信命令

| 命令 | 作用 |
|---|---|
| `/ws` | 列出工作区 |
| `/cd <n>` | 切换当前工作区 |
| `/ss` | 列出当前工作区的会话 |
| `/ss <n>` | 切换到该会话续聊 |
| `/new [标题]` | 在当前工作区新建会话 |
| `/tail [n]` | 查看当前会话最近 n 条记录 |
| `/info` | 当前指针与通道状态 |
| `/atdesk on\|off\|auto` | 在席检测覆盖 / 状态 |
| 直接发文字 | 向当前会话发送 follow-up（GUI 同一时间线实时可见） |

> **媒体**：微信发的图片会下载后内联进会话（Agent 直接"看图"）；文件落盘到 `~/.dsh-wechat-workbench/media/` 并以路径告知 Agent。Agent 可用 `wechat_send_file` 工具把本地文件（图片/视频/文档）回发到你的微信，`wechat_notify` 可随时主动推送通知。

## 安装

较新版本的 DSH 在 Web 工作台内置插件管理页（「插件」面板）：支持按本地绝对路径
（开发）、git 地址或 npm 包名安装与启停。本插件自带一个轻量浏览器伴侣包
（`client/client.js`，经 package.json 的 `dsh.client` 声明装载），因此：插件详情页
会出现「配置」按钮（表单保存即热生效），并显示微信登录二维码与连接状态。
微信内 `/config` 命令同样可改；两者写同一层 profile patch。

等价的 CLI（纯 ESM JS，无需构建）：

```sh
dsh plugin --profile web add github:<you>/dsh-wechat-workbench   # 从 GitHub
dsh plugin --profile web add dsh-wechat-workbench                 # 从 npm（发布后）
```

准备 Python 环境（iLink 传输子进程依赖）：

```sh
cd <插件目录>
./scripts/setup-python.sh    # 创建 .venv 并安装 wechat-agent-sdk + qrcode
```

如需绕过 UI 手工配置，编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`。⚠️ **patch 语义**：不带 `insert` 的条目按 id 定向覆盖已有行，且 `config` 是**整体替换不是合并**：

```yaml
- id: wechat-workbench
  config:
    pythonBin: /abs/path/to/.venv/bin/python
    allowWxids: ['o9cq8xxxx@im.wechat']   # 空白名单 = 拒绝所有人（fail-closed）
    bootstrap: true                        # 首次开启：发消息即回复你的会话 id
    approvalMode: 'all'                    # 离席时所有会话的审批都推微信
```

### 首次运行（绑定微信、授权自己）

1. 先开 `bootstrap: true` —— 工作台「插件」表单里改，或手工加：
   ```yaml
   - id: wechat-workbench
     config:
       bootstrap: true
   ```
2. 启动（或重启）profile：`dsh --profile web`。「插件」面板的本插件详情页会显示
   登录二维码（终端也会打印）；用微信扫码（或用微信打开链接）。iLink 令牌持久化在
   `~/.wechat-agent-sdk/`，之后重启免扫码自动重连。
3. 在微信里给机器人发任意消息。引导模式会回复你的会话标识
   （`wxid_...@im.wechat` 字符串）。
4. 把它填进 `allowWxids`，并关掉 `bootstrap` —— 「插件」表单里改，或微信内
   `/config allowWxids <标识>` + `/config bootstrap false`，或手工改。三种方式写同一层
   patch、保存即热生效。至此你是唯一授权用户。

`patchReload: live` 的 profile 下配置改动保存即热生效。

## 配置项

| 键 | 默认 | 即时 | 说明 |
|---|---|---|---|
| `allowWxids` | `[]` | ✎ | 授权名单；**空 = 全部拒绝** |
| `allowGroups` | `false` | ✎ | 群聊响应（白名单发送者需 @机器人） |
| `bootstrap` | `false` | ✎ | 引导模式：只回复来信号 id，不执行任何指令 |
| `approvalMode` | `wechat-driven` | ✎ | `'all'` = 离席时所有会话的审批推微信 |
| `idleAwayMinutes` | `5` | ✎ | 键鼠空闲判定离席的分钟数 |
| `pythonBin` | `python3` | ↻ | 传输子进程解释器（重启生效） |
| `accountId` | `dsh` | ↻ | iLink token 持久化键（重启生效） |
| `answerTimeoutMs` | `600000` | ✎ | 微信审批超时后回退 GUI |

✎ 为 volatile 字段：「插件」表单 / 微信 `/config` / 手工 patch 任一方式改完即时生效，无需重启；↻ 字段重启后生效。

## 安全模型

- **fail-closed**：白名单为空时插件只打日志、拒绝一切；未授权发送者仅收到一条拒绝提示。
- 审批问题只在"会话由微信驱动"（或 `'all'` 模式下离席）时由微信应答，其余走 `next()` 落回 GUI。
- iLink token 存于 `~/.wechat-agent-sdk/`；`python/transport.py` 里的 `logout()` 可清除。
- 无云端组件：消息经 iLink 直达本机，DSH 全部本地执行。

## 开发

```sh
npm test    # 31 个测试，无外部依赖
```

包含针对 DSH 真实服务形状的合同测试（`SessionFollowRequest.address`、工作区 baseline 帧、`sessionQuery.readSession`、`user-questions/request` waterfall），以及用假 `wechat_agent_sdk` 模块驱动真实 `python/transport.py` 的协议测试。

贡献者向的集成笔记（服务请求形状、事件词表、Loader 约定、SDK 行为）见 [docs/INTEGRATION-NOTES.zh.md](docs/INTEGRATION-NOTES.zh.md)。

## 已知限制

- iLink Bot 通道处于灰度，协议变更收敛在 `wechat-agent-sdk` 依赖里，升级即可。
- `wechat-agent-sdk` 0.2.1 的 CDN 下载请求形状对新鲜图片也可能返回 `400`，此时会话里会记录
  一条明确的 `[媒体接收失败]` 说明而不是附件本身；上游修复后升级依赖即可恢复。
- 入站图片内联上限为 DSH 的 20 MiB 图片摄入限制；超大图与其他文件保存到
  `~/.dsh-wechat-workbench/media/`，以路径形式告知 Agent 的 fs 工具。
- 语音消息以转写文本进入会话，音频本体作为文件附件保存。
- 实时 follow 流异常时自动降级为 3 秒 `sessionQuery` 轮询，最终回复仍会送达。

## License

[MIT](LICENSE)。iLink 传输依赖 [wechat-agent-sdk](https://pypi.org/project/wechat-agent-sdk/)（MIT，PyPI 分发）。
