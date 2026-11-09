--!strict
-- tern-bot host half: supervises the single-authority Onlyne Hub companion process,
-- registers `tern-bot.board`, and renders the companion panel:
--   - Top centered large Bot avatar card + primary menu strip + secondary panel
--     (under "沙箱算力", expands into an OrbStack-style Activity Monitor with live
--     per-container CPU/Mem/Net/Disk table and 2x2 sparkline metric cards!)
--   - Bottom-anchored stack (`.tb-lower` with `margin-top: auto`):
--       1. Fixed-height scrollable Workers list with strong hover & selected highlight
--       2. Selected Worker detail card whose bottom-left control is a clickable
--          miniature sandbox desktop keyframe window (`.tb-mini-pip`) and bottom-right
--          control is `[请求介入]`.

local ui = tern.ui

local PROBE_MS = 1800
local HUB_JSON_POLL_MS = 1000

type WorkerRecord = {
	workerId: string,
	taskId: string,
	title: string,
	description: string,
	state: string,
	dispatchedAt: number,
	elapsedSecs: number,
	needsReview: boolean,
	observations: number,
	intervening: boolean?,
	desktopUrl: string?,
	interactiveDesktopUrl: string?,
	cdpEndpoint: string?,
	httpEndpoint: string?,
	lastScreenshotPath: string?,
	rejectionReason: string?,
	agentPhase: string?,
	agentError: string?,
	acpPaneCommand: string?,
	thumbSeq: number?,
	thumbMime: string?,
}

type BotRecord = {
	botId: string,
	workspace: string,
	state: "idle" | "working" | "waiting" | "starting",
	mainPane: number?,
	boardPane: number?,
	tab: number?,
	contextTokens: number?,
	contextBudget: number?,
	updatedAt: number,
	workers: { WorkerRecord },
}

type LeaseRecord = {
	leaseId: string,
	name: string,
	kind: string,
	state: string,
	ttlRemainingSecs: number,
	desktopUrl: string?,
	cdpEndpoint: string?,
	httpEndpoint: string?,
	containerId: string?,
}

type ContainerStatRow = {
	id: string,
	name: string,
	group: string,
	cpuPct: number,
	cpuText: string,
	memBytes: number,
	memText: string,
	netRateBps: number,
	netText: string,
	diskRateBps: number,
	diskText: string,
}

type ActivitySnapshot = {
	updatedAt: number,
	totalCpuPct: number,
	totalCpuText: string,
	totalMemBytes: number,
	totalMemText: string,
	totalNetBps: number,
	totalNetText: string,
	totalDiskBps: number,
	totalDiskText: string,
	containers: { ContainerStatRow },
	series: {
		cpu: { { any } },
		mem: { { any } },
		net: { { any } },
		disk: { { any } },
	},
}

type BoardData = {
	hubNodeId: string,
	repoRoot: string,
	ledgerCount: number,
	bots: { BotRecord },
	leases: { LeaseRecord },
	activity: ActivitySnapshot?,
}

type HubInfo = {
	port: number,
	adminUrl: string,
	endpoint: string,
	nodeId: string,
	pid: number,
	token: string,
	repoRoot: string,
}

-- ---- Hub companion process supervisor ----

local hubSpawned = false
local hubInfoCache: HubInfo? = nil

local function dataDir(): string
	return tern.plugin.data
end

local function hubJsonPath(): string
	return dataDir() .. "/hub.json"
end

local function readHubInfo(): HubInfo?
	if not tern.fs.exists(hubJsonPath()) then
		return nil
	end
	local ok, value = pcall(function()
		return tern.json.decode(tern.fs.read(hubJsonPath(), 65536))
	end)
	if not ok or type(value) ~= "table" then
		return nil
	end
	if type(value.port) ~= "number" or type(value.adminUrl) ~= "string" then
		return nil
	end
	return value
end

local function bunBinary(): string
	local home = tern.getenv("HOME") or ""
	local candidates = { home .. "/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun" }
	for _, path in candidates do
		if string.sub(path, 1, 1) == "/" and tern.fs.exists(path) then
			return path
		end
	end
	return "bun"
end

local function hubEntry(): string
	return tern.plugin.dir .. "/server/hub.ts"
end

local function spawnHub()
	if hubSpawned then
		return
	end
	local hub = readHubInfo()
	if hub and hub.port > 0 then
		-- Verify process is actually alive via port probe later; cache for now
		hubInfoCache = hub
	end
	hubSpawned = true
	local argv = { bunBinary(), hubEntry() }
	tern.log.info("tern-bot: starting Onlyne Hub companion", argv[1], argv[2])
	pcall(tern.process.run, argv, {
		cwd = tern.plugin.dir,
		env = { TERN_PLUGIN_DATA = dataDir() },
	}, function(res: ProcessResult)
		hubSpawned = false
		tern.log.warn("tern-bot: Hub companion exited", res.status)
	end)
end

-- ---- Cached board state ----

local cachedBoard: BoardData = {
	hubNodeId = "urn:onlyne:hub:tern-bot",
	repoRoot = "",
	ledgerCount = 0,
	bots = {},
	leases = {},
	activity = nil,
}

local function formatDuration(secs: number): string
	local m = math.floor(secs / 60)
	local s = math.floor(secs % 60)
	if m > 0 then
		return string.format("%dm%02ds", m, s)
	end
	return string.format("%ds", s)
end

local function workerTone(w: WorkerRecord): string
	if w.intervening then
		return "accent"
	elseif w.needsReview then
		return "warning"
	elseif w.state == "WORKING" or w.state == "REVIEWING" or w.state == "DISPATCHED" then
		return "info"
	elseif w.state == "ACCEPTED" then
		return "success"
	elseif w.state == "REJECTED" then
		return "error"
	else
		return "muted"
	end
end

local function agentPhaseLabel(w: WorkerRecord): string
	if w.agentError and w.agentError ~= "" then
		return "启动失败"
	end
	local phase = w.agentPhase
	if phase == nil or phase == "" then
		return "未启动"
	end
	if phase == "working" then
		return "运行中"
	elseif phase == "idle" then
		return "空闲"
	elseif phase == "waiting_input" then
		return "等待输入"
	elseif phase == "starting" then
		return "启动中"
	elseif phase == "failed" then
		return "失败"
	elseif phase == "exited" then
		return "已退出"
	end
	return phase
end

local function agentPhaseTone(w: WorkerRecord): string
	if w.agentError and w.agentError ~= "" then
		return "error"
	end
	local phase = w.agentPhase
	if phase == "working" or phase == "starting" then
		return "info"
	elseif phase == "waiting_input" then
		return "warning"
	elseif phase == "idle" then
		return "success"
	elseif phase == "failed" or phase == "exited" then
		return "error"
	end
	return "muted"
end

-- ---- Per-pane state & lazy keyframe blob cache ----

type ThumbEntry = {
	seq: number,
	blob: string,
}

type State = {
	selectedBot: number,
	primaryMenu: string, -- "overview" | "dispatch" | "compute"
	selectedWorker: string?,
	thumbs: { [string]: ThumbEntry },
	fetchingSeq: { [string]: number },
}

local liveContexts: { [number]: BlockCx } = {}

local function renderAllBoards(): ()
	local alive: { [number]: boolean } = {}
	for _, p in tern.pane.list() do
		alive[p.pane] = true
	end
	for paneId, bcx in liveContexts do
		if alive[paneId] then
			bcx:render()
		else
			liveContexts[paneId] = nil
		end
	end
end

local function setActions(node: any, act: string): ()
	local p: { [string]: any } = node.p or {}
	p.actions = { click = act }
	node.p = p
end

local function parseAct(ev: UiEvent): (string, string?)
	local rawAct = if type(ev.act) == "string" then ev.act else ""
	if ev.value ~= nil and tostring(ev.value) ~= "" then
		return rawAct, tostring(ev.value)
	end
	local eqPos = string.find(rawAct, "=", 1, true)
	if eqPos ~= nil then
		return string.sub(rawAct, 1, eqPos - 1), string.sub(rawAct, eqPos + 1)
	end
	return rawAct, nil
end

-- Two bots both number their workers `worker-1`, so the cache key and the fetch carry the bot.
local function ensureWorkerThumb(state: State, cx: BlockCx, botId: string, w: WorkerRecord): string?
	local wantedSeq = w.thumbSeq or 0
	local key = botId .. "/" .. w.workerId
	local cached = state.thumbs[key]
	if wantedSeq <= 0 then
		return if cached then cached.blob else nil
	end
	if cached and cached.seq == wantedSeq then
		return cached.blob
	end
	if state.fetchingSeq[key] == wantedSeq then
		return if cached then cached.blob else nil
	end

	local hub = hubInfoCache or readHubInfo()
	if not hub then
		return if cached then cached.blob else nil
	end

	state.fetchingSeq[key] = wantedSeq
	local paneId = cx.pane
	local workerId = w.workerId
	local fallbackMime = w.thumbMime or "image/jpeg"

	tern.fetch(hub.adminUrl .. "/hub/thumb/" .. workerId .. "?bot=" .. botId, { timeout_ms = 2500 }, function(r)
		if r.error or r.status ~= 200 or #r.body == 0 then
			state.fetchingSeq[key] = nil
			return
		end
		local bcx = liveContexts[paneId]
		if not bcx then
			return
		end
		local mime = r.headers["content-type"] or fallbackMime
		local ok, blobId = pcall(function()
			return bcx:blob(r.body, mime)
		end)
		if ok and type(blobId) == "string" and blobId ~= "" then
			state.thumbs[key] = { seq = wantedSeq, blob = blobId }
			bcx:render()
		else
			state.fetchingSeq[key] = nil
		end
	end)

	return if cached then cached.blob else nil
end

-- ---- OrbStack-style Activity Monitor builder ----

local function buildActivityMonitor(act: ActivitySnapshot?, leaseCount: number): Node
	if not act then
		return ui.card("Activity Monitor", {
			ui.text({ ui.span("正在连接 Docker 算力监控采样器…", "muted") }),
		})
	end

	local rows: { Node } = {
		ui.el("div", { class = "tb-am-head" }, {
			ui.el("span", { class = "tb-am-name" }, { ui.text("Name") }),
			ui.el("span", { class = "tb-am-num" }, { ui.text("CPU %") }),
			ui.el("span", { class = "tb-am-num" }, { ui.text("Mem") }),
			ui.el("span", { class = "tb-am-num" }, { ui.text("Net") }),
			ui.el("span", { class = "tb-am-num" }, { ui.text("Disk") }),
		}),
	}

	-- Summary header row like OrbStack's "▾ Containers"
	table.insert(
		rows,
		ui.el("div", { class = "tb-am-row" }, {
			ui.el("span", { class = "tb-am-name" }, {
				ui.text({ ui.span("▾ Containers (" .. tostring(#act.containers) .. ")", "strong") }),
			}),
			ui.el("span", { class = "tb-am-num" }, { ui.text(act.totalCpuText) }),
			ui.el("span", { class = "tb-am-num" }, { ui.text(act.totalMemText) }),
			ui.el("span", { class = "tb-am-num" }, { ui.text(act.totalNetText) }),
			ui.el("span", { class = "tb-am-num" }, { ui.text(act.totalDiskText) }),
		})
	)

	for _, c in act.containers do
		local isSb = c.group == "sandbox"
		local dot = if isSb then ui.span("● ", "success") else ui.span("  ◦ ", "muted")
		local rowEl = ui.el("div", {
			class = if isSb then "tb-am-row is-sandbox" else "tb-am-row",
		}, {
			ui.el("span", { class = "tb-am-name" }, {
				ui.text({ dot, ui.span(c.name, if isSb then "strong" else nil) }),
			}),
			ui.el("span", { class = "tb-am-num" }, { ui.text(c.cpuText) }),
			ui.el("span", { class = "tb-am-num" }, { ui.text(c.memText) }),
			ui.el("span", { class = "tb-am-num" }, { ui.text(c.netText) }),
			ui.el("span", { class = "tb-am-num" }, { ui.text(c.diskText) }),
		})
		table.insert(rows, rowEl)
	end

	local function metricCard(label: string, valText: string, series: { { any } }, tone: string): Node
		local fallback: { { any } } = { { "t0" :: any, 0 :: any }, { "t1" :: any, 0 :: any } }
		local sparkSeries: { { any } } = if #series >= 2 then series else fallback
		local sparkNode = ui.spark(sparkSeries)
		local sp: { [string]: any } = sparkNode.p or {}
		sp.tone = tone
		sparkNode.p = sp
		return ui.el("div", { class = "tb-am-metric" }, {
			ui.el("div", { class = "tb-am-metric-top" }, {
				ui.text({ ui.span(label, "muted") }),
				ui.text({ ui.span(valText, "strong") }),
			}),
			sparkNode,
		})
	end

	local sweepBtn = ui.button("回收空闲沙箱 (" .. tostring(leaseCount) .. " 租约)", {
		variant = "quiet",
		size = "sm",
		icon = "trash",
	})
	setActions(sweepBtn, "cmdSweepLeases")

	return ui.card("Activity Monitor · 沙箱算力", {
		ui.el("div", { class = "tb-am-box" }, {
			ui.el("div", { class = "tb-am-list" }, rows),
			ui.el("div", { class = "tb-am-grid" }, {
				ui.el("div", { class = "tb-am-grid-row" }, {
					metricCard("Total CPU:", act.totalCpuText, act.series.cpu, "error"),
					metricCard("Memory:", act.totalMemText, act.series.mem, "info"),
				}),
				ui.el("div", { class = "tb-am-grid-row" }, {
					metricCard("Network:", act.totalNetText, act.series.net, "success"),
					metricCard("Disk:", act.totalDiskText, act.series.disk, "accent"),
				}),
			}),
			ui.row({ sweepBtn }),
		}),
	})
end

-- ---- Main Board Block ----

local board: BlockDef<State> = {
	font = "sans",
	init = function(cx, args, saved)
		liveContexts[cx.pane] = cx
		local initialBot = 1
		local initialWorker: string? = nil
		if args and #args > 0 and args[1] ~= "" then
			for idx, b in cachedBoard.bots do
				if b.botId == args[1] then
					initialBot = idx
					break
				end
			end
		end
		if saved and type(saved.selectedBot) == "number" then
			initialBot = saved.selectedBot
			initialWorker = saved.selectedWorker
		end
		return {
			selectedBot = initialBot,
			primaryMenu = if saved and saved.primaryMenu then saved.primaryMenu else "overview",
			selectedWorker = initialWorker,
			thumbs = {},
			fetchingSeq = {},
		}
	end,

	title = function(_state)
		local bots = cachedBoard.bots
		local nBots = #bots
		local nWaiting = 0
		for _, b in bots do
			if b.state == "waiting" then
				nWaiting += 1
			end
		end
		if nWaiting > 0 then
			return string.format("Tern Bot (%d 待审阅)", nWaiting)
		end
		return string.format("Tern Bot (%d Bot)", nBots)
	end,

	view = function(state, cx)
		local bots = cachedBoard.bots
		if #bots == 0 then
			local createBtn = ui.button("创建 Bot 工作区", { variant = "primary", icon = "plus" })
			setActions(createBtn, "cmdCreateBot")
			return {
				main = ui.el("div", { class = "tb-shell" }, {
					ui.card("Tern Bot 伴侣面板", {
						ui.text({ ui.span("尚未启动任何 Bot 实例。", "muted") }),
						ui.text({ ui.span("在命令面板运行 Tern Bot: Create Bot… 创建工作区视图。", "path") }),
						ui.row({ createBtn }),
					}),
				}),
			}
		end

		if state.selectedBot > #bots then
			state.selectedBot = 1
		end
		local bot = bots[state.selectedBot] or bots[1]

		if #bot.workers > 0 then
			local found = false
			for _, w in bot.workers do
				if w.workerId == state.selectedWorker then
					found = true
					break
				end
			end
			if not found then
				state.selectedWorker = bot.workers[1].workerId
			end
		else
			state.selectedWorker = nil
		end

		local upperChildren: { Node } = {}
		local lowerChildren: { Node } = {}

		-- =========================================================================
		-- UPPER 1: Centered Large Bot Avatar Header
		-- =========================================================================
		local statusTone = if bot.state == "waiting" then "warning" elseif bot.state == "working" then "accent" else "muted"
		local statusLabel = if bot.state == "waiting" then "WAITING 审阅中" elseif bot.state == "working" then "WORKING 调度中" else "IDLE 空闲"

		local avatarNode = ui.node("avatar", {
			variant = "square",
			text = bot.botId,
			seed = bot.botId,
			status = statusTone,
			size = "lg",
		})

		local botHeaderRow: Node
		if #bots > 1 then
			local prevBtn = ui.button("◀", { variant = "quiet", size = "sm" })
			setActions(prevBtn, "prevBot")
			local nextBtn = ui.button("▶", { variant = "quiet", size = "sm" })
			setActions(nextBtn, "nextBot")
			botHeaderRow = ui.row({ prevBtn, avatarNode, nextBtn })
		else
			botHeaderRow = ui.row({ avatarNode })
		end

		table.insert(
			upperChildren,
			ui.card("", {
				ui.el("div", { class = "tb-top" }, {
					botHeaderRow,
					ui.text({ ui.span(bot.botId, "strong") }),
					ui.badge(statusLabel, statusTone),
					ui.el("div", { class = "tb-ws-path" }, {
						ui.text({ ui.span(bot.workspace, "path muted") }),
					}),
				}),
			})
		)

		-- =========================================================================
		-- UPPER 2: Primary Horizontal Menu Strip
		-- =========================================================================
		local nContainers = if cachedBoard.activity then #cachedBoard.activity.containers else #cachedBoard.leases
		local menuTabs = ui.node("tabs", {
			items = {
				{ id = "overview", label = { ui.span("概览/指令") } },
				{ id = "dispatch", label = { ui.span("任务派发"), ui.span(" " .. #bot.workers, "muted") } },
				{ id = "compute", label = { ui.span("沙箱算力"), ui.span(" " .. nContainers, "muted") } },
			},
			active = state.primaryMenu,
		})
		local mp: { [string]: any } = menuTabs.p or {}
		mp.key = "primaryTabs"
		menuTabs.p = mp
		table.insert(upperChildren, menuTabs)

		-- =========================================================================
		-- UPPER 3: Secondary Action Box OR OrbStack Activity Monitor
		-- =========================================================================
		if state.primaryMenu == "compute" then
			table.insert(upperChildren, buildActivityMonitor(cachedBoard.activity, #cachedBoard.leases))
		else
			local actionButtons: { Node } = {}
			if state.primaryMenu == "overview" then
				local b1 = ui.button("创建新 Bot", { variant = "quiet", size = "sm", icon = "plus" })
				setActions(b1, "cmdCreateBot")
				local b2 = ui.button("唤醒 OMP 提问", { variant = "quiet", size = "sm", icon = "sparkle" })
				setActions(b2, "cmdAskOmp=" .. bot.botId)
				local b3 = ui.button("Onlyne 账本 (" .. cachedBoard.ledgerCount .. ")", { variant = "quiet", size = "sm", icon = "file-text" })
				setActions(b3, "cmdViewLedger")
				table.insert(actionButtons, b1)
				table.insert(actionButtons, b2)
				table.insert(actionButtons, b3)
			elseif state.primaryMenu == "dispatch" then
				local b1 = ui.button("派发子任务", { variant = "primary", size = "sm", icon = "plus" })
				setActions(b1, "cmdAskOmp=" .. bot.botId)
				local b2 = ui.button("刷新工作台", { variant = "quiet", size = "sm", icon = "refresh" })
				setActions(b2, "cmdRefresh")
				table.insert(actionButtons, b1)
				table.insert(actionButtons, b2)
			end
			table.insert(upperChildren, ui.card("快捷动作", { ui.row(actionButtons) }))
		end

		-- =========================================================================
		-- LOWER 1 (Bottom-Anchored): Fixed-height Scrollable Workers List
		-- =========================================================================
		local workerItems: { Node } = {}
		if #bot.workers == 0 then
			table.insert(
				workerItems,
				ui.text({ ui.span("当前无活动 Worker，可通过 OMP 或上方按钮派发任务。", "muted") })
			)
		else
			for _, w in bot.workers do
				local isSelected = (state.selectedWorker == w.workerId)
				local dotTone = workerTone(w)

				local metaNodes: { Node } = {
					ui.badge(w.state .. (if w.needsReview then " ★审阅" else ""), dotTone),
					ui.text({ ui.span(formatDuration(w.elapsedSecs), "muted") }),
				}
				if w.intervening then
					table.insert(metaNodes, ui.badge("人工接管中", "accent"))
				end

				local itemEl = ui.el("div", {
					key = "w-" .. w.workerId,
					class = if isSelected then "tb-worker-item is-selected" else "tb-worker-item",
					actions = { click = "selectWorker=" .. w.workerId },
				}, {
					ui.node("avatar", {
						variant = "circle",
						text = w.workerId,
						seed = w.workerId,
						size = "sm",
						status = dotTone,
					}),
					ui.el("div", { class = "tb-worker-body" }, {
						ui.text({
							ui.span(w.workerId, if isSelected then "strong" else nil),
							ui.span("  " .. (if w.title ~= "" then w.title else w.taskId), if isSelected then nil else "muted"),
						}),
						ui.row(metaNodes),
					}),
				})
				table.insert(workerItems, itemEl)
			end
		end

		table.insert(
			lowerChildren,
			ui.card(string.format("Workers 列表 (%d)", #bot.workers), {
				ui.el("div", { class = "tb-workers-scroll" }, workerItems),
			})
		)

		-- =========================================================================
		-- LOWER 2 (Bottom-Anchored): Selected Worker Detail Card
		--   Bottom-Left:  Clickable Miniature Desktop Keyframe Window (PiP)
		--   Bottom-Right: [请求介入] / [交还控制]
		-- =========================================================================
		if state.selectedWorker then
			local selWorker: WorkerRecord? = nil
			for _, w in bot.workers do
				if w.workerId == state.selectedWorker then
					selWorker = w
					break
				end
			end
			if selWorker then
				local w = selWorker
				local thumbBlob = ensureWorkerThumb(state, cx, bot.botId, w)

				local screenChild: Node
				if thumbBlob ~= nil then
					screenChild = ui.node("image", {
						key = "pip-img-" .. w.workerId,
						blob = thumbBlob,
						alt = "Sandbox Desktop Preview",
						w = 176,
						h = 98,
					})
				else
					screenChild = ui.el("div", { class = "tb-mini-pip-empty" }, {
						ui.text(if w.desktopUrl then "正在抓取桌面关键帧…\n点击弹出实时 PiP" else "暂无桌面画面"),
					})
				end

				local miniPipWindow = ui.el("div", {
					key = "mini-pip-" .. w.workerId,
					class = "tb-mini-pip",
					actions = { click = "pip=" .. bot.botId .. "/" .. w.workerId },
				}, {
					ui.el("div", { class = "tb-mini-pip-bar" }, {
						ui.text({ ui.span("● ", "success"), ui.span("PiP 桌面预览") }),
						ui.text("↗"),
					}),
					ui.el("div", { class = "tb-mini-pip-screen" }, { screenChild }),
				})

				local interveneBtn = ui.button(
					if w.intervening then "交还控制" else "请求介入",
					{
						variant = if w.intervening then "primary" else "quiet",
						size = "sm",
						icon = "hand",
					}
				)
				setActions(interveneBtn, "intervene=" .. bot.botId .. "/" .. w.workerId)

				local acpBtn = ui.button("打开会话", { variant = "quiet", size = "sm" })
				setActions(acpBtn, "acp=" .. bot.botId .. "/" .. w.workerId)

				local cardChildren: { Node } = {
					ui.kv({
						{ { ui.span("Worker / 任务") }, { ui.span(w.workerId .. " · " .. (if w.title ~= "" then w.title else w.taskId), "strong") } },
						{ { ui.span("状态 / 步数") }, { ui.span(w.state .. " · " .. tostring(w.observations) .. " 步 AX", workerTone(w)) } },
						{ { ui.span("沙箱 Agent") }, { ui.span(agentPhaseLabel(w), agentPhaseTone(w)) } },
					}),
				}

				if w.agentError and w.agentError ~= "" then
					table.insert(cardChildren, ui.text({ ui.span("Agent 启动失败: " .. w.agentError, "error") }))
				end

				if w.rejectionReason and w.rejectionReason ~= "" then
					table.insert(cardChildren, ui.text({ ui.span("驳回: " .. w.rejectionReason, "error") }))
				end

				table.insert(cardChildren, ui.el("div", { class = "tb-bottom" }, { miniPipWindow, interveneBtn, acpBtn }))
				table.insert(lowerChildren, ui.card("选中 Worker 详情", cardChildren))
			end
		end

		local upperClass = if state.primaryMenu == "compute" then "tb-upper is-compute" else "tb-upper"
		return {
			main = ui.el("div", { class = upperClass, role = "tern-bot.upper" }, upperChildren),
			dock = ui.el("div", { class = "tb-lower", role = "tern-bot.lower" }, lowerChildren),
		}
	end,

	key = function(state, key, _cx)
		local bots = cachedBoard.bots
		if #bots == 0 then
			return false
		end
		if key.name == "tab" or key.name == "[" then
			state.selectedBot = (state.selectedBot % #bots) + 1
			state.selectedWorker = nil
		elseif key.name == "1" then
			state.primaryMenu = "overview"
		elseif key.name == "2" then
			state.primaryMenu = "dispatch"
		elseif key.name == "3" then
			state.primaryMenu = "compute"
		elseif key.name == "j" or key.name == "down" then
			local bot = bots[state.selectedBot]
			if bot and #bot.workers > 0 then
				local cur = 1
				for i, w in bot.workers do
					if w.workerId == state.selectedWorker then
						cur = i
						break
					end
				end
				local nxt = (cur % #bot.workers) + 1
				state.selectedWorker = bot.workers[nxt].workerId
			end
		elseif key.name == "k" or key.name == "up" then
			local bot = bots[state.selectedBot]
			if bot and #bot.workers > 0 then
				local cur = 1
				for i, w in bot.workers do
					if w.workerId == state.selectedWorker then
						cur = i
						break
					end
				end
				local prv = cur - 1
				if prv < 1 then
					prv = #bot.workers
				end
				state.selectedWorker = bot.workers[prv].workerId
			end
		else
			return false
		end
		return true
	end,

	event = function(state, ev, cx)
		if ev.ev == "action" then
			local verb, arg = parseAct(ev)
			if verb == "prevBot" then
				local n = #cachedBoard.bots
				if n > 0 then
					state.selectedBot = if state.selectedBot <= 1 then n else state.selectedBot - 1
					state.selectedWorker = nil
					cx:render()
				end
			elseif verb == "nextBot" then
				local n = #cachedBoard.bots
				if n > 0 then
					state.selectedBot = if state.selectedBot >= n then 1 else state.selectedBot + 1
					state.selectedWorker = nil
					cx:render()
				end
			elseif verb == "selectWorker" and arg then
				state.selectedWorker = arg
				cx:render()
			elseif verb == "cmdRefresh" then
				cx:render()
			elseif verb == "cmdCreateBot" then
				cx:open("tern-bot://create")
			elseif verb == "cmdAskOmp" and arg then
				cx:open("tern-bot://ask/" .. arg)
			elseif verb == "cmdViewLedger" then
				local hub = hubInfoCache or readHubInfo()
				if hub then
					cx:open(hub.adminUrl .. "/hub/ledger")
				end
			elseif verb == "cmdSweepLeases" then
				local hub = hubInfoCache or readHubInfo()
				if hub then
					tern.fetch(hub.adminUrl .. "/hub/compute", {
						method = "POST",
						body = tern.json.encode({ operation = "sweep" }),
						headers = { ["content-type"] = "application/json" },
					}, function(r)
						if not r.error then
							cx:toast("success", "已清理过期空闲沙箱")
						end
					end)
				end
			elseif verb == "pip" and arg then
				cx:open("tern-bot://pip/" .. arg)
			elseif verb == "intervene" and arg then
				cx:open("tern-bot://intervene/" .. arg)
			elseif verb == "acp" and arg then
				cx:open("tern-bot://acp/" .. arg)
			end
		elseif ev.ev == "select" then
			if ev.item == "overview" or ev.item == "dispatch" or ev.item == "compute" then
				state.primaryMenu = ev.item
				cx:render()
			end
		end
	end,

	save = function(state)
		return {
			selectedBot = state.selectedBot,
			primaryMenu = state.primaryMenu,
			selectedWorker = state.selectedWorker,
		}
	end,
}

tern.block.define("board", board)

-- ---- Background poll: query hub companion /hub/status ----

local function pollHubStatus()
	local hub = hubInfoCache or readHubInfo()
	if not hub then
		spawnHub()
		tern.timer(HUB_JSON_POLL_MS, pollHubStatus)
		return
	end
	hubInfoCache = hub

	tern.fetch(hub.adminUrl .. "/hub/status", { timeout_ms = 2500 }, function(r)
		if r.error or r.status ~= 200 then
			hubInfoCache = nil
			spawnHub()
			tern.timer(1500, pollHubStatus)
			return
		end
		local ok, data = pcall(tern.json.decode, r.body)
		if ok and type(data) == "table" and type(data.bots) == "table" then
			cachedBoard = data
			tern.kv.set("tern-bot.board", data)
			renderAllBoards()
		end
		tern.timer(PROBE_MS, pollHubStatus)
	end)
end

if not readHubInfo() then
	spawnHub()
end
pollHubStatus()
