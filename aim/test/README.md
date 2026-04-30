# AIM — Tests

Test suite for the AIM multi-agent orchestration module.

## Test Files

### test-p1.ts — P1 Communication Loop Test Suite

Tests the complete communication cycle introduced in the P1 milestone.
Uses real AIM modules (`mailbox.ts`) for inbox operations and enforces
`--no-tools --thinking off` for deterministic RPC worker responses.

| Test | Name | What It Tests |
|------|------|---------------|
| Test 1 | `agent_end` detection | RPC workers signal completion via `agent_end` event, worker stays alive afterward |
| Test 2 | `steer` interrupt | Sending a `steer` command interrupts the current execution and injects new instructions |
| Test 3 | Multi-turn (sequential prompts) | Sending sequential `prompt` commands to the same RPC worker triggers multiple `agent_end` events |
| Test 4 | Mailbox → RPC steer | Leader writes to mailbox via `writeToMailbox`, worker reads via `readMailbox`, delivers via prompt |
| Test 5 | Idle notification | Worker → Leader notification that a task is complete, including usage stats |
| Test 6 | Coordinator pipeline | `agent_end` → task-notification XML formatting for coordinator result reporting |
| Test 7 | E2E coordinator workflow | Full cycle: scout finds files → prompt for fix → prompt for verify (3-phase using prompts) |

### test-p2.ts — P2 Teammate Autonomy + Peer Communication Test Suite

Tests teammate autonomy, peer messaging, task coordination, and structured protocol messages.
All tests use real AIM modules (`mailbox.ts`, `shared-tasks.ts`) — no raw file I/O bypass.

| Test | Name | What It Tests |
|------|------|---------------|
| Test 1 | Poll inbox → auto-run | `writeToMailbox` → `readMailbox` → prompt injection → agent responds |
| Test 2 | Claim task → auto-run | `createTask` → `claimTask` → prompt injection → agent responds |
| Test 3 | Worker → worker peer message | Worker A writes to B's mailbox via `writeToMailbox`, B reads and responds |
| Test 4 | Shutdown request/response | `createShutdownRequest` → `isShutdownRequest` → `createShutdownApproval` |
| Test 5 | Plan approval | `createPlanApprovalRequest` → leader approves/rejects via `createPlanApprovalResponse` |
| Test 6 | E2E two-worker task list | Two workers coordinate on shared task list with `createTask`, `claimTask`, `updateTask`, `listTasks` |

### Covered Features

- **RPC mode** (`--mode rpc`): long-lived worker processes with stdin/stdout JSON protocol
- **agent_end handling**: completion signal replaces 120s poll/kill hack
- **steer / follow_up / abort**: process-level control commands
- **send_message RPC bridge**: active RPC worker detection for immediate message delivery
- **task-notification XML format**: structured coordinator result reporting
- **idle state management**: workers persist between turns instead of terminating
- **Mailbox API**: `writeToMailbox`, `readMailbox`, `markMessageAsRead` with file locking
- **Protocol messages**: `createShutdownRequest`, `isShutdownRequest`, `createShutdownApproval`,
  `createPlanApprovalRequest`, `createPlanApprovalResponse`
- **Shared task system**: `createTask`, `claimTask`, `updateTask`, `listTasks`, `findAvailableTask`
  with blocking dependency resolution

## Real Module Coverage

Unlike earlier versions which bypassed AIM modules with raw file I/O, these tests
now directly exercise the production code paths:

| AIM Module | Functions Tested | Test File |
|------------|-----------------|-----------|
| `mailbox.ts` | `writeToMailbox`, `readMailbox`, `markMessageAsRead` | test-p1.ts (#4, #5); test-p2.ts (#1, #3, #4, #5) |
| `mailbox.ts` | `createShutdownRequest`, `isShutdownRequest`, `createShutdownApproval` | test-p2.ts (#4) |
| `mailbox.ts` | `createPlanApprovalRequest`, `createPlanApprovalResponse` | test-p2.ts (#5) |
| `shared-tasks.ts` | `createTask`, `claimTask` | test-p2.ts (#2, #6) |
| `shared-tasks.ts` | `updateTask`, `listTasks` | test-p2.ts (#6) |
| `worker-pool.ts` | `spawn` (RPC mode), `waitFor`, `steer`, `kill` | test-p1.ts (all) |

## Running Tests

```bash
# Run P1 tests
npx tsx test/test-p1.ts

# Run P2 tests
npx tsx test/test-p2.ts

# Or via pi
pi -p "run the test suite in test/test-p1.ts"
```

Tests spawn real `pi` processes in RPC mode with `--no-tools --thinking off`
for deterministic text-only responses, and verify end-to-end communication
through real AIM modules. Each test spawns its own worker and kills it on completion.

## Adding New Tests

Place new test files in this directory. Each file should:

1. Be self-contained (import from `../mailbox.js`, `../shared-tasks.js`, etc.)
2. Use real AIM modules instead of raw file I/O for mailbox and task operations
3. Use the test harness pattern from test-p1.ts (assert/statistics helpers)
4. Spawn RPC workers with `--no-tools --thinking off` for deterministic behavior
5. Clean up spawned processes and `.pi/aim/test-*` directories in `finally` blocks
6. Document what it covers in this README