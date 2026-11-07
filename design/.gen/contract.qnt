// 由 ssot gen 从 contract/*.vdmsl 生成；只读，不要手改。
module Vdm {
  type Opt[a] = | Nil | Some(a)
}
module sharedInfra_sandboxBroker_leaseManager {
  import Vdm as Vdm
  type LeaseId = { id: str }
  type BotId = { bid: str }
  type LeaseState = | LeaseState_FAILED | LeaseState_PROVISIONING | LeaseState_RUNNING | LeaseState_STOPPED
  type SandboxKind = | SandboxKind_main | SandboxKind_worker
  type AcquireRequest = { botId: BotId, kind: SandboxKind, ttlSecs: int, spec: str }
  type PortMapping = { ports: List[str] }
  type Lease = { id: LeaseId, botId: BotId, kind: SandboxKind, leaseState: LeaseState, ttlSecs: int, elapsedSecs: int, ports: PortMapping }
  type Leases = { leases: LeaseId -> Lease }
  pure val initial: Leases = { leases: Map() }
  type Call =
    | acquire({ req: AcquireRequest, result: LeaseId })
    | tick({ deltaSecs: int })
    | renew({ lid: LeaseId, extendSecs: int, result: bool })
    | release({ lid: LeaseId })
    | query({ lid: LeaseId, result: Vdm::Opt[Lease] })
}
module ternBot_ompSession_tavernHarness {
  import Vdm as Vdm
  type Ratio = { num: int, den: int }
  type WindowBudget = { totalTokens: int, prefixRatio: Ratio, infixRatio: Ratio, suffixRatio: Ratio, authorNoteRatio: Ratio }
  type PromptAssembly = { prefixTokens: int, infixTokens: int, suffixTokens: int, authorNoteTokens: int, totalTokens: int }
  type LoreMatch = { entryId: str, tokens: int }
  type WindowContext = { budget: Vdm::Opt[WindowBudget], history: List[str], lorebook: str -> int, infixSummary: str, authorNote: str }
  pure val initial: WindowContext = { budget: Vdm::Nil, history: List(), lorebook: Map(), infixSummary: "", authorNote: "" }
  type Call =
    | configure({ b: WindowBudget })
    | ingestMessage({ msg: str })
    | matchLorebook({ queryTerm: str, result: Set[LoreMatch] })
    | assemblePrompt({ result: PromptAssembly })
    | compactHistory({ summary: str, result: str })
}
module contract {
  import sharedInfra_sandboxBroker_leaseManager as sharedInfra_sandboxBroker_leaseManager
  import ternBot_ompSession_tavernHarness as ternBot_ompSession_tavernHarness
  type Call =
    | NoCall
    | sharedInfra_sandboxBroker_leaseManager(sharedInfra_sandboxBroker_leaseManager::Call)
    | ternBot_ompSession_tavernHarness(ternBot_ompSession_tavernHarness::Call)
}
