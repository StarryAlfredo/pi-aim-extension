/**
 * AIM — Compile Check Script
 * Dynamically imports every .ts module to verify compilation.
 * Distinguishes between "compile error" and "missing runtime dependency" (acceptable).
 *
 * Run: npx tsx test/compile-check.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const aimRoot = path.resolve(__dirname, "..");
const files = fs.readdirSync(aimRoot).filter((f: string) => f.endsWith(".ts") && !f.endsWith(".d.ts"));

/** External dependencies provided by the pi runtime — not available in standalone test */
const RUNTIME_DEPS = [
  "typebox",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
];

function isRuntimeDepError(err: any): boolean {
  const msg = err.message || String(err);
  if (err.code === "MODULE_NOT_FOUND") {
    return RUNTIME_DEPS.some(dep => msg.includes(`'${dep}'`) || msg.includes(`"${dep}"`));
  }
  return false;
}

console.log(`Checking ${files.length} modules in ${aimRoot}\n`);

let ok = 0;
let fail = 0;
let skip = 0;
const fails: string[] = [];
const skips: string[] = [];

async function main() {
  for (const tsFile of files) {
    const moduleName = "../" + tsFile.replace(/\.ts$/, ".js");
    try {
      await import(moduleName);
      console.log(`  ✅ ${tsFile}`);
      ok++;
    } catch (err: any) {
      if (isRuntimeDepError(err)) {
        // Runtime dependency missing — acceptable (provided by pi at runtime)
        const dep = RUNTIME_DEPS.find(d => (err.message || "").includes(d)) ?? "unknown";
        console.log(`  ⏭️  ${tsFile} (needs ${dep} — provided by pi runtime)`);
        skips.push(tsFile);
        skip++;
      } else {
        const msg = (err.message || String(err)).split("\n")[0].substring(0, 150);
        console.log(`  ❌ ${tsFile}: ${msg}`);
        fails.push(`${tsFile}: ${msg}`);
        fail++;
      }
    }
  }

  console.log(`\n${ok} ✅ OK | ${skip} ⏭️  Skipped (runtime deps) | ${fail} ❌ FAIL`);

  if (fail > 0) {
    console.log("\n❌ Compilation errors:");
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  } else {
    console.log("\n✅ All modules compile correctly! (runtime deps will resolve inside pi)");
  }
}

main();
