# AIM — Multi-Agent Orchestration

Core multi-agent extension for pi coding agent. Provides process-level agent spawning, inter-agent communication, team coordination, and permission bridging.

## Overview

AIM gives LLM the ability to create, coordinate, and communicate with child agents. A child agent is a separate `pi` process with its own context window, tool set, and model.

## Interfaces

### Registered Tools

| Tool | Parameters | Description | Called By |
|------|-----------|-------------|-----------|
| `subagent` | `agent`, `task`, `subagent_type?`, `model?`, `run_in_background?`, `fork?` | Spawn a child agent to handle complex tasks autonomously | LLM |
| `send_message` | `to`, `message`, `summary?` | Send a message to another agent's inbox | LLM |

#### subagent

```typescript
// Single agent
{ agent: "scout", task: "find all auth code" }

// Parallel (up to 8 tasks, 4 concurrent)
{ tasks: [{ agent: "scout", task: "find models" }, { agent: "scout", task: "find providers" }] }

// Chain (sequential, {previous} placeholder)
{ chain: [{ agent: "scout", task: "find auth code" }, { agent: "worker", task: "fix {previous}" }] }

// Fork (inherit parent context)
{ task: "research the auth module", fork: true }

// Background (fire-and-forget, result via notification)
{ agent: "worker", task: "run long tests", run_in_background: true }
```

#### send_message

```typescript
{ to: "worker-1", message: "continue with step 2", summary: "step 2" }
{ to: "*", message: "all stop", summary: "broadcast shutdown" }
```

### Registered Commands

| Command | Parameters | Description |
|---------|-----------|-------------|
| `/coordinator` | (none) | Toggle coordinator mode on/off |

### Event Handlers

| Event | Handler | Purpose |
|-------|---------|---------|
| `before_agent_start` | Inject coordinator system prompt | When coordinator mode is active |
| `agent_end` | (future) format worker results | Coordinator result formatting |
| `tool_call` | Permission bridge | Intercept dangerous bash commands |
| `session_start` | Restore coordinator state | Persist coordinator toggle across reloads |

### Exported Public API

```typescript
import { workerPool } from "../aim/index.js";
import { readMailbox, writeToMailbox, markMessageAsRead, isShutdownRequest, isPermissionResponse, createShutdownRequest, createShutdownApproval, createShutdownRejection, createIdleNotification } from "../aim/index.js";
import { discoverAgents, formatAgentList } from "../aim/index.js";
import { createTeam, deleteTeam, spawnTeammate, getActiveTeam } from "../aim/index.js";
import { pollInbox, sendIdleNotification } from "../aim/index.js";
import type { WorkerConfig, WorkerInfo, AgentConfig, AgentScope, AgentDiscoveryResult, TeammateMessage, TeamFile, TeamMember } from "../aim/index.js";
```

| Export | Type | Description |
|--------|------|-------------|
| `workerPool` | `WorkerPool` | Singleton process manager. `spawn()`, `kill()`, `getInfo()`, `waitFor()`, `destroy()` |
| `readMailbox` | `(cwd, agentName, teamName) => Promise<TeammateMessage[]>` | Read all inbox messages |
| `writeToMailbox` | `(cwd, recipient, msg, team) => Promise<void>` | Write to inbox (file-locked) |
| `markMessageAsRead` | `(cwd, agentName, team, index) => Promise<void>` | Mark message read |
| `isShutdownRequest` | `(text) => {request_id, from, reason?} \| null` | Parse shutdown request |
| `isPermissionResponse` | `(text) => {request_id, subtype, response?, error?} \| null` | Parse permission response |
| `createShutdownRequest` | `(requestId, from, reason?) => string` | Build shutdown request JSON |
| `createShutdownApproval` | `(requestId, from) => string` | Build approval JSON |
| `createShutdownRejection` | `(requestId, from, reason) => string` | Build rejection JSON |
| `createIdleNotification` | `(agentName, options?) => string` | Build idle notification |
| `discoverAgents` | `(cwd, scope) => AgentDiscoveryResult` | Discover agent definitions |
| `formatAgentList` | `(agents, maxItems) => {text, remaining}` | Format for LLM |
| `createTeam` | `(cwd, name, description?) => Promise<TeamFile>` | Create team + task list |
| `deleteTeam` | `(cwd, name) => Promise<void>` | Delete team |
| `spawnTeammate` | `(cwd, config, agents) => Promise<{agentId, name, team}>` | Spawn teammate |
| `getActiveTeam` | `() => {name, filePath, leadAgentId} \| null` | Get active team |
| `pollInbox` | `(cwd, agentName, team, signal) => Promise<PollResult>` | Blocking poll loop |
| `sendIdleNotification` | `(cwd, agentName, team, options?) => Promise<void>` | Notify leader of idle |

## File Architecture

```
aim/
├── README.md          ← This file
├── index.ts           ← Extension entry: registers subagent, send_message, coordinator, teams, permissions
├── types.ts           ← Shared type definitions: WorkerConfig, AgentConfig, TeammateMessage, TeamFile, TaskItem, CronJob, SubagentSpawnData, SubagentResultData
├── worker-pool.ts     ← Process lifecycle: two modes (print/one-shot, RPC/long-lived), spawn/kill/wait/steer/followUp/abort
├── mailbox.ts         ← File-based inbox: JSON read/write with retry-locking, message filtering, protocol helpers
├── aim-transcript.ts  ← Subagent transcript persistence: sidechain JSONL files, parent tree annotation via custom entries
├── send-message.ts    ← SendMessage tool: route messages to inbox or broadcast (*)
├── coordinator.ts     ← Coordinator mode: toggle, prompt injection via before_agent_start, session persistence
├── teams.ts           ← Team management: create/delete teams, spawn teammates, team file I/O
├── poller.ts          ← Inbox poller: blocking while-loop for continuous agent operation
├── permissions.ts     ← Permission bridge: intercept dangerous bash commands, request user confirmation
├── render.ts          ← TUI rendering: tool call/result components, usage stats formatting
├── agents.ts          ← Agent definition loader: parse .md frontmatter, discover user/project agents
├── shared-tasks.ts    ← Team shared task system: file-based CRUD, claim/unclaim, lock-safe
├── test/
│   ├── README.md
│   ├── test-p1.ts         ← P1: RPC communication loop tests
│   ├── test-p2.ts         ← P2: teammate autonomy + peer communication
│   └── test-coordinator.ts ← Coordinator mode behavioral tests
└── ...
```

## Dependencies

| Dependency | Usage |
|-----------|-------|
| (none) | No external module dependencies |

## State Persistence

| State | Storage | Location |
|-------|---------|----------|
| Worker states | In-memory (`WorkerPool`) | Process lifecycle |
| Mailbox messages | File system | `.pi/aim/teams/{team}/inboxes/{agent}.json` |
| Team definitions | File system | `.pi/aim/teams/{name}.json` |
| Agent definitions | File system (read-only) | `~/.pi/agent/agents/*.md`, `.pi/agents/*.md` |
| Coordinator mode | `pi.appendEntry()` | Session JSONL |

## Change Log

### 2026-06-18
- **Migration: `@mariozechner/*` → `@earendil-works/*`** — All imports updated to the
current pi package names (v0.79.6). The legacy aliases still worked via pi's loader
shim, but are deprecated and would break on a future pi release.
- **Engineering: type-safe build** — Added `tsconfig.json`, `@types/node`, and a
`typecheck` script (`npm run typecheck`). Standalone `tsc` now passes with **0
errors** (was 212+). Added `.gitattributes` to enforce LF line endings.
- **API drift: v0.73 → v0.79 tool contract** — Tool `execute` callbacks now
declare the 5th `ctx` parameter (was being skipped, so `ctx` bound to `onUpdate`).
- **API drift: errors throw, not `isError`** — `AgentToolResult` no longer has an
`isError` field. Tool error paths now `throw new Error(...)` (pi v0.79 convention);
`renderResult` reads `context.isError` instead of `result.isError`.
- **API drift: `sendMessage` → `sendUserMessage`** — `ExtensionAPI.sendMessage`
now requires `customType`/`display`. Permission/background notifications switched
to `sendUserMessage(content)` (the v0.79 equivalent of `{role:"user",content}`).
- **API drift: `CustomEntry` typed** — `restoreCoordinatorState` uses a proper
type guard instead of unsafe `as Record<string,unknown>` casts.
- **API drift: `Container()` ctor** — `Container` no longer takes `{children}`;
use `addChild()`. `Text` imported at top level instead of per-call `require()`.
- **Fix: broadcast (`to:"*"`) now works** — was a dead stub returning "not yet
available". Now enumerates active team members and writes to each inbox.
- **Fix: point-to-point messages use the active team** — was passing `teamName=""`,
writing to an unreachable `teams//inboxes/` path. Now reads `getActiveTeam()`.
- **Fix: `teams.ts` uses real `typebox`** — replaced the hand-rolled mock `Type`
object (which provided zero runtime validation) with the real `Type` from the
`typebox` module bundled by pi.
- **Fix: mailbox debug `console.log` removed** — `getInboxPath()` was logging
cwd/team/path on every inbox write.
- **Fix: `markCompleted` evict-timer leak** — a second `markCompleted()` call
would leak the old `setTimeout` handle; now clears it first.
- **Fix: `overBudget` stale after truncation** — `handleBatchOverflow` recomputed
`totalInlineSize` but returned the pre-truncation `overBudget` flag.
- **Fix: `deleteTask(force)` cascade failure propagation** — the failed task was
unlinked before `propagateFailureToBlocked` ran, so it found no task and
short-circuited, leaving blocked tasks stuck in `pending` forever. Now captures
`blocks` pre-deletion and seeds the BFS from the in-memory copy.
- **Fix: lifecycle cleanup timer `.unref()`** — the no-retain remove timer no
longer keeps the Node event loop (and thus pi's exit) alive.

### 2026-04-30
- **Feature: coordinator mode overhaul** — Rewritten coordinator prompt for effectiveness:
  - Prompt now injected at the BEGINNING of system prompt (not end) to avoid "lost-in-middle"
  - Uses strong MUST/NEVER/ALWAYS directives for enforceable delegation
  - Dynamically injects available agent list so LLM knows what subagents to use
  - Includes CORRECT/WRONG examples, structured workflow, synthesis instructions
  - New `buildCoordinatorPrompt()` function and `refreshAgentList()` utility
- **Feature: coordinator test suite** — New `test/test-coordinator.ts` with 6 tests:
  - Prompt structure validation (20+ required elements)
  - Behavioral test: coordinator delegates vs doing work directly
  - Behavioral test: coordinator uses parallel mode for independent tasks
  - Comparison test: baseline vs coordinator produces different outputs
  - Prompt position test: validates coordinator at beginning, not end
  - Edge case: coordinator with empty agent list still functions
- **Fix: test determinism** — P1 tests now use `--no-tools --thinking off` for RPC workers
  to prevent non-deterministic tool-use responses. P1 test4 now uses real AIM modules
  (`writeToMailbox`, `readMailbox`, `markMessageAsRead`) from `mailbox.ts`.
- **Fix: test coverage** — P2 tests rewritten to call real AIM modules (`mailbox.ts`,
  `shared-tasks.ts`) instead of bypassing them with direct file system access.
  Tests now cover: `writeToMailbox`, `readMailbox`, `markMessageAsRead`, `createTask`,
  `claimTask`, `updateTask`, `listTasks`, `createShutdownRequest`, `isShutdownRequest`,
  `createShutdownApproval`, `createPlanApprovalRequest`, `createPlanApprovalResponse`.
- **Fix: pi CLI path** — Removed hardcoded `D:\nodeJS\pi.cmd` and `APPDATA/npm/pi.cmd`
  paths; now uses `pi.cmd` from PATH.
- **Fix: worker init flakiness** — Increased timeout for worker initialization to 60s;
  parallelized two-worker init in test3 and test6 with `Promise.all`.

### 2026-04-29 (P1)
- **P1: agent_end completion signal** — RPC workers now use agent_end to signal completion
  instead of the 120s poll/kill hack. Worker stays alive in idle state after each turn.
- **P1: send_message → RPC steer bridge** — send_message detects active RPC workers
  and delivers messages via steer for immediate delivery, falling back to mailbox.
- **P1: task-notification format** — Updated coordinator prompt with `<task-notification>`
  XML format specification and worker result handling instructions.
- `WorkerInfo` now has `turnCount` for multi-turn tracking.
- `WorkerPool` now has `resetDonePromise()` for multi-turn RPC cycling.

### 2026-04-29
- **P0: Long-lived workers (RPC mode)** — WorkerPool now supports two modes:
  - Print mode (`--mode json -p`): one-shot, fast, for simple tasks
  - RPC mode (`--mode rpc`): long-lived, supports steer/followUp/abort, used for fork & background agents
- **P0: Resume agent** — Subagent conversations persisted as sidechain JSONL files (`.pi/aim/agents/{agentId}.jsonl`)
  - Metadata stored in companion `.meta.json` files
  - Parent tree annotated with `aim-subagent-spawn` and `aim-subagent-result` custom entries
  - New `resume` parameter on subagent tool
- New module: `aim-transcript.ts` for sidechain persistence and tree annotation
- `WorkerInfo` extended with `process` (ChildProcess ref) and `rpcSend` (stdin helper)

### 2026-04-28
- Implemented all core modules: types, worker-pool, mailbox, agents, render
- Implemented subagent tool (single/parallel/chain/fork/background modes)
- Implemented send_message tool
- Implemented coordinator mode
- Implemented team management
- Implemented permission bridge
- Implemented inbox poller