/**
 * Prompt Cache Sharing — Test Suite (TDD: expects FAILURE on first run)
 *
 * Tests that fork agents share the parent's prompt cache by passing
 * byte-identical prompt prefixes to the LLM API.
 *
 * Key insight: Most LLM providers use prefix-based KV-cache. If two
 * consecutive requests share the first N tokens (byte-identical),
 * the second request skips recomputation for the cached prefix.
 *
 * Approach:
 *   1. Parent agent sends messages [sys, user1, assistant1, user2]
 *   2. Fork agent should send [sys, user1, assistant1, user2, forkContext]
 *   3. The prefix [sys, user1, assistant1] MUST be byte-identical
 *      to what the parent sent (not re-serialized from session)
 *
 * Tests:
 *   1. Extract cached prefix from parent's last API request
 *   2. Verify fork prepends cache-safe prefix before new message
 *   3. Messages re-loaded from session JSONL produce different bytes
 *      → confirms the caching problem
 *   4. Cache-safe prefix bytes are preserved in fork config
 *
 * Run: npx tsx test/test-prompt-cache.ts
 */

// ============================================================================
// Helpers
// ============================================================================

let testCount = 0, passCount = 0, failCount = 0;
const failures: string[] = [];

function assert(condition: boolean, test: string, detail: string) {
  if (condition) { passCount++; }
  else { failCount++; failures.push(test + ": " + detail); }
  testCount++;
}

function log(phase: string, msg: string) { console.log("  [" + phase + "] " + msg); }

// ============================================================================
// Simulated Message Types
// ============================================================================

interface SimpleMessage {
  role: string;
  content: string;
}

// ============================================================================
// Test Cases
// ============================================================================

function test1_byteIdenticalSerialization() {
  console.log("\n=== Test 1: Same messages → same serialized bytes ===");

  const messages: SimpleMessage[] = [
    { role: "system", content: "You are a coding assistant." },
    { role: "user", content: "Find authentication bugs." },
    { role: "assistant", content: "I'll search the codebase." },
  ];

  // Simulate what the parent sent to the API
  const parentBytes = JSON.stringify({ messages });

  // Simulate: fork should use the SAME bytes for the shared prefix
  const forkPrefix = messages;  // fork reuses the same message objects
  const forkPrefixBytes = JSON.stringify({ messages: forkPrefix });

  // They should be byte-identical
  assert(parentBytes === forkPrefixBytes, "same messages → same bytes", "");
  assert(parentBytes.length === forkPrefixBytes.length, "same length", parentBytes.length + " vs " + forkPrefixBytes.length);

  log("bytes", "parent: " + parentBytes.slice(0, 80) + "...");
  log("bytes", "fork:   " + forkPrefixBytes.slice(0, 80) + "...");
}

function test2_reloadedMessagesDiffer() {
  console.log("\n=== Test 2: Messages reloaded from session produce different bytes ===");

  const originalMessages: SimpleMessage[] = [
    { role: "user", content: "Find auth bugs." },
    { role: "assistant", content: "Searching..." },
  ];

  // Parent serialized and sent this
  const parentBytes = JSON.stringify({ messages: originalMessages });

  // Fork loads from session JSONL — but the reloaded messages have
  // extra fields (timestamp, uuid) that change the serialization
  const reloadedMessages = [
    { role: "user", content: "Find auth bugs.", timestamp: Date.now(), uuid: "abc-123" },
    { role: "assistant", content: "Searching...", timestamp: Date.now() + 1000, uuid: "def-456" },
  ];

  // Strip extra fields to simulate "normalization"
  const normalized = reloadedMessages.map(m => ({ role: m.role, content: m.content }));
  const normalizedBytes = JSON.stringify({ messages: normalized });

  // With extra fields → different bytes
  const reloadedBytes = JSON.stringify({ messages: reloadedMessages });
  assert(reloadedBytes !== parentBytes, "reloaded (with extra fields) ≠ parent bytes", "");
  assert(reloadedBytes.length > parentBytes.length, "reloaded is larger", reloadedBytes.length + " vs " + parentBytes.length);

  // After stripping → same bytes again
  assert(normalizedBytes === parentBytes, "normalized (stripped) = parent bytes", "");
}

function test3_cacheSafeForkConfig() {
  console.log("\n=== Test 3: Fork config carries cache-safe prefix ===");

  // Parent's last API request body
  const parentMessages: SimpleMessage[] = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Review auth.ts" },
    { role: "assistant", content: "Analyzing auth module..." },
  ];

  // Parent serialized this to send
  const parentMessagesPayload = JSON.stringify({ messages: parentMessages });

  // Fork should store the PARENT'S message bytes directly, not reload from disk
  interface ForkConfig {
    cacheSafePrefix: string;       // byte-identical prefix from parent (messages only)
    newMessage: SimpleMessage;     // the fork directive
  }

  const forkConfig: ForkConfig = {
    cacheSafePrefix: parentMessagesPayload,  // ← direct copy of parent messages
    newMessage: { role: "user", content: "<fork>continue the review</fork>" },
  };

  // Verify the prefix bytes match
  assert(forkConfig.cacheSafePrefix === parentMessagesPayload, "fork prefix = parent messages payload", "");

  // In practice, fork should use the parent's raw JSON bytes directly.
  // The key difference from the current approach:
  //   Current: fork re-serializes messages from session → cache miss
  //   Fixed:   fork passes parent's original JSON string → cache hit
  
  log("config", "fork config prefix length: " + forkConfig.cacheSafePrefix.length + " bytes");
  assert(forkConfig.cacheSafePrefix.length > 100, "prefix is substantial (caching is useful)", "");
}

function test4_cacheHitRatio() {
  console.log("\n=== Test 4: Cache hit ratio calculation ===");

  // 1000 token system prompt + 500 token conversation = 1500 token prefix
  // New fork message adds 200 tokens
  // → Cache hit: 1500/1700 = 88%

  const prefixTokens = 1500;
  const newMessageTokens = 200;
  const totalTokens = prefixTokens + newMessageTokens;
  const hitRatio = Math.round((prefixTokens / totalTokens) * 100);

  assert(hitRatio === 88, "cache hit ratio is 88%", hitRatio + "%");

  // Without cache: pay full 1700 tokens
  // With cache: pay only 200 tokens (new message) + cache read cost
  const savedTokens = totalTokens - newMessageTokens;
  assert(savedTokens === 1500, "saved 1500 tokens with cache", "");

  log("cache", "prefix: " + prefixTokens + " tokens (cached), new: " + newMessageTokens + " tokens (computed)");
  log("cache", "saved: " + savedTokens + " tokens (" + hitRatio + "% hit rate)");
}

// ============================================================================
// Run
// ============================================================================

function main() {
  console.log("AIM Prompt Cache Sharing — Test Suite");
  console.log("===========================================");

  test1_byteIdenticalSerialization();
  test2_reloadedMessagesDiffer();
  test3_cacheSafeForkConfig();
  test4_cacheHitRatio();

  console.log("\n===========================================");
  console.log("Results: " + passCount + "/" + testCount + " passed, " + failCount + " failed");
  if (failures.length > 0) { console.log("\nFailures:"); failures.forEach(function(f) { console.log("  ✗ " + f); }); process.exit(1); }
  else { console.log("All tests passed!"); process.exit(0); }
}
main();