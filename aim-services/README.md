# AIM Services — Background Auto-Services

Automatic background services for session memory, long-term memory extraction, context compaction, cron scheduling, and task output monitoring.

## Overview

These services run independently of LLM invocation — triggered by framework events (`agent_end`, `tool_result`, `session_compact`) or timers. They use `aim`'s subagent infrastructure to fork child processes for context processing.

**Requires `aim` module** — depends on its WorkerPool for spawning child agents.

## Interfaces

### Registered Tools

| Tool | Parameters | Description | Called By |
|------|-----------|-------------|-----------|
| `task_output` | `task_id, block?, timeout?` | Read output from a background task, optionally wait for completion | LLM |
| `cron_create` | `cron, prompt, recurring?, durable?` | Schedule a prompt to run at a future time | LLM |
| `cron_delete` | `id` | Cancel a scheduled cron job | LLM |
| `cron_list` | (none) | List all scheduled cron jobs | LLM |

#### task_output

```typescript
{ task_id: "agent-abc123", block: true, timeout: 30000 }
// block=true: wait up to 30s for completion
// block=false: return current output immediately
```

#### cron_create

```typescript
// One-shot: "remind me at 2:30pm to check deploy"
{ cron: "30 14 28 4 *", prompt: "check the deploy status", recurring: false }

// Recurring: "every morning at 9am, run the smoke test"
{ cron: "0 9 * * *", prompt: "run smoke tests", recurring: true }

// Durable: survive restarts
{ cron: "0 9 * * 1-5", prompt: "morning standup summary", recurring: true, durable: true }
```

### Event Handlers

| Event | Handler | Purpose |
|-------|---------|---------|
| `agent_end` | Trigger Session Memory extraction | When turn count / token thresholds met |
| `agent_end` | Trigger Auto Memory extraction | When conversation has meaningful content |
| `tool_result` | Trigger Micro Compact | When tool result exceeds size threshold |
| `session_compact` | Enhanced state re-injection | After compaction, restore file/tool/plan state |

### Exported Public API

(None — this module does not export anything for other extensions to import)

## File Architecture

```
aim-services/
├── README.md             ← This file
├── index.ts              ← Extension entry: registers tools and event handlers
├── session-memory.ts     ← Session Memory: auto-extract summary from conversation
├── auto-memory.ts        ← Auto Memory: extract durable long-term memories
├── micro-compact.ts      ← Micro Compact: compress large tool results in-place
├── task-output.ts        ← Task Output: read background task progress/results
├── cron.ts               ← Cron: timer-based prompt scheduling system
└── compact.ts            ← Enhanced Compact: post-compaction state restoration
```

## Dependencies

| Dependency | Usage |
|-----------|-------|
| `aim` | WorkerPool for spawning child agents (`spawn("pi", ["-p", ...])`) |

## State Persistence

| State | Storage | Location |
|-------|---------|----------|
| Session memory | File system | `.pi/swarm/session_memory.md` (per session) |
| Auto memory | File system | `.pi/swarm/memory/` (per project) |
| Micro compact cache | In-memory (Map) | Tool result ID → compacted version |
| Cron jobs | File system + in-memory | `.pi/swarm/scheduled_tasks.json` (durable), memory (session-only) |
| Task output | File system | `.pi/swarm/tasks/{taskId}/output.txt` |
| Compact state | In-memory | Track pre-compact file/tool state for re-injection |

## Change Log

### 2026-04-28
- Initial module skeleton
- Defined interfaces, file architecture, and dependency graph