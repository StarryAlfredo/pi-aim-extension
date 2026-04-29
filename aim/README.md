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
| `agent_end` | Format worker results as `<task-notification>` | When coordinator mode is active |
| `tool_call` | Permission bridge | Intercept dangerous operations, request user confirmation |

### Exported Public API

```typescript
import { workerPool } from "../aim/index.js";
import { readMailbox, writeToMailbox, markRead } from "../aim/index.js";
import { createTeam, deleteTeam, spawnTeammate } from "../aim/index.js";
```

| Export | Type | Description |
|--------|------|-------------|
| `workerPool` | `WorkerPool` | Singleton process manager. `spawn()`, `kill()`, `send()`, `onResult()` |
| `readMailbox` | `(agentName: string, teamName: string) => Promise<TeammateMessage[]>` | Read all messages from an agent's inbox |
| `writeToMailbox` | `(recipient: string, msg: TeammateMessage, team: string) => Promise<void>` | Write a message to an agent's inbox (file-locked) |
| `markRead` | `(agentName: string, team: string, index: number) => Promise<void>` | Mark a message as read |
| `createTeam` | `(name: string, description?: string) => Promise<Team>` | Create a new team, register leader |
| `deleteTeam` | `(name: string) => Promise<void>` | Delete a team and clean up |
| `spawnTeammate` | `(config: SpawnTeammateConfig, ctx: ExtensionContext) => Promise<SpawnOutput>` | Spawn a teammate in an existing team |
| `startInboxPoller` | `(agentName: string, teamName: string, signal: AbortSignal) => Promise<Message \| null>` | Poll inbox for new messages/tasks (blocking while-loop) |

## File Architecture

```
aim/
├── README.md          ← This file
├── index.ts           ← Extension entry: registers all tools, commands, events
├── worker-pool.ts     ← Process lifecycle: spawn pi subprocesses, track state, handle I/O
├── mailbox.ts         ← File-based inbox: JSON read/write with file locking
├── send-message.ts    ← SendMessage tool: route messages to inboxes or broadcast
├── coordinator.ts     ← Coordinator mode: toggle and inject system prompt
├── teams.ts           ← Team management: create/delete teams, spawn members
├── poller.ts          ← Inbox poller: blocking while-loop for continuous agent operation
├── permission.ts      ← Permission bridge: intercept tool calls, request user confirmation
├── render.ts          ← TUI rendering: tool call/result display components
└── agents.ts          ← Agent definition loader: parse .md frontmatter, discover agents
```

## Dependencies

| Dependency | Usage |
|-----------|-------|
| (none) | No external module dependencies |

## State Persistence

| State | Storage | Location |
|-------|---------|----------|
| Worker states | In-memory (`WorkerPool`) | Process lifecycle |
| Mailbox messages | File system | `.pi/swarm/inboxes/{team}/{agent}.json` |
| Team definitions | File system | `.pi/swarm/teams/{name}.json` |
| Agent definitions | File system (read-only) | `~/.pi/agent/agents/*.md`, `.pi/agents/*.md` |
| Coordinator mode | `pi.appendEntry()` | Session JSONL |

## Change Log

### 2026-04-28
- Initial module skeleton
- Defined interfaces, file architecture, and dependency graph