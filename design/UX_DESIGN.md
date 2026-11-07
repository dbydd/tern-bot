# 对人的 UI/UX 设计

## 设计原则

信息按需浮现，不要堆在一起。Bot 在工作时用户不需要看它；它需要用户时应该自动找到用户。沙箱是用来看的，不是用来管的。所有配置在一个地方，不散落各处。

---

## 一、状态条（OMP 编辑器上方，常驻）

```
● Working  Bot-1  │  2 workers  PR #14 needs review  │  ⬡ 2 sandboxes  TTL 47m  │  ⬗ hindsight
```

这一行始终占据 OMP 编辑器上方，通过 `pi-tui` 的 `aboveEditor` 挂件渲染（与 omp-hindsight 状态条同一层）。

从左到右：

**Bot 身份**：`● Working` / `● Idle` / `● Waiting`，颜色分别是 success / muted / warning。紧跟实例名（默认取 hostname 缩写）。

**活跃工作**：显示当前正在跑的 worker 数。如果有 PR 等待 review，变成高亮的 `PR #14 needs review`（warning 色）。点击直接打开 review sheet。没有活跃工作时这段隐藏。

**沙箱状态**：显示沙箱数量和最短 TTL 倒计时。低于 10 分钟时倒计时变红。点击展开租约列表。

**记忆连接**：`⬗ hindsight` 或 `⬗ offline`，muted 色。点击打开 hindsight sheet。

宽度不够时，按重要性从右往左折叠（记忆连接先折叠）。

---

## 二、Bot 控制台 Sheet（`/bot` 命令 或 点击状态条触发）

居中玻璃板，`size: "lg"`，三个 tab。

### Overview tab

```
┌────────────────────────────────────────────────────────┐
│  Bot-1  ●  Working                                     │
│  github.com/you/your-project  ·  main                  │
├────────────────────────────────────────────────────────┤
│  Context window                                        │
│  ████████████░░░░░░░░  38% / 128k tokens               │
│  Prefix 12%  ·  Infix 8%  ·  History 18%              │
├────────────────────────────────────────────────────────┤
│  Active workers                                        │
│  worker-2  fix/auth-bug   WORKING   14m               │
│  worker-3  feat/cache     REVIEW ★  3m  ← needs you   │
├────────────────────────────────────────────────────────┤
│                            [Open Sandbox]  [Settings]  │
└────────────────────────────────────────────────────────┘
```

Context window 用细 meter 条，三段不同颜色（prefix 蓝，infix 紫，history 绿），直观呈现三段比例。

Worker 列表：name · branch · 状态 · 运行时长。REVIEW 状态的行整行高亮，右侧 `★` 标记。

### Workers tab

每个 worker 一张卡：

```
worker-2                                      ● WORKING  14m
branch: fix/auth-bug
"Running tests, 12/47 passed…"

[View Sandbox]  [Send message]  [Stop]
```

`View Sandbox` 在 Tern 旁边打开 browser pane，直接显示该 worker 沙箱的 noVNC 画面。不需要复制粘贴 URL。

`Send message` 打开单行输入，通过 Onlyne 向 worker agent 发消息。

### Review tab（有待审 PR 时标红点）

```
PR #14  fix/auth-bug → main
Opened 23 minutes ago by worker-2

Changes: +142 −38  ·  3 files

Test results
  ✓ unit tests    47/47
  ✓ type check
  ✗ e2e tests     2 failed
    auth_flow_test.ts : 89
    session_test.ts   : 203

[View test log]  [Open Sandbox]

──────────────────────────────────

[Reject with note]              [Merge]
```

`Merge` 绿色，点击弹确认气泡 "Merge fix/auth-bug into main?"。`Reject with note` 打开文本输入，反馈会发给 worker agent。

两个按钮都需要一次确认才执行，不能误触。

---

## 三、沙箱画中画

不自己写渲染器，直接用 Tern 的内置 browser pane 打开 noVNC URL。

Tern plugin 的 window.luau 调用 `cx.session:open_pane("browser", url)` 打开，pane 标题是 `sandbox: worker-2 / fix/auth-bug`。

用户可以把这个 pane 拖成浮动 picture-in-picture，在终端一角持续监视沙箱桌面。

介入模式：用户直接在 noVNC pane 里点击和输入，Tern 本身就支持这个，不需要额外设计。

---

## 四、Tern 看板侧边栏（多 Bot 场景的常驻折叠面板）

Tern plugin 的 window.luau 在侧边渲染：

```
▸ Bot-1  ● Working
  worker-2  WORKING  14m
  worker-3  REVIEW ★

▸ Bot-2  ● Idle
  (no active workers)
```

点击 Bot 名跳转到对应 OMP session。点击 worker 行打开沙箱画中画。`★` 行点击打开 review sheet。

---

## 五、Review 在哪里发生

Review 不需要离开主 OMP 对话。点击状态条的 `PR #14 needs review` 或输入 `/bot`，overlay 就打开了，在同一个 session 里批准或打回。

Bot 已经在自己的沙箱里把测试跑完了，结果直接呈现在 Review tab。用户不需要去切 tab 或手动跑任何东西。
