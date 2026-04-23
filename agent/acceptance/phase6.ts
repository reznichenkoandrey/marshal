import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { ScriptedReasoningBridge, type ScriptedBridgeScenario } from "../bridge/scripted.ts";
import type { MarshalRuntimeEvent } from "../runtime/types.ts";
import { runMarshalTask } from "../runtime/marshal.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TestResult = { name: string; passed: boolean; error?: string };

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const BASE_WORKSPACE = path.resolve(PROJECT_ROOT, "agent/workspace/phase6-acceptance");
const BASE_MEMORY = path.resolve(PROJECT_ROOT, "agent/memory/phase6-acceptance");

async function cleanDirs(...dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function collectEvents(): { events: MarshalRuntimeEvent[]; handler: (e: MarshalRuntimeEvent) => void } {
  const events: MarshalRuntimeEvent[] = [];
  return { events, handler: (e: MarshalRuntimeEvent) => { events.push(e); } };
}

function assertToolCompleted(events: MarshalRuntimeEvent[], action: string): void {
  const found = events.some((e) => e.type === "tool_completed" && "action" in e && e.action === action);
  if (!found) {
    throw new Error(`Missing tool_completed event for ${action}`);
  }
}

// ---------------------------------------------------------------------------
// Test 1: File task (write_file + read_file)
// ---------------------------------------------------------------------------

async function testFileTask(): Promise<void> {
  const workspace = path.join(BASE_WORKSPACE, "file");
  const memory = path.join(BASE_MEMORY, "file");
  await cleanDirs(workspace, memory);

  const plan = [
    'Use write_file to create "hello.txt" with content "phase6 file acceptance".',
    'Use read_file to read "hello.txt" and verify it.'
  ];

  const scenario: ScriptedBridgeScenario = {
    plan,
    turnsByStep: {
      [plan[0]]: [
        { kind: "action", thought: "Write the file.", action: "write_file", input: { path: "hello.txt", content: "phase6 file acceptance" } },
        { kind: "final", result: 'Created "hello.txt".' }
      ],
      [plan[1]]: [
        { kind: "action", thought: "Read the file back.", action: "read_file", input: { path: "hello.txt" } },
        { kind: "final", result: 'Verified "hello.txt" content.' }
      ]
    },
    finalResult: "File task completed."
  };

  const { events, handler } = collectEvents();
  await runMarshalTask({
    task: 'Create "hello.txt" with "phase6 file acceptance" and read it back.',
    route: "local",
    workspaceRoot: workspace,
    memoryDir: memory,
    bridge: new ScriptedReasoningBridge(scenario),
    browserHeadless: true,
    onEvent: handler
  });

  // Verify filesystem side-effect
  const content = await fs.readFile(path.join(workspace, "hello.txt"), "utf8");
  if (content !== "phase6 file acceptance") {
    throw new Error(`Unexpected file content: "${content}"`);
  }

  assertToolCompleted(events, "write_file");
  assertToolCompleted(events, "read_file");
}

// ---------------------------------------------------------------------------
// Test 2: Shell task (run_shell)
// ---------------------------------------------------------------------------

async function testShellTask(): Promise<void> {
  const workspace = path.join(BASE_WORKSPACE, "shell");
  const memory = path.join(BASE_MEMORY, "shell");
  await cleanDirs(workspace, memory);

  const plan = [
    'Use run_shell to execute "echo phase6-shell-ok".',
    'Use write_file to save the shell output to "shell-result.txt".'
  ];

  const scenario: ScriptedBridgeScenario = {
    plan,
    turnsByStep: {
      [plan[0]]: [
        { kind: "action", thought: "Run echo.", action: "run_shell", input: { cmd: "echo phase6-shell-ok" } },
        { kind: "final", result: "Shell command executed." }
      ],
      [plan[1]]: [
        { kind: "action", thought: "Save the output.", action: "write_file", input: { path: "shell-result.txt", content: "phase6-shell-ok" } },
        { kind: "final", result: "Saved shell output." }
      ]
    },
    finalResult: "Shell task completed."
  };

  const { events, handler } = collectEvents();
  await runMarshalTask({
    task: 'Run "echo phase6-shell-ok" and save the output to "shell-result.txt".',
    route: "local",
    workspaceRoot: workspace,
    memoryDir: memory,
    bridge: new ScriptedReasoningBridge(scenario),
    browserHeadless: true,
    onEvent: handler
  });

  assertToolCompleted(events, "run_shell");
  assertToolCompleted(events, "write_file");

  const content = await fs.readFile(path.join(workspace, "shell-result.txt"), "utf8");
  if (content !== "phase6-shell-ok") {
    throw new Error(`Unexpected shell-result content: "${content}"`);
  }
}

// ---------------------------------------------------------------------------
// Test 3: Browser task (navigate + click + type)
// ---------------------------------------------------------------------------

async function testBrowserTask(): Promise<void> {
  const workspace = path.join(BASE_WORKSPACE, "browser");
  const memory = path.join(BASE_MEMORY, "browser");
  await cleanDirs(workspace, memory);

  const server = await startTestServer();
  const url = `http://127.0.0.1:${server.port}/`;

  try {
    const plan = [
      `Use browser_navigate to open ${url}.`,
      'Use browser_click to click the "Submit" button.',
      'Use browser_type to type "phase6" into the Search field.'
    ];

    const scenario: ScriptedBridgeScenario = {
      plan,
      turnsByStep: {
        [plan[0]]: [
          { kind: "action", thought: "Navigate to test page.", action: "browser_navigate", input: { url } },
          { kind: "final", result: "Page opened." }
        ],
        [plan[1]]: [
          { kind: "action", thought: "Click Submit.", action: "browser_click", input: { selector: "text=Submit" } },
          { kind: "final", result: "Button clicked." }
        ],
        [plan[2]]: [
          { kind: "action", thought: "Type into search.", action: "browser_type", input: { selector: "placeholder=Search", text: "phase6" } },
          { kind: "final", result: "Typed into search." }
        ]
      },
      finalResult: "Browser task completed."
    };

    const { events, handler } = collectEvents();
    await runMarshalTask({
      task: "Open a test page, click Submit, and type into the search field.",
      route: "browser",
      workspaceRoot: workspace,
      memoryDir: memory,
      bridge: new ScriptedReasoningBridge(scenario),
      browserHeadless: true,
      onEvent: handler
    });

    assertToolCompleted(events, "browser_navigate");
    assertToolCompleted(events, "browser_click");
    assertToolCompleted(events, "browser_type");
  } finally {
    await stopTestServer(server.instance);
  }
}

// ---------------------------------------------------------------------------
// Test 4: Multi-step planning task (file + shell + list_dir)
// ---------------------------------------------------------------------------

async function testMultiStepTask(): Promise<void> {
  const workspace = path.join(BASE_WORKSPACE, "multi");
  const memory = path.join(BASE_MEMORY, "multi");
  await cleanDirs(workspace, memory);

  const plan = [
    'Use write_file to create "report/data.txt" with content "phase6 multi-step".',
    'Use list_dir to list the "report" directory.',
    'Use run_shell to execute "wc -c report/data.txt".',
    'Use read_file to read "report/data.txt" and confirm.'
  ];

  const scenario: ScriptedBridgeScenario = {
    plan,
    turnsByStep: {
      [plan[0]]: [
        { kind: "action", thought: "Create the file.", action: "write_file", input: { path: "report/data.txt", content: "phase6 multi-step" } },
        { kind: "final", result: "File created." }
      ],
      [plan[1]]: [
        { kind: "action", thought: "List report dir.", action: "list_dir", input: { path: "report" } },
        { kind: "final", result: "Directory listed." }
      ],
      [plan[2]]: [
        { kind: "action", thought: "Count bytes.", action: "run_shell", input: { cmd: "wc -c report/data.txt" } },
        { kind: "final", result: "Byte count retrieved." }
      ],
      [plan[3]]: [
        { kind: "action", thought: "Read the file.", action: "read_file", input: { path: "report/data.txt" } },
        { kind: "final", result: "Content verified." }
      ]
    },
    finalResult: "Multi-step task completed successfully."
  };

  const { events, handler } = collectEvents();
  await runMarshalTask({
    task: "Create report/data.txt, list the directory, count bytes, and read back.",
    route: "auto",
    workspaceRoot: workspace,
    memoryDir: memory,
    bridge: new ScriptedReasoningBridge(scenario),
    browserHeadless: true,
    onEvent: handler
  });

  assertToolCompleted(events, "write_file");
  assertToolCompleted(events, "list_dir");
  assertToolCompleted(events, "run_shell");
  assertToolCompleted(events, "read_file");

  const content = await fs.readFile(path.join(workspace, "report", "data.txt"), "utf8");
  if (content !== "phase6 multi-step") {
    throw new Error(`Unexpected content: "${content}"`);
  }
}

// ---------------------------------------------------------------------------
// Browser test server
// ---------------------------------------------------------------------------

const TEST_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Phase 6 Browser</title></head>
<body>
  <button type="button" onclick="document.getElementById('status').textContent='submitted'">Submit</button>
  <input placeholder="Search" />
  <p id="status">idle</p>
</body></html>`;

async function startTestServer(): Promise<{ instance: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(TEST_HTML);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Cannot resolve test server port.");
  return { instance: server, port: addr.port };
}

async function stopTestServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: [string, () => Promise<void>][] = [
  ["File task (write + read)", testFileTask],
  ["Shell task (run_shell + write)", testShellTask],
  ["Browser task (navigate + click + type)", testBrowserTask],
  ["Multi-step planning task", testMultiStepTask]
];

async function main(): Promise<void> {
  console.log("=== Phase 6: End-to-End Acceptance ===\n");

  const results: TestResult[] = [];

  for (const [name, fn] of tests) {
    process.stdout.write(`  ${name} ... `);
    try {
      await fn();
      console.log("PASS");
      results.push({ name, passed: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`FAIL: ${msg}`);
      results.push({ name, passed: false, error: msg });
    }
  }

  console.log("");
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`Results: ${passed} passed, ${failed} failed out of ${results.length} tests.`);

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
    process.exitCode = 1;
  } else {
    console.log("\nAll Phase 6 acceptance tests passed.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
