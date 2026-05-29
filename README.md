# CloXde

> Cl(aude) + (c)o(de)X + de(sktop) — a local desktop console for orchestrating
> the Claude Code CLI and Codex CLI to collaborate on software engineering tasks.

See [DESIGN.md](./DESIGN.md) for the full design.

## Status

All roadmap milestones from DESIGN §7 implemented:

| Milestone | Status | Highlights |
|---|---|---|
| **v0.1** Skeleton | ✅ | electron-vite + React + TS, 3-layer IPC, CLI Detector, SQLite + projects |
| **v0.2** Single Terminal | ✅ | `PtyManager` (node-pty), xterm.js bidirectional flow, sessions persistence |
| **v0.3** Multi-Session | ✅ | Sidebar tree, split workspace with two panes, cwd override, keyboard shortcuts |
| **v0.4** Orchestrator MVP | ✅ | Architect-Executor template, Plan/Run/Step engine, idle-based completion + manual mark |
| **v0.5** Cross-Review & Race | ✅ | Cross-Review template (`{{prev}}`-driven review); Race step type with parallel spawn + Pick winner |
| **v1.0** Visual Workflow | ✅ | `@xyflow/react` PlanGraph; live-coloured nodes mirror run-step status |

## Development

```bash
pnpm install
pnpm dev
```

First run will:

1. Create `~/.cloxde/` for the SQLite DB and `config.json`.
2. Detect `claude` / `codex` CLIs in the background.
3. Show an empty-state hero — click **Open folder as project** to get started.

### Native modules on Windows

`better-sqlite3` and `node-pty` ship N-API prebuilds, so they load under
Electron without rebuilding. If you ever hit an ABI mismatch:

```bash
pnpm rebuild
```

## Architecture

```
src/
├── main/                  Node-side (Electron main process)
│   ├── index.ts           App lifecycle
│   ├── ipc.ts             Whitelisted IPC handlers
│   ├── paths.ts           ~/.cloxde paths
│   ├── cli-detector.ts    claude / codex resolver (cache → PATH → fallback)
│   ├── pty/
│   │   ├── manager.ts     node-pty session manager + idle detector
│   │   └── ring-buffer.ts 256 KB output replay buffer
│   ├── orchestrator/
│   │   ├── engine.ts          Plan/Run/Step driver (sequential + race)
│   │   ├── completion-detector.ts  idle / manual / timeout / exit signals
│   │   └── templates/
│   │       ├── architect-executor.ts
│   │       ├── cross-review.ts
│   │       └── race.ts
│   └── storage/
│       ├── db.ts          better-sqlite3 + repos (project/session/plan/run/run_step)
│       └── migrations.ts  schema migrations (v1 init, v2 run_steps extend, v3 sub_index)
├── preload/index.ts       contextBridge — exposes `window.api`
├── renderer/
│   ├── index.html
│   └── src/
│       ├── App.tsx        Compose Sidebar + Workspace/PlanGraph + Inspector + dialogs
│       ├── components/
│       │   ├── Sidebar.tsx       Project tree → sessions
│       │   ├── Workspace.tsx     Two-pane split (Pane + tabs)
│       │   ├── Pane.tsx          Per-pane tab strip + terminal
│       │   ├── TerminalView.tsx  xterm.js + ring-buffer replay
│       │   ├── PlanBar.tsx       Run status header (steps, race pick, cancel)
│       │   ├── PlanGraph.tsx     react-flow workflow visualiser
│       │   ├── NewSessionDialog.tsx
│       │   └── RunPlanDialog.tsx Template picker + task prompt
│       └── hooks/
│           ├── useSessions.ts
│           └── useRun.ts
└── shared/                Types + IPC channel names shared by all sides
    ├── types.ts
    └── ipc-channels.ts
```

## Keyboard shortcuts (DESIGN §5.2)

| Shortcut | Action |
|---|---|
| `Ctrl`+`1` / `Ctrl`+`2` | Focus left / right pane |
| `Ctrl`+`Tab` | Cycle tabs in focused pane |
| `Ctrl`+`Shift`+`N` | New session dialog |
| `Ctrl`+`Shift`+`R` | Run plan dialog |

## Orchestrator templates

| Template | Step kinds | When to use |
|---|---|---|
| **Architect → Executor** | `agent` (claude) → `agent` (codex) | The claude side drafts the plan, codex implements it from the plan. |
| **Cross-Review** | `agent` (implementer) → `agent` (reviewer) | Get a second pair of eyes — implementer writes, reviewer audits. |
| **Race** | `race` (claude ‖ codex) | Both agents tackle the same task. You pick the winner whenever you want; losers are killed. |

Completion detection (DESIGN §6) is multi-strategy:

- **Idle window** (6 s of no PTY output → "done")
- **Manual override** — `Mark step complete` button on the Plan Bar
- **Race winner pick** — explicit per-step UI for race steps
- **Safety timeout** — 5 min per step
- **Exit** — process exiting always settles the step
