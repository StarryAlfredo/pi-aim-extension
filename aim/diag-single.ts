/**
 * Diag 3: same as test-p1 spawnRpc but standalone
 */
import { spawn } from "node:child_process";
import * as path from "node:path";

function spawnRpc(cwd: string) {
  const npmDir = path.join(process.env.APPDATA || "", "npm");
  const piScript = path.join(npmDir, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js");

  const proc = spawn(process.execPath, [piScript, "--mode", "rpc", "--no-session"], {
    cwd, stdio: ["pipe", "pipe", "pipe"],
  });

  const events: Record<string, unknown>[] = [];

  proc.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.log("STDERR:", msg.slice(0, 150));
  });

  proc.stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        events.push(ev);
        console.log(`EVENT[${events.length}]: ${ev.type}`);
      } catch { console.log("RAW:", line.slice(0, 80)); }
    }
  });

  function send(obj: Record<string, unknown>) {
    console.log(`SEND: ${JSON.stringify(obj).slice(0, 80)}`);
    proc.stdin?.write(JSON.stringify(obj) + "\n");
  }

  async function waitFor(type: string, timeoutMs = 30000): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = events.find(e => e.type === type);
      if (found) { console.log(`FOUND ${type} at event index ${events.indexOf(found)}`); return found; }
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`TIMEOUT waiting for ${type}, events so far: ${events.map(e => e.type).join(", ")}`);
    return null;
  }

  return { proc, send, waitFor, events };
}

async function main() {
  console.log("cwd:", process.cwd());
  const w = spawnRpc(process.cwd());

  await new Promise(r => setTimeout(r, 2000));

  w.send({ type: "prompt", message: "reply exactly: HELLO" });

  const end = await w.waitFor("agent_end", 60000);
  console.log("result:", end ? "GOT agent_end" : "FAILED");
  w.proc.kill();
}

main().catch(console.error);