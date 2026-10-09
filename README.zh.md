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

```sh
# 从 GitHub 直装（纯 ESM JS，无需构建授权）
dsh plugin --profile web add github:<you>/dsh-wechat-workbench

# 或从 npm
dsh plugin --profile web add dsh-wechat-workbench
```

准备 Python 环境（iLink 传输子进程依赖）：

```sh
cd <插件目录>
./scripts/setup-python.sh    # 创建 .venv 并安装 wechat-agent-sdk + qrcode
```

配置 `$DSH_HOME/profiles/web/cordis.patch.yml`。⚠️ **patch 语义**：不带 `insert` 的条目按 id 定向覆盖已有行，且 `config` 是**整体替换不是合并**：

```yaml
- id: wechat-workbench
  config:
    pythonBin: /abs/path/to/.venv/bin/python
    allowWxids: ['o9cq8xxxx@im.wechat']   # 空白名单 = 拒绝所有人（fail-closed）
    bootstrap: true                        # 首次开启：发消息即回复你的会话 id
    approvalMode: 'all'                    # 离席时所有会话的审批都推微信
```

启动 `dsh --profile web`，终端会出现登录二维码（或链接，用微信打开），扫码绑定；给机器人发任意消息拿到会话 id 填入 `allowWxids`，再把 `bootstrap` 改为 `false`。`patchReload: live` 的 profile 下配置改动保存即热生效。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `allowWxids` | `[]` | 授权名单；**空 = 全部拒绝** |
| `allowGroups` | `false` | 群聊响应（白名单发送者需 @机器人） |
| `bootstrap` | `false` | 引导模式：只回复来信号 id，不执行任何指令 |
| `approvalMode` | `wechat-driven` | `'all'` = 离席时所有会话的审批推微信 |
| `idleAwayMinutes` | `5` | 键鼠空闲判定离席的分钟数 |
| `pythonBin` | `python3` | 传输子进程解释器 |
| `accountId` | `dsh` | iLink token 持久化键 |
| `answerTimeoutMs` | `600000` | 微信审批超时后回退 GUI |

## 安全模型

- **fail-closed**：白名单为空时插件只打日志、拒绝一切；未授权发送者仅收到一条拒绝提示。
- 审批问题只在"会话由微信驱动"（或 `'all'` 模式下离席）时由微信应答，其余走 `next()` 落回 GUI。
- iLink token 存于 `~/.wechat-agent-sdk/`；`python/transport.py` 里的 `logout()` 可清除。
- 无云端组件：消息经 iLink 直达本机，DSH 全部本地执行。

## 开发

```sh
npm test    # 26 个测试，无外部依赖
```

包含针对 DSH 真实服务形状的合同测试（`SessionFollowRequest.address`、工作区 baseline 帧、`sessionQuery.readSession`、`user-questions/request` waterfall），以及用假 `wechat_agent_sdk` 模块驱动真实 `python/transport.py` 的协议测试。

贡献者向的集成笔记（服务请求形状、事件词表、Loader 约定、SDK 行为）见 [docs/INTEGRATION-NOTES.zh.md](docs/INTEGRATION-NOTES.zh.md)。

## 已知限制

- iLink Bot 通道处于灰度，协议变更收敛在 `wechat-agent-sdk` 依赖里，升级即可。
- 入站图片内联上限为 DSH 的 20 MiB 图片摄入限制；超大图与其他文件保存到
  `~/.dsh-wechat-workbench/media/`，以路径形式告知 Agent 的 fs 工具。
- 语音消息以转写文本进入会话，音频本体作为文件附件保存。
- 实时 follow 流异常时自动降级为 3 秒 `sessionQuery` 轮询，最终回复仍会送达。

## License

[MIT](LICENSE)。iLink 传输依赖 [wechat-agent-sdk](https://github.com/AIhubmix/wechat-agent-sdk)（MIT）。
