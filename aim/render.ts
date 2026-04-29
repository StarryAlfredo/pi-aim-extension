/**
 * AIM — Render
 *
 * Shared TUI rendering components for AIM tools.
 * Provides consistent styling for subagent, send_message, team_create, etc.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { Container, Markdown, Text, Spacer } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import * as os from "node:os";

// ============================================================================
// Formatters
// ============================================================================

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens?: number; turns?: number },
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  theme: Theme,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) ?? "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return theme.fg("muted", "$ ") + theme.fg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = theme.fg("accent", shortenPath(rawPath));
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? start + limit - 1 : "";
        text += theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
      }
      return theme.fg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = theme.fg("muted", "write ") + theme.fg("accent", shortenPath(rawPath));
      if (lines > 1) text += theme.fg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return theme.fg("muted", "edit ") + theme.fg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return theme.fg("muted", "ls ") + theme.fg("accent", shortenPath(rawPath));
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return theme.fg("muted", "grep ") + theme.fg("accent", `/${pattern}/`) + theme.fg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return theme.fg("muted", "find ") + theme.fg("accent", pattern) + theme.fg("dim", ` in ${shortenPath(rawPath)}`);
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return theme.fg("accent", toolName) + theme.fg("dim", ` ${preview}`);
    }
  }
}

// ============================================================================
// Components
// ============================================================================

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments as Record<string, unknown> });
      }
    }
  }
  return items;
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export function renderDisplayItems(items: DisplayItem[], theme: Theme, limit?: number): string {
  const toShow = limit ? items.slice(-limit) : items;
  const skipped = limit && items.length > limit ? items.length - limit : 0;
  let text = "";
  if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
  for (const item of toShow) {
    if (item.type === "text") {
      text += `${theme.fg("toolOutput", item.text)}\n`;
    } else {
      text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme)}\n`;
    }
  }
  return text.trimEnd();
}

export function renderSubagentResult(
  result: AgentToolResult<unknown>,
  expanded: boolean,
  theme: Theme,
  agentName: string,
  agentSource: string,
  task: string,
  model?: string,
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens?: number; turns?: number },
  stopReason?: string,
  errorMessage?: string,
): Container {
  const COLLAPSED_ITEMS = 10;

  const mdTheme = getMarkdownTheme();
  const rawResult = result.details as Record<string, unknown> | undefined;
  const messages = (rawResult?.messages ?? []) as Message[];
  const displayItems = getDisplayItems(messages);
  const finalOutput = getFinalOutput(messages);
  const isError = stopReason === "error" || stopReason === "aborted";
  const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

  if (expanded) {
    const container = new Container();
    let header = `${icon} ${theme.fg("toolTitle", theme.bold(agentName))}${theme.fg("muted", ` (${agentSource})`)}`;
    if (isError && stopReason) header += ` ${theme.fg("error", `[${stopReason}]`)}`;
    container.addChild(new Text(header, 0, 0));
    if (isError && errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
    container.addChild(new Text(theme.fg("dim", task), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
    for (const item of displayItems) {
      if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme), 0, 0));
    }
    if (finalOutput) {
      container.addChild(new Spacer(1));
      container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
    }
    if (usage) {
      const usageStr = formatUsageStats(usage, model);
      if (usageStr) { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg("dim", usageStr), 0, 0)); }
    }
    return container;
  }

  let text = `${icon} ${theme.fg("toolTitle", theme.bold(agentName))}${theme.fg("muted", ` (${agentSource})`)}`;
  if (isError && stopReason) text += ` ${theme.fg("error", `[${stopReason}]`)}`;
  if (isError && errorMessage) text += `\n${theme.fg("error", `Error: ${errorMessage}`)}`;
  else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
  else {
    text += `\n${renderDisplayItems(displayItems, theme, COLLAPSED_ITEMS)}`;
    if (displayItems.length > COLLAPSED_ITEMS) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  }
  if (usage) {
    const usageStr = formatUsageStats(usage, model);
    if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
  }
  return new Container({ children: [new Text(text, 0, 0)] });
}