import type { ExecutionRoute, RuntimeAttachment } from "../agent/runtime/types.ts";

export type UploadPayload = {
  name: string;
  mimeType: string;
  contentBase64: string;
};

export type OperatorAttachment = RuntimeAttachment;

export type OperatorTaskStatus = "queued" | "running" | "completed" | "failed";

export type OperatorTaskEvent = {
  id: string;
  createdAt: string;
  type: string;
  detail: string;
};

export type OperatorTask = {
  id: string;
  prompt: string;
  route: ExecutionRoute;
  attachments: OperatorAttachment[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: OperatorTaskStatus;
  result: string | null;
  error: string | null;
  events: OperatorTaskEvent[];
};

export type OperatorMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  route: ExecutionRoute | null;
  taskId: string | null;
  attachments: OperatorAttachment[];
};

export type OperatorSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  activeTaskId: string | null;
  messages: OperatorMessage[];
  tasks: OperatorTask[];
};

export type OperatorSessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  activeTaskId: string | null;
  activeTaskStatus: OperatorTaskStatus | null;
  messageCount: number;
};
