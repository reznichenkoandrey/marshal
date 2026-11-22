// Electron side of scheduled workflows (#280), kept out of main.ts.

import path from "node:path";
import { powerMonitor } from "electron";

import { runWorkflow } from "./runner.ts";
import { WorkflowScheduler } from "./scheduler.ts";
import { WorkflowStore } from "./store.ts";

export function startWorkflows(userData: string): WorkflowScheduler {
  const scheduler = new WorkflowScheduler(new WorkflowStore(path.join(userData, "workflows")), runWorkflow);
  scheduler.start();
  // Timers do not advance while the Mac sleeps; missed runs are settled on wake.
  powerMonitor.on("resume", () => scheduler.rearm());
  return scheduler;
}
