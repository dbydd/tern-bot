# requirements

- REQ-1 Bot 定位为个人事务助理与项目 BDFL，核心职责为事务协调与项目管理，不直接在主工作区编写业务代码；通过标准 Git 协作（Issue 派发、PR 审查、沙箱试用）驱动外部 Coding Agent。
- REQ-2 主会话 Bot 采用 agent-with-sandbox 形态：Bot 运行在本机 OMP 进程中，通过 git worktree CoW 快照向沙箱提供只读工作区基础，沙箱层做隔离写入；worker agent 采用 agent-in-sandbox 形态：worker OMP 进程直接运行在沙箱 VM 内部，通过 Onlyne P2P 消息与主 Bot 通信，工作产出通过 git push PR 分支回流。
- REQ-3 Tern 终端提供 TSP/WebRTC/noVNC 协议的旁观流（Spectator View），用户可实时监视沙箱桌面操作，并在需要时通过权限升级进行协作介入（Co-pilot Takeover）。
- REQ-4 Bot 主对话上下文采用三段式滑动窗口：稳定前缀（角色卡与核心指令，由 SYSTEM.md 提供）、冻结中缀（上次压缩后的状态摘要与激活的 Lorebook 词条，由 OMP Extension context 钩子在每次 LLM 调用前注入，由 session.compacting 钩子刷新）、滚动后缀（正常对话历史，由 OMP 管理）；每段各自占上下文窗口的比例上限通过配置项控制，不在代码中硬编码绝对 token 数。
- REQ-5 背景设定、项目规范与外部知识采用动态关键词/语义触发，单次注入 token 数和每轮总注入预算均通过配置控制，未命中时不占上下文。
- REQ-6 在上下文末尾 N 轮（深度可配置）动态注入当前沙箱环境摘要、活跃 worker 任务状态与紧急目标约束。
- REQ-7 对话历史采用 Frequent Compaction 滚动压缩，关键事实自动沉淀到 Context Notes、项目笔记与 Hindsight 跨会话长期记忆中。
- REQ-8 沙箱算力通过 Onlyne RFC 0013/0019 控制面申领；底层驱动通过 @opencoredev/sandbox-sdk 抽象多种弹性计算后端（本机 OrbStack、远程 VPS Docker、云弹性计算服务）；控制面只负责生命周期消息转发（申领、续期、释放、销毁、超时通知），数据面（SSH exec、noVNC 串流）直连沙箱暴露端口，不经过 Onlyne 消息总线。
- REQ-9 沙箱生命周期控制走 Onlyne 消息总线；命令执行（SSH）与桌面串流（noVNC/WebRTC）直连沙箱暴露端口。
- REQ-10 通过 Onlyne IM 网关（微信、QQ、飞书）与 MCP 工具网关暴露外部接口，OMP 模型端统一经由 msg 工具进行 SystemOne 意图路由。
- REQ-11 基于 Tern 的 Luau/TSP 体系构建富状态看板、任务看板与实时桌面画中画组件，并与 Tern 内置 Carly 助理联动；OMP Extension 侧通过 @oh-my-pi/pi-tui NativeNode 直接写 TSP 组件，Tern plugin 侧通过 host.luau 守护共享 daemon 进程，window.luau 渲染多 Bot 实例的分组看板。
- REQ-12 系统支持多 Bot 实例并发运行：每个 Bot 实例持有独立的 Onlyne node identity（Ed25519 密钥对）；sandbox-broker daemon 和 Onlyne companion 作为共享基础设施，按 bot_id 隔离租约与消息路由；各 Bot 实例持有各自的 git worktree，互不干扰。
- REQ-13 Bot 与 worker agent 之间采用基于 Git 的协作生命周期：Bot 派发 Issue 拉起 worker，worker 在沙箱内工作并提交 PR，PR 通过 Onlyne 消息唤醒主 Bot，Bot 在自己的沙箱 VM 内拉取分支执行验证，验证后决定反馈（进入新一轮）或合并（关闭 worker 与沙箱）；Bot 在整个过程中可与用户正常对话，不是纯事件响应模式；上述生命周期阶段（OPEN、WORKING、PR_SUBMITTED、REVIEW、MERGED/FEEDBACK）是需要建模的核心并发担心。
