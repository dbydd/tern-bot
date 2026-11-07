# TernBotSystem.qnt 接线设计意图

这份文档给写 Quint 的人看，不是给工具看的。先读懂这里的意图，再去写代码。

## 担心是什么

Bot 正在和用户聊天（这不会停），同时一个 worker 完成了工作、提交了 PR（这是异步事件）。两件事并发。

具体担心：

1. **未经 Bot 验证的 PR 被合入**。worker 提交 PR，Bot 还没在自己的沙箱里拉下来跑过，PR 就进了主分支。这在任何情况下都不应该发生。
2. **Bot 还在 review 期间，worker 的沙箱因 TTL 到期被销毁**。Bot 准备去沙箱拉分支，结果沙箱已经没了。

这两个担心需要被证明不会发生。PR 生命周期的阶段就是证明的对象。

## PR 生命周期（这是要建模的核心）

```
OPEN → WORKING → PR_SUBMITTED → REVIEW → MERGED
                                        ↘ FEEDBACK → WORKING（新一轮）
```

每个 PR 记录（`PrRecord`）只在这些状态之间按规则迁移。

重点约束：
- 只有 `PR_SUBMITTED` 才能进入 `REVIEW`
- 只有 `REVIEW` 才能进入 `MERGED` 或 `FEEDBACK`
- 进入 `REVIEW` 时，Bot 必须先申领主会话沙箱（`acquire` 端口），拿到 `LeaseId` 才能继续
- 进入 `MERGED` 时，必须释放沙箱（`release` 端口）

**并发约束**：`step_user_chat` 可以在任何阶段发生，不阻塞也不被阻塞。它和 PR 生命周期是完全正交的两件事。

## 五个 action

### `step_user_chat`
Bot 收到用户消息，调用 `assemblePrompt()`。
- 前置：`budget` 已配置（`Vdm::Some`）
- 调用 `ternBot_ompSession_tavernHarness::assemblePrompt`
- 不改 PR 状态，不改租约状态
- 这一步永远可用，不受 PR 状态限制

### `step_worker_pr`
Worker 提交了 PR（通过 Onlyne 消息到达 Bot）。
- 选一个处于 `WORKING` 状态的 PR 记录
- 迁移到 `PR_SUBMITTED`
- 不改租约状态（worker 沙箱继续跑，TTL 继续计时）

### `step_bot_review`
Bot 开始审查一个 PR，申领主会话沙箱。
- 前置：PR 处于 `PR_SUBMITTED`
- 调用 `leaseManager::acquire`，kind=`<main>`
- 把返回的 `LeaseId` 存在 PR 记录上（`reviewLeaseId`）
- PR 状态迁移到 `REVIEW`

### `step_bot_decide`
Bot 在自己的沙箱里跑完测试，做出决定。
- 前置：PR 处于 `REVIEW`，`reviewLeaseId` 不为 nil
- 非确定性选择：`<approve>` 或 `<reject>`
  - `<approve>`（MERGED）：调用 `leaseManager::release`，PR 迁移到 `MERGED`，`reviewLeaseId` 清空
  - `<reject>`（FEEDBACK）：调用 `leaseManager::release`，PR 迁移到 `WORKING`，`reviewLeaseId` 清空

### `step_lease_tick`
时钟流逝，调用 `leaseManager::tick`。
- 所有 RUNNING 的租约 `elapsedSecs` 增加
- TTL 到期的迁移到 `STOPPED`
- 这一步不改 PR 状态

## 四个 safety 性质

### `inv_no_unverified_merge`
任意时刻，所有 `MERGED` 的 PR，它们在历史上必然经过 `REVIEW` 阶段。

在 Quint 里的写法：所有 PR 记录中，`prState = <MERGED>` 的，其 `reviewLeaseId` 字段在进入 `MERGED` 之前曾被设置过（用 `everReviewed` 集合追踪）。

```
val inv_no_unverified_merge =
  mergedPrs.forall(pr => pr.everReviewed)
```

### `inv_context_bounded`
每次调用 `assemblePrompt` 的结果，`totalTokens <= budget.totalTokens`。

这个性质直接来自 VDM 的 `post`，回放会检查它。safety 里只需要写：`lastCall` 是 `assemblePrompt` 时，`result.totalTokens <= harness.budget.totalTokens`。

```
val inv_context_bounded =
  match lastCall {
    | ternBot_ompSession_tavernHarness(assemblePrompt(a)) =>
        match harness.budget {
          | Some(b) => a.result.totalTokens <= b.totalTokens
          | _ => true
        }
    | _ => true
  }
```

### `inv_sandbox_isolation`
每条租约的 `botId` 唯一绑定给申领它的 Bot 实例。`release` 只能由持有对应 `botId` 的 Bot 调用。

在这个模型里只有一个 Bot 实例，所以约束简化为：所有 `RUNNING` 租约的 `botId` 都等于 `THE_BOT_ID`（单例常量）。

### `inv_lease_ttl_safety`
所有 `RUNNING` 的租约，`elapsedSecs < ttlSecs`。这由 LeaseManager 的 `inv` 直接保证，Quint 回放会验证。safety 层不需要重复写，但可以加一个 witness 说明 tick 确实触发过 TTL 到期。

## 覆盖目标（witnesses）

- `witnessMergedAfterReview`：有 PR 走完了 WORKING → PR_SUBMITTED → REVIEW → MERGED 完整路径
- `witnessUserChatDuringReview`：user_chat 在某个 PR 处于 REVIEW 状态时发生（证明并发不互相阻塞）
- `witnessLeaseExpiredDuringWorking`：worker 沙箱 TTL 到期（进 STOPPED），同时 PR 还在 WORKING（证明 TTL 安全网在 review 之前有效）
- `witnessMultipleRounds`：某个 PR 经历了至少一次 FEEDBACK → WORKING 再到 MERGED（证明多轮迭代路径可达）

`maxSteps_witnessMergedAfterReview = 20`，其余默认。

## 候选集合

```quint
pure val BOT_ID = { bid: "bot-1" }
pure val PR_IDS = Set("pr-1", "pr-2")
pure val LEASE_IDS = Set("lease-1", "lease-2", "lease-3")
```

## 文件位置

写到 `design/behavior/TernBotSystem.qnt`，模块名 `TernBotSystem`。

import 路径：
```quint
import contract.* from "../.gen/contract"
import Vdm.* from "../.gen/contract"
import sharedInfra_sandboxBroker_leaseManager as Lease from "../.gen/contract"
import ternBot_ompSession_tavernHarness as Harness from "../.gen/contract"
```
