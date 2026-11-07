# 对 Agent 的界面设计

Bot 和 worker agent 之间有两条路：**Onlyne 消息**（异步，事件驱动）和 **工具调用**（同步，Bot 主动发起）。这两条路分开设计，不混用。

---

## 一、Onlyne 消息协议（worker → Bot 方向）

Worker 通过 Onlyne P2P 向 Bot 发送结构化消息。Bot 的 `onlyneInbox` Extension 收到后调用 `pi.sendUserMessage()` 注入主 Bot 对话。

消息格式统一：

```typescript
type WorkerMessage =
  | { kind: "pr_submitted";   prId: string; branch: string; worktree: string; issueId: string }
  | { kind: "progress";       prId: string; message: string; percentDone?: number }
  | { kind: "blocked";        prId: string; reason: string; needsHuman: boolean }
  | { kind: "test_result";    prId: string; passed: number; failed: number; log: string }
  | { kind: "ready_to_merge"; prId: string }
```

Bot 注入对话时用固定格式，不让 Bot 猜：

```
[Worker worker-2] PR #14 (fix/auth-bug) ready for review.
Branch: fix/auth-bug  ·  Worktree: /sandboxes/worker-2
Issue: #42

Test results: 47 passed, 0 failed.
Run `bdfl_review("pr-14")` to open the review workflow.
```

**设计原则**：消息里告诉 Bot 下一步该调什么工具，不让 Bot 自己推断。`needsHuman: true` 的 blocked 消息会额外触发 Tern 的 attention bell。

---

## 二、Bot 工具集（`bdflTools` 组件注册的 OMP custom tools）

Bot 通过这些工具主动操作 worker 和沙箱。工具名全部 `bdfl_` 前缀，和其他工具区分开。

### `bdfl_dispatch(issue)`

派发一个新任务给 worker。

```typescript
bdfl_dispatch({
  issueId: string,    // GitHub issue number 或自定义 ID
  branch: string,     // worker 应该创建的分支名
  instructions: string, // 任务说明（会成为 worker 的初始 prompt）
  sandboxKind?: "orbstack" | "docker" | "cloud",  // 默认 orbstack
})
```

返回：`{ workerId: string, sandboxId: string, leaseId: string }`

内部行为：
1. 通过 sandbox-broker 申领沙箱（`acquire`），`kind: <worker>`
2. 向沙箱内启动 OMP agent（`agent-in-sandbox` 形态）
3. 发送初始 prompt，包含 issue 内容和任务约束
4. 在 PR 记录表里写入 `WORKING` 状态

### `bdfl_review(prId)`

开始审查一个 PR。打开 Bot 控制台的 Review tab。

```typescript
bdfl_review({
  prId: string,
})
```

返回：review 结果 sheet 或 inline 摘要

内部行为：
1. 通过 sandbox-broker 申领主会话沙箱（`acquire`，`kind: <main>`）
2. 在沙箱内 SSH exec：`git fetch && git checkout <branch> && bun test`
3. 把测试结果和截图放进 review overlay（通过 pi-tui NativeNode 渲染）
4. PR 状态迁移到 `REVIEW`

### `bdfl_merge(prId, message?)`

合并 PR，释放沙箱，关闭 worker。

```typescript
bdfl_merge({
  prId: string,
  commitMessage?: string,
})
```

前置：PR 必须处于 `REVIEW` 状态。
内部行为：git merge → sandbox release → worker sandbox destroy → PR 状态 `MERGED`。

### `bdfl_reject(prId, feedback)`

打回 PR，发送反馈给 worker，进入新一轮。

```typescript
bdfl_reject({
  prId: string,
  feedback: string,  // 会通过 Onlyne 发给 worker agent
})
```

内部行为：sandbox release → Onlyne 消息发给 worker → PR 状态 `WORKING`。

### `bdfl_status()`

列出所有活跃工作的快照。返回 inline 渲染，不需要 overlay。

```
Active workers (2):
  worker-2  fix/auth-bug  ·  WORKING  14m  ·  47% done
  worker-3  feat/cache    ·  REVIEW ★  ·  waiting for you

Sandboxes (3):
  main-sandbox   RUNNING  TTL 2h47m
  worker-2-sb    RUNNING  TTL 1h52m
  worker-3-sb    RUNNING  TTL 1h12m  ← review sandbox
```

### `bdfl_send(workerId, message)`

直接向 worker agent 发消息（通过 Onlyne）。用于中途调整任务方向。

---

## 三、Worker Agent 收到的上下文注入

Worker 在沙箱里启动时，Bot 会构造一个 `APPEND_SYSTEM.md` 注入到 worker 的 OMP 会话，内容是这次任务的约束：

```markdown
# Task Context (injected by Tern-Bot BDFL)

You are working on: fix/auth-bug
Issue: #42 — Fix JWT token expiry not being handled in auth middleware
Repository: github.com/you/your-project
Your git branch: fix/auth-bug (already created for you)
Working directory: /workspace (mounted from bot worktree snapshot)

## Rules
- NEVER push to main. Only push to your branch (fix/auth-bug).
- When done, submit a PR and send a completion message via Onlyne:
  `await plugins["onlyne"].msg({ delivery_kind: "chat", msg: "pr_submitted: fix/auth-bug", meta: { to: "<bot_node_id>" } })`
- If blocked, send a message immediately. Don't spin.
- You have SSH access to this sandbox only. Do not attempt to access the host machine.

## Bot contact
Bot node ID: <bot_node_id>
Reply to this thread: <thread_id>
```

这段内容的关键：告诉 worker 怎么联系 Bot（Onlyne node ID + thread），以及完成后用什么格式汇报。Worker 不需要知道 Bot 的 OMP session ID，只需要知道 Onlyne 地址。

---

## 四、上下文注入的三段设计（对 Bot 自己）

Bot 自己的 `tavernHarness` 在组装 prompt 时，冻结中缀里会包含当前活跃工作的摘要，这样 Bot 随时都知道情况，不需要每次调 `bdfl_status()`：

**冻结中缀示例内容**（每次 compaction 后由 `session.compacting` 钩子刷新）：

```xml
<active-work>
  Workers: 2 active
  - worker-2: fix/auth-bug (WORKING, 14m)
  - worker-3: feat/cache (REVIEW, waiting since 3m)
  
  Action needed: PR #15 (feat/cache) is ready for review.
  Run bdfl_review("pr-15") when ready.
</active-work>
```

**Author Note 内容**（每隔几轮由 `ctx.setInterval` 刷新写入 APPEND_SYSTEM.md）：

```xml
<current-env>
  Time: 2026-11-07 14:32
  Active sandboxes: 3 (main TTL 2h47m, w2 TTL 1h52m, w3 TTL 1h12m)
  Pending reviews: 1
</current-env>
```

这样 Bot 在和用户聊任何话题时，都有背景感知，不需要先问"我现在有什么工作在跑"。

---

## 五、一个设计选择的说明

Worker agent 不需要知道 Bot 的完整状态，也不需要读 Bot 的上下文。Worker 只需要知道三件事：自己的任务是什么、完成后发哪个地址、遇到问题怎么求助。Bot 和 worker 之间的唯一共享媒介是 Onlyne 消息和 Git 分支，没有共享内存，没有共享数据库。这保持了两者的完全隔离——Bot 可以重启、换模型、甚至换人接管，worker 不受影响。
