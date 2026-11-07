# Tern-Bot 架构体系与 SSoT 规格实施计划

## Context
本项目旨在为 `/Users/dbydd/Documents/progs/tern-bot` 构建一套基于 **OMP + Tern + Onlyne + 沙箱 VM (OrbStack / 远程云主机)** 的全新 Personal Bot 生态系统。该 Bot 不定位于传统的本地代码密集型修改 Agent，而是作为用户的 **个人智能助理与项目 BDFL**：协助处理日常琐事与应用连接、在专属桌面 VM 沙箱中代表用户执行操作（用户可随时旁观或介入），以及通过 Git 工作流管理项目并委派外部 Coding Agent 在其独立环境中干活。
针对传统 Agent 动辄数万 Token 导致的延迟飙升与注意力退化（参考 NVIDIA arXiv:2611.05306v1 论文《You don't need long context》），本系统吸纳**酒馆（SillyTavern）Harness 工程设计**，采用极致的**短上下文 + 频繁压缩 + 动态 Lorebook + 深度注入**体系。
整个生态遵循 **SSoT (Single Source of Truth) 形式化规则**：先完成 LikeC4 结构、VDM-SL 盒子契约、Quint 行为接线三层规格与形式化验证，随后分步落地核心工程代码。

---

## Approach

### Phase 1: 建立 SSoT 需求与结构层 (LikeC4)
1. **创建需求文档 `design/requirements.md`**：
   - 严格按 SSoT 规范编号登记需求原文：
     - `REQ-1` [Bot 定位与 BDFL 范式]：Bot 定位为个人事务助理与项目 BDFL，核心职责为事务协调与项目管理，不直接在主工作区编写业务代码；通过标准 Git 协作（Issue 派发、PR 审查、沙箱试用）驱动外部 Coding Agent。
     - `REQ-2` [Agent 专属桌面 VM 沙箱]：每个 Agent 实例拥有独立的完整 GUI 桌面 VM 环境；Agent 桌面操作仅在沙箱内执行，严禁无授权侵入用户本机桌面。
     - `REQ-3` [旁观与介入机制]：Tern 终端提供 TSP/WebRTC/noVNC 协议的旁观流（Spectator View），用户可实时监视沙箱桌面操作，并在需要时通过权限升级进行协作介入（Co-pilot Takeover）。
     - `REQ-4` [短上下文与酒馆 Harness 哲学]：Bot 主对话上下文严格限制为紧凑滑动窗口（≤ 8k tokens）；严禁随时间无限制膨胀上下文。
     - `REQ-5` [动态 Lorebook / World Info]：背景设定、项目规范与外部知识采用动态关键词/语义触发，单次匹配注入 200~500 tokens 片段，未命中时不占上下文。
     - `REQ-6` [Author's Note 深度注入]：在上下文末尾 N 轮（-2 或 -4 轮）动态注入当前沙箱环境摘要、紧急目标与执行约束。
     - `REQ-7` [分级记忆流转与频繁压缩]：对话历史采用 Frequent Compaction 滚动压缩，关键事实自动沉淀到 Context Notes、项目笔记与 Hindsight 跨会话长期记忆中。
     - `REQ-8` [沙箱算力生命周期管理]：对接 Onlyne RFC 0013 计算作业资源与 RFC 0019 算力网关规范，实现申领 (acquire)、续期 (renew)、释放 (release)、销毁 (destroy) 状态机与租约 TTL 超时安全网。
     - `REQ-9` [控制面与数据面严格分离]：沙箱生命周期控制走 Onlyne 消息与资源总线；命令执行（SSH）与桌面串流（noVNC/WebRTC）直连沙箱暴露端口。
     - `REQ-10` [多平台连接器与统一消息入口]：通过 Onlyne IM 网关（微信、QQ、飞书）与 MCP 工具网关暴露外部接口，OMP 模型端统一经由 `msg` 入口进行 SystemOne 意图路由。
     - `REQ-11` [Tern 富文本 UI 与助理集成]：基于 Tern 的 Luau/TSP 体系构建富状态看板、任务看板与实时桌面画中画组件，并与 Tern 内置 Carly 助理联动。

2. **编写 LikeC4 结构视图 `design/structure/tern-bot.c4`**：
   - 定义模型元素：
     - `actor user "User / Operator"`
     - `actor codingAgent "Managed External Coding Agent"`
     - `system ternBot "Tern Bot Ecosystem"`：
       - `container ternUi "Tern GUI / TSP Surface"`：承载 Luau/TSP 视图、桌面旁观、Carly 桥接
       - `container botCore "Tern-Bot Core Controller"`：承载 Tavern Harness、BDFL 工作流、OMP 运行时
       - `container onlyneNode "Onlyne Peer Node"`：承载 Ed25519 身份、消息账本、IM/MCP 路由
       - `container computeBroker "Compute Broker (Onlyne RFC 0019)"`：承载沙箱租约分配、OrbStack / 云主机驱动
       - `container sandbox "Isolated Agent Desktop VM"`：带 Xvfb/noVNC/SSH 的独立沙箱
   - 标注需要形式化深入建模的底层盒子（打上 `#contract` 标签）：
     - `botCore.tavernHarness` `#contract`
     - `botCore.bdflWorkflow` `#contract`
     - `computeBroker.leaseManager` `#contract`
   - 定义视图：`index` (System Context), `containers` (Container View), `deployment` (Deployment View 区分本地 macOS OrbStack 与远程 Linux 云主机)。

### Phase 2: 建立 SSoT 盒子层契约 (VDM-SL)
1. **编写 `design/contract/TavernHarness.vdm`**：
   - 模块名：`TavernHarness`
   - 状态类型：
     - `HistoryWindow`: `seq of Message`（保持长度 ≤ `MAX_WINDOW_TURNS`）
     - `Lorebook`: `map Keyword to LoreEntry`
     - `AuthorNote`: `[TokenString]` 及 `injectDepth: nat1`
     - `TotalTokenCount`: `nat`（不变式 `inv TotalTokenCount <= 8192`）
   - 操作与函数：
     - `IngestMessage(msg: Message) ==> ()`：压入新消息，若超过阈值触发 `CompressHistory()`。
     - `MatchLorebook(query: seq of char) ==> set of LoreEntry`：纯函数，返回关键词命中条目集合。
     - `AssemblePrompt() ==> seq of Message`：结合 CharacterCard + 激活 Lorebook + 历史窗口 + 深度注入 Author's Note，后置条件保证不超过硬性 Token 上限。
     - `CompressHistory() ==> ()`：调用 Frequent Compaction，将前序消息归纳为 summary 并输出记忆沉淀事件。

2. **编写 `design/contract/LeaseManager.vdm`**：
   - 模块名：`LeaseManager`
   - 对齐 Onlyne RFC 0013 计算资源状态机：
     - 状态集合：`'PROVISIONING' | 'RUNNING' | 'STOPPED' | 'DESTROYED' | 'FAILED'`
     - 记录类型 `SandboxLease`：`id: LeaseId`, `state: State`, `ttlSeconds: nat`, `elapsedSeconds: nat`, `ports: PortMapping`, `auth: AuthGrants`
   - 操作与函数：
     - `AcquireLease(req: AcquireRequest) ==> SandboxLease`
     - `Tick(deltaSeconds: nat) ==> ()`：处理时钟流逝，当 `elapsedSeconds >= ttlSeconds` 时自动流转为 `'STOPPED'` 或 `'DESTROYED'`。
     - `RenewLease(id: LeaseId, extendSeconds: nat) ==> bool`
     - `ReleaseLease(id: LeaseId) ==> ()`

3. **编写 `design/contract/BdflWorkflow.vdm`**：
   - 模块名：`BdflWorkflow`
   - 状态类型：
     - `ProjectState`：`repoUrl`, `activeIssues`, `activePrs`
     - `PrRecord`：`id`, `agentId`, `branch`, `sandboxId`, `reviewState: 'PENDING' | 'TESTING' | 'APPROVED' | 'REJECTED'`
   - 操作与函数：
     - `DispatchTask(issue: Issue, agent: AgentSpec) ==> TaskTicket`
     - `SubmitPr(pr: PrSubmission) ==> ()`
     - `VerifyInSandbox(prId: PrId, sandboxId: LeaseId) ==> TestResult`
     - `DecideMerge(prId: PrId, approved: bool) ==> ()`（不变量：严禁未经沙箱验证通过的 PR 执行 Merge）

### Phase 3: 建立 SSoT 接线层行为 (Quint) 与验证
1. **代码生成**：运行 `ssot gen design` 生成 `.gen/structure.json` 与 `.gen/contract.qnt`。
2. **编写 `design/behavior/TernBotSystem.qnt`**：
   - 导入自动生成的契约类型与状态定义。
   - 建模消息、沙箱调度与 BDFL 任务生命周期的并发接线：
     - `action step_user_chat`: 用户发送指令，Tavern Harness 组装短 prompt 并触发决策。
     - `action step_dispatch_coding_task`: BDFL 创建 Issue 并调用 LeaseManager 为外部 Coding Agent 申领沙箱。
     - `action step_agent_work`: 模拟外部 Coding Agent 在沙箱中完成代码并提交 PR。
     - `action step_bdfl_verify_in_sandbox`: Bot 在自己的 VM 沙箱中拉取 PR 分支运行测试。
     - `action step_timer_tick`: 时钟流逝，检查租约超时与上下文压缩。
   - 声明核心安全不变量与活性目标：
     - `inv_context_token_bounded`: 任意时刻 Bot 提示词上下文总 Token 数均不超过 8192。
     - `inv_sandbox_isolation`: 外部 Coding Agent 与 Bot 的沙箱资源相互隔离，不可越权操作。
     - `inv_no_unverified_merge`: 任何 PR 必须在完成沙箱内自动化验证并由 Bot 确认后方可合入。
     - `inv_lease_timeout_safety`: 超时沙箱必然被安全回收，无孤儿泄漏。
3. **验证执行**：运行 `ssot check design`，执行全量类型检查、Quint 模拟与状态回放，排查并消解一切 error。

### Phase 4: 工程落地与核心包实现 (Bun + TypeScript)
1. **工程仓库初始化 (`package.json`, `tsconfig.json`)**：
   - 建立 Bun Monorepo 结构：
     - `packages/tavern-harness/`：短上下文装配与酒馆工程引擎
     - `packages/sandbox-broker/`：OrbStack 与云主机沙箱驱动器
     - `packages/bdfl-engine/`：Git 任务分发与 PR 沙箱试用引擎
     - `packages/tern-plugin/`：Tern 插件与 Luau/TSP 视图
     - `packages/bot-daemon/`：聚合运行时与 Onlyne 节点网关

2. **实现 `packages/tavern-harness`**：
   - `CharacterCard` 加载器：支持 V2 标准角色卡 JSON/YAML，提取 System Prompt、人格基调与回复规则。
   - `LorebookEngine`：
     - 维护词条字典（主触发词、次要触发词、防抖冷却轮数）。
     - 支持轻量 BM25 或小模型嵌入做精准语义匹配。
     - 限制每轮注入条目总预算（默认 ≤ 600 tokens）。
   - `AuthorNoteInjector`：
     - 实现基于相对深度的消息插入（例如倒数第 2 条消息前注入 `[Current VM: ready, active_job: test_pr_14]`）。
   - `FrequentCompactor`：
     - 滑动窗口截断器（保留最近 6 轮）。
     - 归纳总结器：自动调用轻量 LLM（或基于规则）生成 rolling summary。
     - 联动 `omp-hindsight`：关键决策点通过 `hindsight({ intent: "retain ...", content: ... })` 自动保留为长期事实。

3. **实现 `packages/sandbox-broker`**：
   - 实现统一沙箱接口 `SandboxDriver`：
     - `create(spec: MachineSpec): Promise<SandboxHandle>`
     - `start(id: string): Promise<void>`
     - `stop(id: string): Promise<void>`
     - `destroy(id: string): Promise<void>`
     - `exec(id: string, cmd: string[]): Promise<ExecResult>`
     - `getStreamUrl(id: string): Promise<{ novncUrl: string, sshPort: number }>`
   - 实现 **OrbStack 驱动** (`OrbstackDriver`)：
     - 调用本地 `/opt/homebrew/bin/orbctl` 命令行：`orbctl create linux:ubuntu <name>`，秒级启动。
     - 挂载轻量图形桌面（Xvfb + Fluxbox/Openbox + x11vnc + websockify/noVNC）。
   - 实现 **云主机驱动** (`RemoteCloudDriver`)：
     - 基于 SSH + Docker 驱动远程主机容器池，支持 OVNFS / CoW 存储快照。
   - 实现 **Onlyne RFC 0013 Compute Broker 服务**：
     - 暴露标准算力申请与租约心跳 API，维护 TTL 自动停机守护定时器。

4. **实现 `packages/bdfl-engine`**：
   - **Git Issue 与 PR 状态管理**：
     - 封装轻量 Issue 声明与任务规范（输入分支、预期验收命令、边界约束）。
   - **External Coding Agent 调度器**：
     - 为任务申领新沙箱实例，注入工作区与基础 OMP 环境配置。
     - 发送任务启动命令，监控 Agent 产出物。
   - **沙箱隔离试用器**：
     - Coding Agent 提交分支后，BDFL 在自身沙箱内拉取分支。
     - 自动执行依赖安装、测试运行，并在沙箱虚拟桌面中打开试用（如跑 Web 服务通过沙箱内浏览器做前置验收）。
     - 将试用截图与执行日志回传给用户和 Bot 决策链路。

5. **实现 `packages/tern-plugin` 与 Tern UI 呈现**：
   - 编写 Tern 插件配置 `manifest.json` 与插件入口：
     - 注册 `tern-bot` 专有 block 类型与 lens 视图。
   - 使用 Tern 的 Luau/TSP 协议渲染动态界面：
     - **Bot 状态面板**：显示当前 Bot 人设、当前 Token 消耗监控（验证短上下文维持在 2k~6k 区间）、活跃记忆条目。
     - **项目协作看板**：展示当前 BDFL 派发给 external agents 的任务进度、PR 状态列表。
     - **沙箱画中画 (Spectator View)**：直接在终端侧边或独立 block 嵌入沙箱桌面视频流（noVNC/WebRTC），用户可实时点击旁观或切换为输入介入模式。

---

## Critical files & anchors

1. `design/requirements.md` — SSoT 需求源文件，定义 REQ-1 ~ REQ-11 原文与编号。
2. `design/structure/tern-bot.c4` — LikeC4 结构模型，定义系统、容器、组件与 `#contract` 标记。
3. `design/contract/TavernHarness.vdm` — 酒馆短上下文工程与 Lorebook 动态装配形式化契约。
4. `design/contract/LeaseManager.vdm` — Onlyne 算力沙箱租约状态机与超时回收形式化契约。
5. `design/behavior/TernBotSystem.qnt` — Quint 行为时序模型，验证并发安全性与隔离不变量。
6. `packages/tavern-harness/src/engine.ts` — 运行时短上下文滑动窗口与动态注入实现。
7. `packages/sandbox-broker/src/orbstack.ts` — 本机 OrbStack Linux VM 自动化创建与图形桌面串流驱动。
8. `packages/bdfl-engine/src/manager.ts` — BDFL Git 任务派发与沙箱自动化试用合并控制。
9. `packages/tern-plugin/src/view.luau` — Tern 终端前台富文本与桌面画中画渲染脚本。

---

## Verification

1. **SSoT 规格全量检查**：
   - 执行命令：`ssot check design`
   - 预期结果：LikeC4 结构解析无误、VDM-SL 语法与类型校验通过、Quint 模型编译与状态空间模拟验证全部通过，退出码为 `0`。
2. **SSoT 渲染产物生成**：
   - 执行命令：`ssot render design --out design/export`
   - 预期结果：生成架构总览图、容器图、部署图、各 VDM 契约盒子图与 Quint 组合图。
3. **Tavern Harness 紧凑上下文压测**：
   - 测试脚本：`bun test packages/tavern-harness`
   - 验证输入：模拟连续 30 轮多轮交互，持续注入环境变化。
   - 预期输出：
     - 单轮上下文 Token 数严格维持在 8192 以下（验证滑动窗口与 Frequent Compaction 生效）；
     - 关键词命中时 Lorebook 正确注入对应 200~400 tokens，不命中时不产生干扰；
     - Author's Note 正确出现在倒数指定轮次位置。
4. **OrbStack 桌面沙箱端到端创建与桌面串流验证**：
   - 执行脚本：`bun run packages/sandbox-broker/test/smoke-orbstack.ts`
   - 预期输出：
     - `orbctl` 成功克隆/创建名为 `tern-bot-test-vm` 的独立机器；
     - 沙箱内启动 Xvfb + noVNC 成功，并向外部暴露端口；
     - 数据面 URL 可通过浏览器/Tern Webview 正常访问桌面；
     - 超时触发后沙箱被安全销毁。
5. **BDFL 协作流程闭环冒烟验证**：
   - 执行脚本：`bun run packages/bdfl-engine/test/smoke-flow.ts`
   - 验证链路：
     - Bot 发起 Issue 并在沙箱中唤起模拟 Coding Agent；
     - Agent 提交修复分支，Bot 在自身独立沙箱 checkout 分支并运行测试套件；
     - 测试通过后自动合入，全流程形成审计日志。
6. **Tern 插件与 TSP 视图联动检查**：
   - 执行命令：`tern open --tab packages/tern-plugin`
   - 预期表现：Tern 窗口正确展示 Bot 控制面板、Token 实时监控条与沙箱桌面监视器。

---

## Assumptions & contingencies

- **Assumption 1**：本机已具备 OrbStack 且命令行 `orbctl` 可用；远程云主机后续按需通过 SSH 配置接入。
  - *Contingency*：若测试机未安装或未启动 OrbStack，驱动自动回退到本地 Docker 容器驱动（带 Xvfb/noVNC），确保单机开发仍可进行。
- **Assumption 2**：Tern 运行在当前环境（`TERN_EXE` 与 `TERN_PANE` 已配置）。
  - *Contingency*：若脱离 Tern 在普通终端运行，UI 模块自动回退为纯文本 / ANSI CLI 输出，核心 Bot 逻辑与沙箱控制面不受影响。
- **Assumption 3**：OMP 运行时使用现有的 `omp-onlyne` 插件与 `omp-hindsight`。
  - *Contingency*：若外部记忆库暂时离线，Frequent Compactor 降级为本地 SQLite 文件记录，待节点在线后再行同步。
