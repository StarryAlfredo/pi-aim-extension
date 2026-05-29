/**
 * Quick verification of the failing test fixes
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Mailbox } from "./mailbox.ts";
import { getTeamsDir, getInboxesDir } from "./types.ts";

async function testMailboxDirectoryCreation() {
  console.log("=== Testing Mailbox Directory Creation ===");
  
  const cwd = process.cwd();
  console.log(`CWD: ${cwd}`);
  
  const testTeam = "fix-verification-team";
  const testAgent = "test-agent";
  
  // Test the exact path that was failing
  const teamsDir = getTeamsDir(cwd);
  console.log(`Teams dir result: ${teamsDir} (type: ${typeof teamsDir})`);
  
  const teamDir = path.join(teamsDir, testTeam);
  const inboxesDir = path.join(teamDir, "inboxes");
  const inboxPath = path.join(inboxesDir, `${testAgent}.json`);
  
  console.log(`Team dir: ${teamDir}`);
  console.log(`Inboxes dir: ${inboxesDir}`);
  console.log(`Inbox path: ${inboxPath}`);
  
  // Cleanup any existing test structure
  try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch {}
  
  // Test the mailbox write which should create directories
  const mailbox = new Mailbox(cwd, testTeam);
  
  try {
    await mailbox.write(testAgent, {
      from: "tester",
      text: "Test message for directory creation",
      timestamp: new Date().toISOString(),
      summary: "test"
    });
    
    console.log("✓ Mailbox write succeeded - directories created");
    
    // Verify the structure exists
    console.log(`Teams dir exists: ${fs.existsSync(teamsDir)}`);
    console.log(`Team dir exists: ${fs.existsSync(teamDir)}`);
    console.log(`Inboxes dir exists: ${fs.existsSync(inboxesDir)}`);
    console.log(`Inbox file exists: ${fs.existsSync(inboxPath)}`);
    
    // Test reading back
    const messages = await mailbox.read(testAgent);
    console.log(`✓ Read back ${messages.length} messages`);
    
    if (messages.length === 1 && messages[0].text === "Test message for directory creation") {
      console.log("✓ Message content preserved");
    } else {
      console.log("✗ Message content incorrect");
    }
    
    // Cleanup
    fs.rmSync(teamDir, { recursive: true, force: true });
    console.log("✓ Cleanup successful");
    
  } catch (error: any) {
    console.log(`✗ Mailbox write failed: ${error.message}`);
    console.log(`Error code: ${error.code}`);
  }
}

async function testWorkerPoolImport() {
  console.log("\n=== Testing WorkerPool Import ===");
  
  try {
    // Test both import styles that were causing issues
    const { workerPool } = await import("./worker-pool.ts");
    
    if (workerPool && typeof workerPool.total === "number") {
      console.log("✓ WorkerPool ESM import successful");
      console.log(`  Total workers: ${workerPool.total}`);
    } else {
      console.log("✗ WorkerPool import incomplete");
    }
    
  } catch (error: any) {
    console.log(`✗ WorkerPool import failed: ${error.message}`);
  }
}

async function testTeamsInitialization() {
  console.log("\n=== Testing Teams Initialization ===");
  
  try {
    const { getActiveTeam } = await import("./teams.ts");
    
    const activeTeam = getActiveTeam();
    
    if (activeTeam === null) {
      console.log("✓ Active team correctly initialized as null");
    } else {
      console.log("✗ Active team should be null before any team creation");
    }
    
  } catch (error: any) {
    console.log(`✗ Teams import failed: ${error.message}`);
  }
}

async function main() {
  console.log("AIM Test Fix Verification");
  console.log("========================");
  
  await testMailboxDirectoryCreation();
  await testWorkerPoolImport();
  await testTeamsInitialization();
  
  console.log("\n=== Verification Complete ===");
}

main().catch(console.error);