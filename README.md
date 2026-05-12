# Pi AI Multi-Agent Extension (AIM)

Agent orchestration for [pi coding agent](https://github.com/badlogic/pi-mono).

## Overview

AIM extends pi with multi-agent orchestration — the ability to spawn, coordinate,
and communicate with child agents. A single cohesive extension with modules
organized by concern.

| Concern | Modules | Purpose |
|---------|---------|---------|
| **Core orchestration** | `agent-executor`, `worker-pool`, `subagent-tool`, `coordinator`, `teams`, `swarm` | Spawn, execute, and manage subagents |
| **Task system** | `shared-tasks`, `task-create-tool`, `task-update-tool`, `task-list-tool`, `task-output-tool`, `task-resume-tool`, `task-render`, `task-progress`, `task-foreground`, `task-notifications`, `task-result-storage`, `task-hooks`, `task-distributor` | File-based shared task list with lifecycle, dependencies, and rendering |
| **Communication** | `mailbox`, `poller`, `lead-poller`, `send-message`, `permission-sync` | Inter-agent messaging and permission flow |
| **Infrastructure** | `types`, `render`, `worktree`, `extension-lifecycle`, `lock`, `agent-result`, `agent-lifecycle`, `permissions`, `permission-matrix`, `agents`, `aim-transcript` | Cross-cutting concerns: types, rendering, file locking, lifecycle management |

## Installation

### Via pi package manager

```bash
pi install git:github.com/StarryAlfredo/pi-aim-extension
```

### Manual (symlink)

```bash
# Clone
git clone https://github.com/StarryAlfredo/pi-aim-extension.git

# Symlink
mklink /J "%USERPROFILE%\.pi\agent\extensions\aim" "path\to\pi-aim-extension\aim"
```

## Architecture

```
Pi Extension System
│
└── aim/              Single extension: Multi-agent orchestration
    │
    ├── Registered Tools:    subagent, send_message, team_create, team_delete
    ├── Registered Tools:    task_create, task_update, task_output, task_list, task_resume
    ├── Registered Commands: /coordinator
    ├── Event Handlers:      before_agent_start, agent_end, session_start
    ├── Message Renderers:   aim-task-event
    │
    ├── Core orchestration
    │   ├── agent-executor.ts    Subagent execution engine (lifecycle encapsulated)
    │   ├── worker-pool.ts       Child process management (print + RPC modes)
    │   ├── subagent-tool.ts     LLM-callable tool (mode routing + TUI rendering)
    │   ├── coordinator.ts       Coordinator mode (prompt loaded from prompts/)
    │   ├── teams.ts             Team creation, teammate spawning
    │   └── swarm.ts             Swarm orchestration
    │
    ├── Task system
    │   ├── shared-tasks.ts      File-based task list (locking, state machine, deps)
    │   ├── task-*-tool.ts       LLM-callable task tools
    │   ├── task-render.ts       TUI rendering for tasks (kanban, dashboard)
    │   ├── task-progress.ts     Real-time progress tracking
    │   ├── task-foreground.ts   Foreground/background display management
    │   ├── task-notifications.ts Mailbox-based task notifications
    │   ├── task-result-storage.ts Overflow protection + result persistence
    │   ├── task-hooks.ts        Hook system (created/completed/transition)
    │   └── task-distributor.ts  Idle agent → task assignment
    │
    ├── Communication
    │   ├── mailbox.ts           File-based inbox system
    │   ├── poller.ts            Teammate inbox polling
    │   ├── lead-poller.ts       Lead inbox polling + permission handling
    │   ├── send-message.ts      send_message tool registration
    │   └── permission-sync.ts   Mailbox-based permission requests
    │
    └── Infrastructure
        ├── types.ts             Shared type definitions + path helpers
        ├── render.ts            Shared TUI rendering components
        ├── lock.ts              File locking utility (shared across modules)
        ├── agent-lifecycle.ts   Unified lifecycle management
        ├── agent-result.ts      Result formatting + usage aggregation
        ├── extension-lifecycle.ts  Callback wiring + lifecycle services
        ├── worktree.ts          Git worktree isolation
        ├── permissions.ts       Permission system registration
        ├── permission-matrix.ts Role-based tool filtering
        ├── agents.ts            Agent discovery from markdown files
        └── aim-transcript.ts    Sidechain transcript persistence
```

### Key Design Decisions

- **File-based locking** (`lock.ts`): Atomic `writeFileSync({ flag: "wx" })` with stale lock detection, shared across `shared-tasks.ts` and `mailbox.ts`
- **Agent lifecycle** (`agent-lifecycle.ts`): Unified `agentStarted()` → `agentCompleted()`/`agentFailed()` replaces scattered create/cleanup calls
- **Circular dependency wiring** (`extension-lifecycle.ts`): All cross-module callbacks registered in one place via `wireCallbacks()`
- **External prompt template** (`prompts/coordinator.md`): Coordinator system prompt loaded from disk, editable without recompilation

### Tests

Tests are located in `aim/test/`. See [`aim/test/README.md`](aim/test/README.md) for details on each test file and what it covers.

```bash
# Run the full P1 communication loop test suite
pi -p "run the test suite in test/test-p1.ts" -e aim/index.ts
```

## License

MIT
