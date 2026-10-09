# 产品化路线与测试指南 — dsh-wechat-remote

## 一、测试（现在就能跑）

### L1/L2：单元 + 假 Context 集成（已就绪）

```sh
cd dsh-wechat-cordis && npm test     # node --test，无任何外部依赖
```

覆盖：命令解析、审批应答匹配（序号/标签/y/n/自定义）、事件摘要、指针持久化与损坏容错，以及完整导航流 `/ws → /cd → /ss → /ss <n> → 发消息 → follow 流推送最终回复`、无指针自动建会话、应答器 claim/回退规则。假 `sessionController`/`workspaceController` 按 `packages/api/session-controller` 的真实签名实现。

### L3：真实 DSH runtime + 假微信（半联调，无需灰度账号）

1. **传输子进程单测**：直接管道驱动 `python/transport.py`（不连 iLink，mock `WeChatTransport`）：

   ```sh
   echo '{"op":"start"}' | python3 python/transport.py   # 观察 login/ready 协议帧
   ```

   正式做法：为 transport.py 抽一个 `FakeTransport`（emit 预置 message、记录 send_text），与真实实现同接口，供 CI 使用。

2. **装进源码 profile 跑通**：`dsh plugin --profile web add file:...` 后 `dsh --profile web`，重点核对两个防御式解析点（README「已知限制」）：
   - `/ws` 是否列出工作区 → 不行则按 `packages/api/workspace-controller` 投影类型修 `workspacesFrom()`
   - 发一条消息，看日志中 follow 帧的 `type` 词表 → 修 `summarizeEvent()` 的工具匹配

3. **本地闭环**：用一个假的 python transport（stdin 触发 `{"op":"message",...}`）+ 真实 runtime，模拟微信完整来回，不依赖微信灰度。

### L4：真实微信 E2E（需灰度账号）

Checklist：
- [ ] 扫码绑定 → 重启 DSH 自动重连（token 持久化）
- [ ] `/ws` `/cd` `/ss` `/new` `/tail` 全命令
- [ ] GUI 与微信同会话交叉对话，双方实时可见
- [ ] ask_user_question 从微信 y/n 回答；GUI 会话的问题不进微信
- [ ] 杀掉 python 子进程 → 自动重启恢复
- [ ] 非白名单 wxid 发消息被拒
- [ ] 群聊 @/非 @、未开 allowGroups 的行为
- [ ] 长任务：进展节流推送 + 最终回复 + 超长回复分段

## 二、产品化路线

### P0 — 稳定性（当前 → 可用）
- [ ] transport.py 接口化 + FakeTransport 进 CI；把 L3 闭环脚本化
- [ ] 混沌：iLink 断连/半开、DSH 重启时序（指针落盘 vs follower 泄漏）
- [ ] answerer 超时/竞争的边界（并发多问题、会话切换时 pending 清理）

### P1 — 分发与安装体验
- [ ] 发布 npm：`dsh plugin --profile X add dsh-wechat-remote` 一条命令装
- [ ] Python 依赖自管理：首次启动自动建 venv 并 `pip install wechat-agent-sdk[qr]`，免手工前置
- [ ] 版本对齐策略：锁上游 SDK 版本；iLink 协议变更只需升级依赖 + 跑回归

### P2 — 安全与多用户
- [ ] 多微信账号绑定（设备绑定管理、解绑命令 `/unbind`）
- [ ] 审计：记录"哪个 wxid 在何时对哪个 session 发了什么/批了什么"，写入 DSH 审计日志
- [ ] 敏感操作策略：可配置"微信端禁止的命令/工具名单"，双重确认
- [ ] 指令限速与配额（防刷）

### P3 — 体验增强
- [ ] 媒体通道：`download_media` → prompt 附件；DSH 产物（图片/文件）回传微信
- [ ] `/search`：接 `ctx.sessionQuery` 的 SQLite FTS5 全文检索
- [ ] 会话切换栈（`/back`）、多指针并行、语音转写直通
- [ ] 长回复排版优化（markdown 剥离策略已有，增加代码块折叠）

### P4 — 运营
- [ ] 遥测接入 DSH telemetry（连接时长、消息量、审批超时率）
- [ ] 功能开关（profile 配置粒度）与灰度
- [ ] 上游监控：wechat-agent-sdk 发版 diff review 流程
