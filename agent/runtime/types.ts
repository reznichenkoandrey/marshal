import type { ToolName } from "../core/protocol.ts";

export type ExecutionRoute = "auto" | "local" | "browser";

export type RuntimeAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
  absolutePath: string;
  uploadedAt: string;
};

/**
 * Prior user/assistant turn from the same chat session. Passed to
 * {@link runMarshalTask} so the reasoning bridge sees conversation history,
 * not just the newest message. Attachments from prior turns are kept here so
 * the model can re-read them on follow-up questions.
 */
export type RuntimePriorMessage = {
  role: "user" | "assistant";
  text: string;
  attachments: RuntimeAttachment[];
};

export type MarshalRuntimeEvent =
  | {
      type: "task_started";
      route: ExecutionRoute;
      workspaceRoot: string;
    }
  | {
      type: "planning_started";
      route: ExecutionRoute;
    }
  | {
      type: "plan_ready";
      steps: string[];
    }
  | {
      type: "step_started";
      step: string;
      stepIndex: number;
      totalSteps: number;
      iteration: number;
    }
  | {
      type: "action_requested";
      step: string;
      stepIndex: number;
      action: ToolName;
      thought: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_completed";
      step: string;
      stepIndex: number;
      action: ToolName;
      summary: string;
    }
  | {
      type: "tool_failed";
      step: string;
      stepIndex: number;
      action: ToolName;
      error: string;
    }
  | {
      type: "step_completed";
      step: string;
      stepIndex: number;
      totalSteps: number;
      summary: string;
    }
  | {
      type: "task_completed";
      result: string;
    }
  | {
      type: "task_failed";
      error: string;
    };
