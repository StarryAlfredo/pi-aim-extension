# AIM — Tests

Test suite for the AIM multi-agent orchestration module.

## Test Files

### test-p1.ts — P1 Communication Loop Test Suite

Tests the complete communication cycle introduced in the P1 milestone:

| Test | Name | What It Tests |
|------|------|---------------|
| Test 1 | `agent_end` detection | RPC workers signal completion via `agent_end` event, worker stays alive afterward |
| Test 2 | `steer` interrupt | Sending a `steer` command interrupts the current execution and injects new instructions |
| Test 3 | `follow_up` | Queued `follow_up` messages execute after the current prompt completes, enabling multi-turn |
| Test 4 | Mailbox → RPC steer | Leader-to-worker messages are routed through mailbox, then converted to RPC steer for delivery |
| Test 5 | Idle notification | Worker → Leader notification that a task is complete, including usage stats |
| Test 6 | Coordinator pipeline | `agent_end` → task-notification XML formatting for coordinator result reporting |
| Test 7 | E2E coordinator workflow | Full cycle: scout finds files → worker fixes → steer to verify (3-phase coordinator flow) |

### Covered Features

- **RPC mode** (`--mode rpc`): long-lived worker processes with stdin/stdout JSON protocol
- **agent_end handling**: completion signal replaces 120s poll/kill hack
- **steer / follow_up / abort**: process-level control commands
- **send_message RPC bridge**: active RPC worker detection for immediate message delivery
- **task-notification XML format**: structured coordinator result reporting
- **idle state management**: workers persist between turns instead of terminating

## Running Tests

```bash
# From the aim directory
pi -p "run the test suite in test/test-p1.ts"

# Or with explicit extension loading
pi -e ../aim/index.ts -p @test/test-p1.ts
```

Tests spawn real `pi` processes in RPC mode and verify end-to-end communication. Each test spawns its own worker and kills it on completion.

## Adding New Tests

Place new test files in this directory. Each file should:

1. Be self-contained (import only `node:` built-ins or AIM modules)
2. Use the test harness pattern from `test-p1.ts` (assert/statistics helpers)
3. Clean up spawned processes in `finally` blocks
4. Document what it covers in this README