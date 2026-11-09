--!strict
-- tern-bot window half: commands, ratio-locked workspace creation, link routes, and the
-- native floating PiP the board's buttons ask for.
--
--   1. Command `Tern Bot: Create Bot…` browses the filesystem for a workspace — the picker
--      lists the current directory's live subdirectories and filters them as the user types,
--      and entering one browses its children — then prompts for a bot name and builds the
--      workspace tab with `cx.layout:tab(spec)` at an exact `0.76 / 0.24` split, so the
--      companion pane is never shown at one half first.
--   2. The new pane launches standard `omp` with `PI_CODING_AGENT_DIR` pointing at the
--      bot config root, so it loads only the bot profile and the tern-bot extension.
--   3. The board's buttons are blocks: they only have `open`, so they hand work here through
--      `tern-bot://` links. `pip` calls Tern's native browser PiP (`cx.browser:call({ op = "open", ... })`)
--      or `cx.layout:float(..., "br")`; `intervene` toggles human takeover; `create` runs the wizard.

local BOARD_KIND = "tern-bot.board"
local SIDEBAR_RATIO = 0.24

local openedFor: { [string]: boolean } = {}

local function hubJsonPath(): string
	return tern.plugin.data .. "/hub.json"
end

type HubInfo = {
	adminUrl: string,
	repoRoot: string,
	ompBin: string,
	botConfigDir: string,
}

local function readHub(): HubInfo?
	if not tern.fs.exists(hubJsonPath()) then
		return nil
	end
	local ok, value = pcall(function()
		return tern.json.decode(tern.fs.read(hubJsonPath(), 65536))
	end)
	if not ok or type(value) ~= "table" then
		return nil
	end
	if type(value.adminUrl) ~= "string" then
		return nil
	end
	return value
end

local function boardPaneId(cx: WindowCx): number?
	for _, pane in cx.session:panes() do
		if pane.program == BOARD_KIND then
			return pane.pane
		end
	end
	return nil
end

local function openBoardBeside(cx: WindowCx, targetPane: number?, botId: string?): number?
	local existingBoard = boardPaneId(cx)
	if existingBoard ~= nil then
		return existingBoard
	end
	local target = targetPane or cx.session:focused()
	if not target then
		return nil
	end
	local args: { string } = {}
	if botId ~= nil and botId ~= "" then
		args = { botId }
	end
	return cx:new_block(BOARD_KIND, args, "beside", {
		target = target,
		dir = "right",
		ratio = SIDEBAR_RATIO,
		focus = false,
	})
end

local function isBotCommand(line: string?): boolean
	if type(line) ~= "string" then
		return false
	end
	return string.find(line, "TERN_BOT_ID=") ~= nil
end

tern.on("command_started", function(ev, cx)
	if not isBotCommand(ev.line) then
		return
	end
	local key = "cmd-" .. tostring(ev.pane)
	if openedFor[key] then
		return
	end
	openedFor[key] = true
	openBoardBeside(cx, ev.pane)
end)

-- A block only has `open`, so a link route is where a fresh WindowCx for layout work comes from.
local winContext: WindowCx? = nil

-- ---- native floating PiP ----

local function openFloatingPiP(url: string, ownerPane: number?)
	local winCx = winContext
	if winCx == nil then
		return
	end
	local anchor = ownerPane or winCx.session:focused()
	if anchor == nil then
		return
	end

	-- 1. Prefer Tern's native browser PiP API: cx.browser:call({ op = "open", corner = "br", ... })
	local browserSupported = pcall(function()
		winCx.browser:call({
			op = "open",
			owner = anchor,
			url = url,
			corner = "br",
			width = 540,
			height = 360,
			show = true,
		})
	end)

	if browserSupported then
		winCx:toast("info", "PiP 悬浮画中画已开启", "右下角悬浮窗")
		return
	end

	-- 2. Fallback: create browser block and float over anchor with cx.layout:float(..., "br")
	local pane = winCx:new_block("browser", { url }, "split", { focus = false })
	if pane == nil then
		winCx:toast("error", "PiP 打开失败", "没有可用的浏览器块")
		return
	end
	local ok = winCx.layout:float(pane, anchor, "br", { focus = false })
	if not ok then
		winCx:toast("info", "PiP 已打开", "该块不支持浮动，已置于分栏")
	end
end

-- ---- create wizard ----

local function createBotTab(cx: WindowCx, botId: string, workspacePath: string): ()
	local hub = readHub()
	local ompBin = if hub ~= nil and hub.ompBin ~= "" then hub.ompBin else "omp"
	local botConfigDir = if hub ~= nil and hub.botConfigDir ~= "" then hub.botConfigDir else (tern.getenv("HOME") or "") .. "/.config/tern-bot"

	local cleanId = string.gsub(botId, "[^%w%-_]", "")
	if cleanId == "" then
		cleanId = "bot-1"
	end

	-- Register first: the board shows the card while `omp` is still booting.
	if hub ~= nil then
		tern.fetch(hub.adminUrl .. "/hub/bots", {
			method = "POST",
			headers = { ["content-type"] = "application/json" },
			body = tern.json.encode({ botId = cleanId, workspace = workspacePath, state = "starting" }),
		}, function() end)
	end

	local spec: TabSpec = {
		name = "Bot: " .. cleanId,
		cwd = workspacePath,
		split = "right",
		ratio = 0.76,
		[1] = {
			cwd = workspacePath,
			launch = {
				cwd = workspacePath,
				command = string.format(
					"TERN_BOT_ID=%s PI_CODING_AGENT_DIR='%s' '%s'",
					cleanId,
					botConfigDir,
					ompBin
				),
			},
		},
		[2] = {
			launch = {
				block = BOARD_KIND,
				args = { cleanId },
			},
		},
	}

	local tabId, failure = cx.layout:tab(spec, { focus = true })
	if tabId == nil then
		cx:toast("error", "创建 Bot 视图失败", failure)
	else
		cx:toast("success", "已创建 Bot 视图: " .. cleanId, workspacePath)
	end
end

-- ---- workspace picker ----
--
-- Tern's picker takes a fixed item list and filters it on the labels as the user types, and
-- its text prompt has no completion; no plugin API reports the picker's query per keystroke.
-- So suggestions are fetched from the live filesystem one directory at a time: the list is
-- this directory's actual subdirectories, typing narrows them in realtime, and picking one
-- browses its children. Choosing "使用此目录" accepts the level the user stands in.

local MAX_SUBDIR_ITEMS = 400
local MAX_SCANNED_ENTRIES = 4000

local function trimSpaces(value: string): string
	return (string.gsub(string.gsub(value, "^%s+", ""), "%s+$", ""))
end

local function joinPath(dir: string, name: string): string
	if string.sub(dir, -1) == "/" then
		return dir .. name
	end
	return dir .. "/" .. name
end

local function normalizePath(path: string): string
	local absolute = string.sub(path, 1, 1) == "/"
	local parts: { string } = {}
	for segment in string.gmatch(path, "[^/]+") do
		if segment == ".." then
			if #parts > 0 and parts[#parts] ~= ".." then
				table.remove(parts)
			elseif not absolute then
				table.insert(parts, segment)
			end
		elseif segment ~= "." then
			table.insert(parts, segment)
		end
	end
	local joined = table.concat(parts, "/")
	if not absolute then
		return joined
	end
	return if joined == "" then "/" else "/" .. joined
end

local function parentPath(path: string): string?
	local trimmed = path
	if #trimmed > 1 and string.sub(trimmed, -1) == "/" then
		trimmed = string.sub(trimmed, 1, -2)
	end
	local parent = string.match(trimmed, "^(.*)/[^/]+$")
	if parent == nil then
		return nil
	end
	return if parent == "" then "/" else parent
end

local function isDirectory(path: string): boolean
	local ok, entries = pcall(tern.fs.list, path)
	return ok and type(entries) == "table"
end

-- Live subdirectories, visible ones first; a child is a directory when listing it succeeds.
local function listSubdirectories(dir: string): ({ string }, string?)
	local ok, entries = pcall(tern.fs.list, dir)
	if not ok or type(entries) ~= "table" then
		return {}, dir
	end
	local visible: { string } = {}
	local hidden: { string } = {}
	local scanned = 0
	for _, name in ipairs(entries :: { string }) do
		scanned += 1
		if scanned > MAX_SCANNED_ENTRIES or #visible + #hidden >= MAX_SUBDIR_ITEMS then
			break
		end
		if isDirectory(joinPath(dir, name)) then
			table.insert(if string.sub(name, 1, 1) == "." then hidden else visible, name)
		end
	end
	for _, name in ipairs(hidden) do
		table.insert(visible, name)
	end
	return visible, nil
end

local function expandPath(raw: string, base: string): string
	local value = trimSpaces(raw)
	if value == "" then
		return base
	end
	if value == "~" then
		value = tern.getenv("HOME") or ""
	elseif string.sub(value, 1, 2) == "~/" then
		value = (tern.getenv("HOME") or "") .. string.sub(value, 2)
	end
	if string.sub(value, 1, 1) ~= "/" then
		value = joinPath(base, value)
	end
	return normalizePath(value)
end

local function focusedPaneCwd(cx: WindowCx): string?
	local focused = cx.session:focused()
	if focused == nil then
		return nil
	end
	local pane = cx.session:pane(focused)
	if pane == nil or type(pane.cwd) ~= "string" or pane.cwd == "" or not isDirectory(pane.cwd) then
		return nil
	end
	return normalizePath(pane.cwd)
end

local function defaultWorkspace(cx: WindowCx): string
	local focused = focusedPaneCwd(cx)
	if focused ~= nil then
		return focused
	end
	local pwd = tern.getenv("PWD")
	if type(pwd) == "string" and pwd ~= "" and isDirectory(pwd) then
		return normalizePath(pwd)
	end
	local hub = readHub()
	if hub ~= nil and hub.repoRoot ~= "" and isDirectory(hub.repoRoot) then
		return normalizePath(hub.repoRoot)
	end
	local home = tern.getenv("HOME")
	if type(home) == "string" and home ~= "" then
		return normalizePath(home)
	end
	return "/"
end

type WorkspaceChoice = (string, WindowCx) -> ()

local function promptManualPath(cx: WindowCx, base: string, onPick: WorkspaceChoice, initial: string?): ()
	cx:prompt({
		value = initial or (if base == "/" then "/" else base .. "/"),
		placeholder = "工作区绝对路径（支持 ~/…）",
		label = "工作区路径",
		icon = "folder",
		action = "继续",
	}):next(function(raw: any, _, pcx: WindowCx?)
		if raw == nil or pcx == nil then
			return
		end
		local path = expandPath(tostring(raw), base)
		if not isDirectory(path) then
			pcx:toast("error", "目录不存在", path)
			promptManualPath(pcx, base, onPick, tostring(raw))
			return
		end
		onPick(path, pcx)
	end)
end

local function browseWorkspace(cx: WindowCx, dir: string, onPick: WorkspaceChoice): ()
	local current = normalizePath(dir)
	local subdirs, failure = listSubdirectories(current)
	if failure ~= nil then
		cx:toast("error", "无法读取目录", current)
		promptManualPath(cx, current, onPick)
		return
	end

	local items: { any } = {
		{
			label = "使用此目录",
			detail = current,
			group = "当前目录",
			icon = "check",
			path = current,
			kind = "use",
			current = true,
		},
	}
	local parent = parentPath(current)
	if parent ~= nil then
		table.insert(items, {
			label = "..",
			detail = parent,
			group = "导航",
			icon = "arrow-up",
			path = parent,
			kind = "up",
		})
	end
	table.insert(items, {
		label = "输入路径…",
		detail = "手动输入绝对路径或 ~/…",
		group = "导航",
		icon = "edit",
		kind = "manual",
	})
	for _, name in ipairs(subdirs) do
		local child = joinPath(current, name)
		table.insert(items, {
			label = name,
			detail = child,
			group = "子目录",
			icon = "folder",
			path = child,
			kind = "dir",
		})
	end

	cx:pick({
		items = items,
		placeholder = current,
		icon = "folder",
		action = "选择",
	}):next(function(picked: any, _, pcx: WindowCx?)
		if picked == nil or pcx == nil then
			return
		end
		if picked.kind == "use" then
			onPick(current, pcx)
		elseif picked.kind == "manual" then
			promptManualPath(pcx, current, onPick)
		elseif type(picked.path) == "string" then
			browseWorkspace(pcx, picked.path, onPick)
		end
	end)
end

local function runCreateWizard(cx: WindowCx): ()
	browseWorkspace(cx, defaultWorkspace(cx), function(workspace: string, wcx: WindowCx)
		wcx:prompt({
			placeholder = "bot-1",
			value = "bot-1",
			label = "Bot 名称",
		}):next(function(name: any, _, ncx: WindowCx?)
			if ncx == nil then
				return
			end
			local botId = if type(name) == "string" and name ~= "" then name else "bot-1"
			createBotTab(ncx, botId, workspace)
		end)
	end)
end

-- ---- link routes ----

tern.route.link(function(req, cx)
	winContext = cx

	if req.url == "tern-bot://create" then
		runCreateWizard(cx)
		return { handled = true }
	end

	local ask = string.match(req.url, "^tern%-bot://ask/(.+)$")
	if ask ~= nil then
		local botId = ask
		cx:prompt({ placeholder = "输入指令…", label = "向 " .. botId .. " 下发指令" }):next(function(txt, _, lcx)
			if txt == nil or txt == "" or lcx == nil then
				return
			end
			lcx:ask_carly(txt)
		end)
		return { handled = true }
	end

	local pip = string.match(req.url, "^tern%-bot://pip/(.+)$")
	if pip ~= nil then
		local botId, workerId = string.match(pip, "^([^/]+)/(.+)$")
		if botId == nil or workerId == nil then
			cx:toast("error", "无效的 PiP 链接", pip)
			return { handled = true }
		end
		local hub = readHub()
		if hub == nil then
			cx:toast("error", "Hub 未就绪", "无法解析该 Worker 的桌面地址")
			return { handled = true }
		end
		local owner = cx.session:focused()
		tern.fetch(hub.adminUrl .. "/hub/worker/" .. workerId .. "?bot=" .. botId, { timeout_ms = 3000 }, function(r, lcx)
			if r.error or r.status ~= 200 or lcx == nil then
				cx:toast("error", "Worker 查询失败", workerId)
				return
			end
			local ok, data = pcall(tern.json.decode, r.body)
			if not ok or type(data) ~= "table" or type(data.pipUrl) ~= "string" then
				cx:toast("error", "该 Worker 没有桌面地址", workerId)
				return
			end
			winContext = lcx
			openFloatingPiP(data.pipUrl, type(data.mainPane) == "number" and data.mainPane or owner)
		end)
		return { handled = true }
	end

	local intervene = string.match(req.url, "^tern%-bot://intervene/(.+)$")
	if intervene ~= nil then
		local botId, workerId = string.match(intervene, "^([^/]+)/(.+)$")
		if botId == nil or workerId == nil then
			cx:toast("error", "无效的介入链接", intervene)
			return { handled = true }
		end
		local hub = readHub()
		if hub == nil then
			cx:toast("error", "Hub 未就绪", "无法请求介入")
			return { handled = true }
		end
		tern.fetch(hub.adminUrl .. "/hub/intervene", {
			method = "POST",
			headers = { ["content-type"] = "application/json" },
			body = tern.json.encode({ workerId = workerId, botId = botId }),
		}, function(r, lcx)
			if r.error or r.status ~= 200 or lcx == nil then
				cx:toast("error", "介入请求失败", workerId)
				return
			end
			local ok, data = pcall(tern.json.decode, r.body)
			if not ok or type(data) ~= "table" then
				return
			end
			if data.intervening == true then
				lcx:toast("info", "已接管控制权", "Bot 已暂停自动推进，可手动操作沙箱")
				if type(data.interveneUrl) == "string" then
					winContext = lcx
					openFloatingPiP(data.interveneUrl, type(data.mainPane) == "number" and data.mainPane or nil)
				end
			else
				lcx:toast("success", "已交还控制权", "Bot 恢复自动推进")
			end
		end)
		return { handled = true }
	end

	-- A Worker's ACP chat lives in its sandbox. The pane only attaches to the resident
	-- agent, so closing it detaches and the same session reopens here.
	local acp = string.match(req.url, "^tern%-bot://acp/(.+)$")
	if acp ~= nil then
		local botId, workerId = string.match(acp, "^([^/]+)/(.+)$")
		if botId == nil or workerId == nil then
			cx:toast("error", "无效的会话链接", acp)
			return { handled = true }
		end
		local hub = readHub()
		if hub == nil then
			cx:toast("error", "Hub 未就绪", "无法解析该 Worker 的会话")
			return { handled = true }
		end
		tern.fetch(hub.adminUrl .. "/hub/status", { timeout_ms = 3000 }, function(r, lcx)
			if r.error or r.status ~= 200 or lcx == nil then
				cx:toast("error", "Worker 查询失败", workerId)
				return
			end
			local ok, data = pcall(tern.json.decode, r.body)
			if not ok or type(data) ~= "table" or type(data.bots) ~= "table" then
				cx:toast("error", "Worker 状态无法解析", workerId)
				return
			end
			for _, bot in data.bots do
				if bot.botId == botId and type(bot.workers) == "table" then
					for _, worker in bot.workers do
						if worker.workerId == workerId then
							if type(worker.acpPaneCommand) ~= "string" or worker.acpPaneCommand == "" then
								cx:toast("info", "该 Worker 没有常驻会话", workerId)
								return
							end
							lcx.layout:tab({
								name = "Worker: " .. botId .. "/" .. workerId,
								launch = { command = worker.acpPaneCommand },
							}, { focus = true })
							return
						end
					end
				end
			end
			cx:toast("error", "未找到该 Worker", workerId)
		end)
		return { handled = true }
	end

	return nil
end)

-- ---- palette commands ----

tern.command({
	id = "create-bot",
	title = "Tern Bot: Create Bot…",
	run = function(cx)
		winContext = cx
		runCreateWizard(cx)
	end,
})

tern.command({
	id = "bot-board-toggle",
	title = "Tern Bot: Toggle Board",
	run = function(cx)
		local pane = boardPaneId(cx)
		if pane ~= nil then
			cx.layout:close(pane)
			return
		end
		openBoardBeside(cx)
	end,
})

tern.command({
	id = "bot-board-focus",
	title = "Tern Bot: Focus Board",
	run = function(cx)
		local pane = boardPaneId(cx)
		if pane ~= nil then
			cx.layout:focus(pane)
			return
		end
		local opened = openBoardBeside(cx)
		if opened ~= nil then
			cx.layout:focus(opened)
		end
	end,
})
