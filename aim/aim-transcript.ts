/**
 * AIM — Agent Transcript Persistence
 *
 * Stores subagent conversation transcripts as sidechain JSONL files,
 * separate from the parent session's tree. Uses Pi's appendEntry() with
 * custom types to annotate the parent tree with spawn/result markers.
 *
 * Layout:
 *   .pi/aim/agents/
 *     {agentId}.jsonl       ← subagent transcript (JSONL, same format as Pi sessions)
 *     {agentId}.meta.json    ← metadata (agentType, task, model, tools)
 *
 * Parent session tree markers:
 *   custom { type: "aim-subagent-spawn", data: { agentId, agent, task, ... } }
 *   custom { type: "aim-subagent-result", data: { agentId, status, summary, usage } }
 *
 * Refactor: the six free functions all threaded `cwd` as the first argument.
 * They are now methods on `TranscriptStore` (cwd bound at construction),
 * with thin function facades re-exported for backward compatibility.
 */

import * as fs from "node:fs";
import { getAgentTranscriptPath, getAgentMetadataPath } from "./types.js";
import type { SubagentSpawnData, SubagentResultData } from "./types.js";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

export interface AgentMetadata {
  agentType: string;
  name: string;
  task: string;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  forkMode: boolean;
  background: boolean;
  createdAt: number;
}

// ============================================================================
// TranscriptStore Class
// ============================================================================

/**
 * Persists subagent transcripts and metadata for a given working directory.
 * The cwd is bound at construction so callers stop threading it through
 * every call.
 */
export class TranscriptStore {
  constructor(private readonly cwd: string) {}

  // ── Metadata ──

  writeMetadata(agentId: string, meta: AgentMetadata): void {
    const p = getAgentMetadataPath(this.cwd, agentId);
    ensureDir(p);
    fs.writeFileSync(p, JSON.stringify(meta, null, 2), "utf-8");
  }

  readMetadata(agentId: string): AgentMetadata | null {
    try {
      const p = getAgentMetadataPath(this.cwd, agentId);
      return JSON.parse(fs.readFileSync(p, "utf-8")) as AgentMetadata;
    } catch { return null; }
  }

  // ── Transcript ──

  /** Append messages to the sidechain transcript file */
  append(agentId: string, messages: Message[]): void {
    const p = getAgentTranscriptPath(this.cwd, agentId);
    ensureDir(p);
    const fd = fs.openSync(p, "a");
    try {
      for (const msg of messages) {
        fs.writeSync(fd, JSON.stringify(msg) + "\n");
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Read the full transcript for a subagent (used for resume) */
  read(agentId: string): Message[] {
    const p = getAgentTranscriptPath(this.cwd, agentId);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf-8");
    return raw.split("\n")
      .filter(line => line.trim())
      .map(line => { try { return JSON.parse(line) as Message; } catch { return null; } })
      .filter((m): m is Message => m !== null);
  }
}

// ============================================================================
// Parent Tree Annotation (via pi.appendEntry)
// ============================================================================

/** Record subagent spawn in parent session tree */
export function recordSubagentSpawn(pi: ExtensionAPI, data: SubagentSpawnData): void {
  pi.appendEntry("aim-subagent-spawn", data);
}

/** Record subagent result in parent session tree */
export function recordSubagentResult(pi: ExtensionAPI, data: SubagentResultData): void {
  pi.appendEntry("aim-subagent-result", data);
}

// ============================================================================
// Backward-Compatible Functional API (thin facades over TranscriptStore)
// ============================================================================

export function writeAgentMetadata(cwd: string, agentId: string, meta: AgentMetadata): void {
  new TranscriptStore(cwd).writeMetadata(agentId, meta);
}

export function readAgentMetadata(cwd: string, agentId: string): AgentMetadata | null {
  return new TranscriptStore(cwd).readMetadata(agentId);
}

export function appendToTranscript(cwd: string, agentId: string, messages: Message[]): void {
  new TranscriptStore(cwd).append(agentId, messages);
}

export function readTranscript(cwd: string, agentId: string): Message[] {
  return new TranscriptStore(cwd).read(agentId);
}

// ============================================================================
// Helpers
// ============================================================================

function ensureDir(filePath: string): void {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dir = lastSlash > 0 ? filePath.substring(0, lastSlash) : "";
  if (dir && !fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
  }
}
