// 担心：Bot 与用户的对话不会停，worker 的 PR 又随时经 Onlyne 消息到达，两件事并发；
// 未经主会话沙箱验证的 PR 可能被合入，review 用的租约也可能在 Bot 跑测试的途中到期被回收。
// 盒子：Git 协作生命周期 prRecords（REQ-13 的阶段只在规则允许处迁移）、契约盒子
// sharedInfra_sandboxBroker_leaseManager（租约状态机与 TTL 安全网）、
// ternBot_ompSession_tavernHarness（三段式上下文装配）、唯一的契约调用变量 lastCall。
// 顺接：worker 提交 PR → Bot 申领主会话沙箱进入审查 → 沙箱 RUNNING 下跑完测试决定合并（若中途到期则只能打回）→ 归还沙箱；
// 聊天与时钟这两条步骤与这条链正交，各自只碰自己的线。
module TernBotSystem {
  import contract.* from "../.gen/contract"
  import Vdm.* from "../.gen/contract"
  import sharedInfra_sandboxBroker_leaseManager as Lease from "../.gen/contract"
  import ternBot_ompSession_tavernHarness as Harness from "../.gen/contract"

  pure val BOT_ID = { bid: "bot-1" }
  pure val PR_IDS = Set("pr-1", "pr-2")
  pure val LEASE_IDS = Set("lease-1", "lease-2", "lease-3", "lease-4", "lease-5", "lease-6")
  pure val TICK_DELTAS = Set(600, 3600)

  // 主会话沙箱的租约时长与上下文窗口的份额上限，都是配置项的取值，不是本模型的前提。
  pure val REVIEW_TTL_SECS = 3600
  pure val BUDGET = {
    totalTokens: 131072,
    prefixRatio: { num: 30, den: 100 },
    infixRatio: { num: 20, den: 100 },
    suffixRatio: { num: 45, den: 100 },
    authorNoteRatio: { num: 5, den: 100 },
  }
  pure val PROMPT = {
    prefixTokens: 39321,
    infixTokens: 26214,
    suffixTokens: 58982,
    authorNoteTokens: 6553,
    totalTokens: 131070,
  }

  // PR 记录从派发之后的 WORKING 起建模；OPEN 与派发过程在模型之外。
  type PrStage = | PrStage_WORKING | PrStage_PR_SUBMITTED | PrStage_REVIEW | PrStage_MERGED
  type PrRecord = {
    prState: PrStage,
    reviewLeaseId: Opt[Lease::LeaseId],
    reviewLeases: Set[Lease::LeaseId],
  }

  var prRecords: str -> PrRecord
  var sandboxLeases: Lease::Leases
  var harness: Harness::WindowContext
  var lastCall: Call

  pure def leaseOf(op: Opt[Lease::LeaseId]): Lease::LeaseId = match op {
    | Some(l) => l
    | Nil => { id: "" }
  }

  pure def leaseNamed(name: str): Lease::LeaseId = { id: name }

  def configured: bool = match harness.budget {
    | Some(_) => true
    | Nil => false
  }

  // 时钟推进一条租约：正在创建的沙箱在第一次时钟推进时起来，运行中的按时钟增加已用时长，
  // 到期的转 STOPPED；已是终态的租约不动。
  pure def tickLease(x: Lease::Lease, deltaSecs: int): Lease::Lease =
    if (x.leaseState == Lease::LeaseState_RUNNING)
      if (x.elapsedSecs + deltaSecs >= x.ttlSecs)
        { ...x, elapsedSecs: x.elapsedSecs + deltaSecs, leaseState: Lease::LeaseState_STOPPED }
      else
        { ...x, elapsedSecs: x.elapsedSecs + deltaSecs }
    else if (x.leaseState == Lease::LeaseState_PROVISIONING)
      { ...x, leaseState: Lease::LeaseState_RUNNING }
    else
      x

  // ---------- 契约盒子的反馈线按 VDM post 前进 ----------
  pure def leaseStoreAfter(s: Lease::Leases, call: Call): Lease::Leases = match call {
    | sharedInfra_sandboxBroker_leaseManager(op) => match op {
        | acquire(a) => { leases: s.leases.put(a.result, {
            id: a.result,
            botId: a.req.botId,
            kind: a.req.kind,
            leaseState: Lease::LeaseState_PROVISIONING,
            ttlSecs: a.req.ttlSecs,
            elapsedSecs: 0,
            ports: { ports: List() },
          }) }
        | tick(a) => { leases: s.leases.keys().mapBy(lid => tickLease(s.leases.get(lid), a.deltaSecs)) }
        | renew(a) =>
            if (s.leases.get(a.lid).leaseState == Lease::LeaseState_RUNNING)
              { leases: s.leases.put(a.lid, { ...s.leases.get(a.lid), ttlSecs: s.leases.get(a.lid).ttlSecs + a.extendSecs }) }
            else
              s
        | release(a) =>
            if (s.leases.get(a.lid).leaseState == Lease::LeaseState_STOPPED or
                s.leases.get(a.lid).leaseState == Lease::LeaseState_FAILED)
              s
            else
              { leases: s.leases.put(a.lid, { ...s.leases.get(a.lid), leaseState: Lease::LeaseState_STOPPED }) }
        | query(_) => s
      }
    | _ => s
  }

  pure def harnessAfter(h: Harness::WindowContext, call: Call): Harness::WindowContext = match call {
    | ternBot_ompSession_tavernHarness(op) => match op {
        | configure(a) => { ...h, budget: Some(a.b) }
        | ingestMessage(a) => { ...h, history: h.history.append(a.msg) }
        | matchLorebook(_) => h
        | assemblePrompt(_) => h
        | compactHistory(a) => { ...h, infixSummary: a.summary }
      }
    | _ => h
  }

  action commit(call: Call): bool = all {
    lastCall' = call,
    sandboxLeases' = leaseStoreAfter(sandboxLeases, call),
    harness' = harnessAfter(harness, call),
  }

  action init = all {
    prRecords' = PR_IDS.mapBy(_ => { prState: PrStage_WORKING, reviewLeaseId: Nil, reviewLeases: Set() }),
    sandboxLeases' = Lease::initial,
    harness' = Harness::initial,
    lastCall' = NoCall,
  }

  // ---------- 与用户对话：与 PR 生命周期正交，任何阶段都可用 ----------
  // REQ-4
  action step_user_chat: bool = any {
    // 会话第一次组装上下文之前，先把窗口预算交进盒子。
    all {
      not(configured),
      prRecords' = prRecords,
      commit(ternBot_ompSession_tavernHarness(Harness::configure({ b: BUDGET }))),
    },
    all {
      configured,
      prRecords' = prRecords,
      commit(ternBot_ompSession_tavernHarness(Harness::assemblePrompt({ result: PROMPT }))),
    },
  }

  // ---------- worker 提交 PR：worker 沙箱的租约不动，TTL 继续计时 ----------
  // REQ-13
  action step_worker_pr(p: str): bool = all {
    prRecords.get(p).prState == PrStage_WORKING,
    prRecords' = prRecords.put(p, { ...prRecords.get(p), prState: PrStage_PR_SUBMITTED }),
    commit(NoCall),
  }

  // ---------- Bot 开始审查：先申领主会话沙箱，拿到租约才进 REVIEW ----------
  // REQ-13
  action step_bot_review(p: str, leaseName: str): bool = all {
    prRecords.get(p).prState == PrStage_PR_SUBMITTED,
    not(leaseNamed(leaseName).in(sandboxLeases.leases.keys())),
    prRecords' = prRecords.put(p, {
      ...prRecords.get(p),
      prState: PrStage_REVIEW,
      reviewLeaseId: Some(leaseNamed(leaseName)),
      reviewLeases: prRecords.get(p).reviewLeases.union(Set(leaseNamed(leaseName))),
    }),
    commit(sharedInfra_sandboxBroker_leaseManager(Lease::acquire({
      req: { botId: BOT_ID, kind: Lease::SandboxKind_main, ttlSecs: REVIEW_TTL_SECS, spec: "main-review" },
      result: leaseNamed(leaseName),
    }))),
  }

  // ---------- Bot 在沙箱里跑完测试：合并要求审查沙箱仍为 RUNNING；若到期或拒绝则回到 WORKING ----------
  // REQ-13
  action step_bot_decide(p: str, approve: bool): bool = {
    val lid = leaseOf(prRecords.get(p).reviewLeaseId)
    all {
      prRecords.get(p).prState == PrStage_REVIEW,
      prRecords.get(p).reviewLeaseId != Nil,
      lid.in(sandboxLeases.leases.keys()),
      not(approve) or sandboxLeases.leases.get(lid).leaseState == Lease::LeaseState_RUNNING,
      prRecords' = prRecords.put(p, {
        ...prRecords.get(p),
        prState: if (approve) PrStage_MERGED else PrStage_WORKING,
        reviewLeaseId: Nil,
      }),
      commit(sharedInfra_sandboxBroker_leaseManager(Lease::release({ lid: lid }))),
    }
  }

  // ---------- 时钟流逝：TTL 到期由租约盒子自己转 STOPPED，PR 记录不动 ----------
  // REQ-8
  action step_lease_tick(deltaSecs: int): bool = all {
    prRecords' = prRecords,
    commit(sharedInfra_sandboxBroker_leaseManager(Lease::tick({ deltaSecs: deltaSecs }))),
  }

  action step = {
    nondet p = PR_IDS.oneOf()
    nondet leaseName = LEASE_IDS.oneOf()
    nondet deltaSecs = TICK_DELTAS.oneOf()
    nondet approve = Set(true, false).oneOf()
    any {
      step_user_chat,
      step_worker_pr(p),
      step_bot_review(p, leaseName),
      step_bot_decide(p, approve),
      step_lease_tick(deltaSecs),
    }
  }

  // ---------- 性质：写在对外可观察的线上 ----------
  // REQ-13：合入过的 PR 在记录里必然走过审查。
  val inv_no_unverified_merge =
    prRecords.keys().forall(p => prRecords.get(p).prState != PrStage_MERGED or prRecords.get(p).reviewLeases.size() > 0)

  // REQ-4：每次装配出来的上下文不超过配置的窗口总量。
  val inv_context_bounded = match lastCall {
    | ternBot_ompSession_tavernHarness(op) => match op {
        | assemblePrompt(a) => match harness.budget {
            | Some(b) => a.result.totalTokens <= b.totalTokens
            | Nil => true
          }
        | _ => true
      }
    | _ => true
  }

  // REQ-12：运行中的租约只属于申领它的那一个 Bot 实例。
  val inv_sandbox_isolation =
    sandboxLeases.leases.keys().forall(lid =>
      sandboxLeases.leases.get(lid).leaseState != Lease::LeaseState_RUNNING or
      sandboxLeases.leases.get(lid).botId == BOT_ID)

  // REQ-8：运行中的租约没有超过 TTL 的。
  val inv_lease_ttl_safety =
    sandboxLeases.leases.keys().forall(lid =>
      sandboxLeases.leases.get(lid).leaseState != Lease::LeaseState_RUNNING or
      sandboxLeases.leases.get(lid).elapsedSecs < sandboxLeases.leases.get(lid).ttlSecs)

  val safety = inv_no_unverified_merge and inv_context_bounded and inv_sandbox_isolation and inv_lease_ttl_safety

  // ---------- 覆盖目标：说明模型确实走到了这些情形 ----------
  // REQ-13：有 PR 走完 WORKING → PR_SUBMITTED → REVIEW → MERGED。
  val witnessMergedAfterReview =
    prRecords.keys().exists(p => prRecords.get(p).prState == PrStage_MERGED and prRecords.get(p).reviewLeases.size() > 0)
  pure val maxSteps_witnessMergedAfterReview = 20

  // REQ-4：用户对话在某个 PR 处于 REVIEW 时照常发生。
  val witnessUserChatDuringReview = match lastCall {
    | ternBot_ompSession_tavernHarness(op) => match op {
        | assemblePrompt(_) => prRecords.keys().exists(p => prRecords.get(p).prState == PrStage_REVIEW)
        | _ => false
      }
    | _ => false
  }

  // REQ-8：TTL 到期的沙箱被回收，同时另一个 PR 还在 WORKING。
  val witnessLeaseExpiredDuringWorking =
    prRecords.keys().exists(p => prRecords.get(p).prState == PrStage_WORKING) and
    sandboxLeases.leases.keys().exists(lid =>
      sandboxLeases.leases.get(lid).leaseState == Lease::LeaseState_STOPPED and
      sandboxLeases.leases.get(lid).elapsedSecs >= sandboxLeases.leases.get(lid).ttlSecs)

  // REQ-13：某个 PR 经历反馈回到 WORKING，再审查一次之后合入。
  val witnessMultipleRounds =
    prRecords.keys().exists(p => prRecords.get(p).prState == PrStage_MERGED and prRecords.get(p).reviewLeases.size() >= 2)
}
