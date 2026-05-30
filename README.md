# CloXde

> **Cl**(aude) + **co**(de)**X** + **de**(sktop) — a local desktop console that
> orchestrates coding agents (Claude Code, Codex, Hermes) to collaborate on
> software-engineering tasks, with a companion mobile/tablet app for steering a
> run from your couch.

CloXde runs a **three-agent team** — 产品经理 (PM) → 架构师 (Architect) →
执行者 (Executor) — over the [Agent Client Protocol (ACP)](https://agentclientprotocol.com).
You describe a task in plain language; the PM clarifies it with you, the
architect plans and delegates, the executor does the actual file edits and
shell work, and CloXde drives the whole loop on autopilot until the task is
done — or until it needs you again.

> ⚠️ **Status:** v0.6 — active development. The product UI and agent prompts
> are in Chinese. `DESIGN.md` describes an earlier pty/terminal design and is
> kept only for history; the current architecture is ACP-based as described
> below.

## Highlights

- **3-agent orchestration over ACP.** Each role is its own adapter process
  (one ACP session per side). The architect decides — turn by turn — whether to
  `<<DELEGATE>>` to the executor, declare `<<DONE>>`, or keep chatting with the
  user. A pure task state machine (`briefing → planning → executing → review →
  done/failed`) gates what each role is allowed to do.
- **Autopilot with bounded auto-retry.** CloXde shuttles hand-offs between
  sides automatically, recovers from adapter crashes mid-turn, and stops to ask
  the user only when it actually needs input.
- **Automatic context compaction.** When a side's ACP session overflows the
  model's context window, CloXde abandons the bloated session, builds a summary
  from its own DB (task state + recent turns), and reseeds a fresh session — so
  long runs survive without you opening a new conversation.
- **Pluggable agents.** Ships with Claude Code, Codex, and Hermes adapters;
  custom binaries can be wired in via the agent profile settings.
- **Mobile/tablet companion.** A React Native app (`mobile/`) pairs with the
  desktop over your LAN (QR code + PIN + bearer token) and mirrors the
  conversation, team panel, file explorer, and working-tree diff live over
  WebSocket.

## How a turn flows

```
        ┌──────────┐  <<HANDOFF>>   ┌────────────┐  <<DELEGATE>>  ┌────────────┐
 user → │    PM    │ ─────────────▶ │ Architect  │ ─────────────▶ │  Executor  │
        │ (产品经理) │ ◀───────────── │  (架构师)   │ ◀───────────── │  (执行者)   │
        └──────────┘  team report   └────────────┘   <<REPORT>>     └────────────┘
              │                            │
              │  <<DONE>> / <<FAIL>>        │  edits files, runs tools
              ▼                            ▼
        wraps up for the user        the only side that touches the repo
```

- The **PM** turns a fuzzy idea into a brief and hands it off (`<<HANDOFF>>`).
- The **Architect** plans (`<<PLAN>>`), delegates concrete work
  (`<<DELEGATE>>`), reviews the executor's report, and ultimately declares
  `<<DONE>>` or `<<FAIL>>`. It never touches files directly.
- The **Executor** has the full tool set, does the work, and reports back
  (`<<REPORT>>`); the architect decides what's next.

## Development

Desktop (root):

```bash
pnpm install
pnpm dev          # electron-vite dev
pnpm typecheck    # tsc for main + renderer
pnpm test         # pure state-machine harness (no Electron needed)
pnpm build        # production build
```

First run creates `~/.cloxde/` for the SQLite DB (WAL mode) and `config.json`,
then shows an empty state — open a folder as a project to get started.

Mobile companion (`mobile/`):

```bash
cd mobile
npm install
npm run android   # or: npm run ios
npm test          # jest
```

Pair the app from its Pair screen by scanning the QR code (or entering the
host/PIN) shown in the desktop's settings.

### Native modules

`better-sqlite3` ships an N-API prebuild and loads under Electron without a
rebuild. If you hit an ABI mismatch (`NODE_MODULE_VERSION`):

```bash
pnpm rebuild
```

> Note: the bundled DB is built for Electron's ABI, so the system `node` can't
> `require` it directly — use the `sqlite3` CLI for ad-hoc DB inspection.

## Architecture

```
src/
├── main/                       Electron main process (Node)
│   ├── index.ts                App lifecycle
│   ├── ipc.ts                  Whitelisted IPC handlers
│   ├── paths.ts                ~/.cloxde paths
│   ├── acp/
│   │   └── runtime.ts          One adapter process + ACP session (spawn,
│   │                           initialize, session/new|load, prompt, compact)
│   ├── conversation/
│   │   ├── engine.ts           The heart: owns the per-side runtimes, turns
│   │   │                       agent updates into messages, drives autopilot
│   │   ├── prompts.ts          PM / architect / executor system prompts
│   │   ├── state-machine.ts    Pure task transitions + allowed-tag gating
│   │   ├── transcript.ts       Tag extraction, noise / overflow classifiers
│   │   ├── update-reducer.ts   ACP session/update → MessageBlock reducer
│   │   └── summarizer.ts       Inherited-context / compaction summaries
│   ├── fs/
│   │   ├── inspector.ts        Project file tree + previews
│   │   └── git.ts              Working-tree status + per-file diff
│   ├── server/                 LAN companion backend
│   │   ├── http-server.ts      Express + WebSocket; /api/pair, live events
│   │   ├── auth.ts             PIN pairing + bearer-token issue/revoke
│   │   ├── net.ts              LAN address discovery (QR target)
│   │   └── presence.ts         Connected-client presence
│   └── storage/
│       ├── db.ts               better-sqlite3 + repos
│       └── migrations.ts       Schema migrations
├── preload/index.ts            contextBridge — exposes window.api
├── renderer/src/               React desktop UI
│   ├── App.tsx                 Sidebar + conversation stream + team panel
│   └── components/             Composer, ConversationStream, TeamPanel,
│                               ChangesPanel, CommandPalette, Settings, …
└── shared/                     Types + IPC channel names shared by all sides

mobile/src/                     React Native companion (tablet-first)
├── screens/                    Pair, ProjectList, ConversationList, Chat, …
├── components/                 MessageBubble, TeamPanel, ChangesPanel,
│                               FileExplorerPanel, TaskInspectorSheet, …
├── store/                      connection + workspace (zustand)
├── hooks/                      useConversation, useWsEvents, presence
└── api/client.ts              REST + WS client against the desktop server
```

## Hand-off protocol (tags)

| Tag | Emitted by | Meaning |
|---|---|---|
| `<<HANDOFF>>…<</HANDOFF>>` | PM | Brief is ready — start the engineering team |
| `<<PLAN>>…<</PLAN>>` | Architect | Working plan (repeatable, updates each time) |
| `<<DELEGATE>>…<</DELEGATE>>` | Architect | Concrete instruction forwarded to the executor |
| `<<REPORT>>…<</REPORT>>` | Executor | Report back to the architect for review |
| `<<DONE>>` | Architect | Task finished — autopilot stops, PM wraps up |
| `<<FAIL>>` | Architect | Task cannot be completed — autopilot stops |

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push / PR to `main`:

- **Desktop:** `pnpm typecheck` + `pnpm test` (state-machine harness; Electron
  binary download skipped).
- **Mobile:** `npm run typecheck` + `npm run lint` + `npm test` (jest).
