# AIM Tools — LLM ↔ User Interaction

LLM-callable tools for structured human interaction. Independent of multi-agent capabilities — works with or without the `aim` module.

## Overview

These tools give LLM the ability to:
- Track its own progress with a structured task list
- Ask the user multiple-choice questions during execution
- Send formatted messages to the user proactively
- Enter/exit a plan-approval workflow before making changes

None of these tools depend on `aim` or `aim-services`. They can be installed and used independently.

## Interfaces

### Registered Tools

| Tool | Parameters | Description | Called By |
|------|-----------|-------------|-----------|
| `todo_write` | `todos: {content, status}[]` | Create and update a structured task list for the current session | LLM |
| `ask_user_question` | `questions: {question, header, options, multiSelect?}[]` | Ask the user 1-4 multiple-choice questions | LLM |
| `brief` | `message, status, attachments?` | Send a formatted message to the user (markdown supported) | LLM |
| `enter_plan_mode` | (none) | Enter plan mode — explore and design before implementing | LLM |
| `exit_plan_mode` | (none) | Exit plan mode — present plan for user approval | LLM |

#### todo_write

```typescript
{
  todos: [
    { content: "Find all auth files", status: "in_progress" },
    { content: "Fix null pointer", status: "pending" },
    { content: "Write tests", status: "pending" }
  ]
}

// Status: "pending" | "in_progress" | "completed"
// Set all to "completed" to clear the list
```

#### ask_user_question

```typescript
{
  questions: [
    {
      question: "Which auth method should we use?",
      header: "Auth method",
      options: [
        { label: "JWT", description: "Stateless, good for microservices" },
        { label: "Session", description: "Server-side, simpler revocation" }
      ]
    }
  ]
}
// multiSelect: true allows selecting multiple options
```

#### brief

```typescript
{
  message: "## Build Complete\n\nThe new auth module passes all tests.",
  status: "normal"  // "normal" | "proactive"
}
// status="proactive" for unsolicited updates (cron results, blockers found)
```

#### plan mode (enter_plan_mode / exit_plan_mode)

```typescript
// LLM calls enter_plan_mode when about to start non-trivial implementation
// → explores codebase, designs approach
// → writes plan to file
// → calls exit_plan_mode to request user approval
// → user approves → LLM proceeds with implementation
// → user rejects → LLM revises
```

### Registered Events

(None)

### Exported Public API

(None — this module does not export anything for other extensions to import)

## File Architecture

```
aim-tools/
├── README.md          ← This file
├── index.ts           ← Extension entry: registers all tools
├── todo.ts            ← TodoWrite: in-memory task list per agent, persisted via appendEntry
├── ask.ts             ← AskUserQuestion: render form UI via ctx.ui.custom()
├── brief.ts           ← Brief: format and send user-visible message via pi.sendMessage()
└── plan.ts            ← Plan Mode: enter/exit workflow, state tracking, approval flow
```

## Dependencies

| Dependency | Usage |
|-----------|-------|
| (none) | No external module dependencies |

## State Persistence

| State | Storage | Location |
|-------|---------|----------|
| Todo lists | `pi.appendEntry()` | Session JSONL (per agent ID) |
| Brief message history | `pi.sendMessage()` | Session JSONL (as custom messages) |
| Plan mode state | Extension closure variable + `pi.appendEntry()` | Session JSONL |

## Change Log

### 2026-04-28
- Initial module skeleton
- Defined interfaces, file architecture, and dependency graph