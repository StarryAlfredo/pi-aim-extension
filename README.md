# Pi AI Multi-Agent Extension (AIM)

Agent orchestration, LLM interaction tools, and background services for [pi coding agent](https://github.com/badlogic/pi-mono).

## Overview

AIM extends pi with three layers of capability:

| Module | Purpose | Dependency |
|--------|---------|------------|
| **aim** | Multi-agent orchestration — spawn, coordinate, and communicate with child agents | None |
| **aim-tools** | LLM ↔ user interaction tools — todo, ask, brief, plan approval | None |
| **aim-services** | Background auto-services — memory extraction, compaction, cron scheduling, task output | aim |

```
                        ┌──────────────┐
                        │   aim-tools   │  LLM ↔ user interaction
                        │  (no deps)    │  (always useful, even alone)
                        └──────────────┘
                               │
                        ┌──────┴──────┐
                        │     aim      │  Multi-agent orchestration
                        │  (no deps)   │  spawn / fork / coordinate / teams
                        └──────┬──────┘
                               │
                        ┌──────┴──────┐
                        │ aim-services │  Background auto-services
                        │ (dep: aim)   │  memory / compact / cron / task output
                        └─────────────┘
```

## Installation

### Via pi package manager

```bash
pi install git:github.com/StarryAlfredo/pi-aim-extension
```

### Manual (symlink)

```bash
# Clone
git clone https://github.com/StarryAlfredo/pi-aim-extension.git

# Symlink each module
mklink /J "%USERPROFILE%\.pi\agent\extensions\aim" "path\to\pi-aim-extension\aim"
mklink /J "%USERPROFILE%\.pi\agent\extensions\aim-tools" "path\to\pi-aim-extension\aim-tools"
mklink /J "%USERPROFILE%\.pi\agent\extensions\aim-services" "path\to\pi-aim-extension\aim-services"
```

### Selective install

You don't need all three. Pick what you want:

```bash
# Just multi-agent (no UI tools or services)
pi -e ./aim/index.ts

# Multi-agent + user interaction tools
pi -e ./aim/index.ts -e ./aim-tools/index.ts

# Everything
pi -e ./aim/index.ts -e ./aim-tools/index.ts -e ./aim-services/index.ts
```

## Architecture

```
Pi Extension System
│
├── aim/              Extension 1: Multi-agent orchestration
│   ├── Registered Tools:    subagent, send_message
│   ├── Registered Commands: /coordinator
│   ├── Event Handlers:      before_agent_start, agent_end, tool_call
│   └── Export API:          WorkerPool, mailbox, team API
│
├── aim-tools/        Extension 2: LLM ↔ user interaction
│   ├── Registered Tools:    todo_write, ask_user_question, brief
│   ├── Registered Tools:    enter_plan_mode, exit_plan_mode
│   └── Event Handlers:      (none)
│
└── aim-services/     Extension 3: Background auto-services
    ├── Registered Tools:    task_output, cron_create, cron_delete, cron_list
    ├── Event Handlers:      agent_end, tool_result, session_compact
    └── Export API:          (none)
```

### Tests

Tests are located in `aim/test/`. See [`aim/test/README.md`](aim/test/README.md) for details on each test file and what it covers.

```bash
# Run the full P1 communication loop test suite
pi -p "run the test suite in test/test-p1.ts" -e aim/index.ts
```

## License

MIT