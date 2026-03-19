import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { ScriptedReasoningBridge } from "../bridge/scripted.js";
import { runMarshalTask } from "../runtime/marshal.js";
async function main() {
    const workspaceRoot = path.resolve(process.cwd(), "agent/workspace/phase4-smoke");
    const memoryDir = path.resolve(process.cwd(), "agent/memory/phase4-smoke");
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(memoryDir, { recursive: true, force: true });
    const server = await startBrowserSmokeServer();
    const browserUrl = `http://127.0.0.1:${server.port}/`;
    const events = [];
    const scenario = buildScenario(browserUrl);
    const result = await runMarshalTask({
        task: [
            "Run the Phase 4 smoke validation.",
            "Exercise filesystem, shell, and browser tools through the normal agent loop.",
            "Use the browser page to navigate, click the Launch button, and type into the Search term field."
        ].join(" "),
        route: "auto",
        workspaceRoot,
        memoryDir,
        bridge: new ScriptedReasoningBridge(scenario),
        browserHeadless: true,
        onEvent: (event) => {
            events.push(event);
        }
    }).finally(async () => {
        await stopBrowserSmokeServer(server.instance);
    });
    await verifySmokeArtifacts(workspaceRoot, events, result);
    console.log("Phase 4 smoke passed.");
    console.log(result);
}
function buildScenario(browserUrl) {
    const plan = [
        'Use write_file and read_file to create "smoke/local.txt" with "phase4 local smoke" and confirm the exact contents.',
        'Use list_dir and run_shell to inspect the "smoke" directory and print the current working directory.',
        `Use browser_navigate and browser_click to open ${browserUrl} and activate the "Launch" button.`,
        'Use browser_type to enter "marshal smoke" into the Search term field.'
    ];
    return {
        plan,
        turnsByStep: {
            [plan[0]]: [
                {
                    kind: "action",
                    thought: "Create the smoke file inside the workspace sandbox.",
                    action: "write_file",
                    input: {
                        path: "smoke/local.txt",
                        content: "phase4 local smoke"
                    }
                },
                {
                    kind: "action",
                    thought: "Read the new smoke file to verify its contents.",
                    action: "read_file",
                    input: {
                        path: "smoke/local.txt"
                    }
                },
                {
                    kind: "final",
                    result: 'Created and verified "smoke/local.txt" with the expected content.'
                }
            ],
            [plan[1]]: [
                {
                    kind: "action",
                    thought: "List the smoke directory to confirm the file is present.",
                    action: "list_dir",
                    input: {
                        path: "smoke"
                    }
                },
                {
                    kind: "action",
                    thought: "Run a safe allowed shell command inside the workspace.",
                    action: "run_shell",
                    input: {
                        cmd: "pwd"
                    }
                },
                {
                    kind: "final",
                    result: "Printed the workspace current directory with run_shell."
                }
            ],
            [plan[2]]: [
                {
                    kind: "action",
                    thought: "Open the local browser smoke page over HTTP.",
                    action: "browser_navigate",
                    input: {
                        url: browserUrl
                    }
                },
                {
                    kind: "action",
                    thought: "Click the Launch button on the smoke page.",
                    action: "browser_click",
                    input: {
                        selector: "text=Launch"
                    }
                },
                {
                    kind: "final",
                    result: "Opened the local browser smoke page and clicked the Launch button."
                }
            ],
            [plan[3]]: [
                {
                    kind: "action",
                    thought: "Type into the smoke page input using its placeholder.",
                    action: "browser_type",
                    input: {
                        selector: "placeholder=Search term",
                        text: "marshal smoke"
                    }
                },
                {
                    kind: "final",
                    result: 'Typed "marshal smoke" into the Search term field.'
                }
            ]
        },
        finalResult: "Phase 4 smoke validation succeeded across filesystem, shell, and browser tool paths through the agent loop."
    };
}
async function verifySmokeArtifacts(workspaceRoot, events, result) {
    const smokeFile = path.join(workspaceRoot, "smoke", "local.txt");
    const content = await fs.readFile(smokeFile, "utf8");
    if (content !== "phase4 local smoke") {
        throw new Error(`Unexpected smoke file content: ${content}`);
    }
    assertEvent(events, "tool_completed", "write_file");
    assertEvent(events, "tool_completed", "read_file");
    assertEvent(events, "tool_completed", "list_dir");
    assertEvent(events, "tool_completed", "run_shell");
    assertEvent(events, "tool_completed", "browser_navigate");
    assertEvent(events, "tool_completed", "browser_click");
    assertEvent(events, "tool_completed", "browser_type");
    if (!result.includes("Phase 4 smoke validation succeeded")) {
        throw new Error(`Unexpected final smoke result: ${result}`);
    }
}
function assertEvent(events, type, action) {
    const found = events.some((event) => event.type === type && "action" in event && event.action === action);
    if (!found) {
        throw new Error(`Missing ${type} event for ${action}.`);
    }
}
async function startBrowserSmokeServer() {
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Phase 4 Browser Smoke</title>
  </head>
  <body>
    <main>
      <button id="launch" type="button" onclick="document.title='Launch Clicked'; document.getElementById('status').textContent='clicked';">
        Launch
      </button>
      <label>
        Query
        <input id="query" placeholder="Search term" />
      </label>
      <p id="status">idle</p>
    </main>
  </body>
</html>`;
    const server = http.createServer((request, response) => {
        if (!request.url || request.url === "/") {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(html);
            return;
        }
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found");
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Unable to resolve smoke server port.");
    }
    return {
        instance: server,
        port: address.port
    };
}
async function stopBrowserSmokeServer(server) {
    await new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
