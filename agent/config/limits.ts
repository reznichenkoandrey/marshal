export const limits = {
  maxIterations: 12,
  maxRetries: 3,
  responsePollIntervalMs: 400,
  responseStableReads: 3,
  responseTimeoutMs: 45_000,
  plannerTimeoutMs: 30_000,
  shellTimeoutMs: 20_000,
  shellOutputLimit: 12_000,
  toolPageTimeoutMs: 20_000,
  selectorTimeoutMs: 8_000,
  loginWaitTimeoutMs: 300_000
};

export const allowedShellCommands = [
  "cat",
  "echo",
  "find",
  "git",
  "head",
  "ls",
  "mkdir",
  "mv",
  "node",
  "npm",
  "npx",
  "pwd",
  "rg",
  "sed",
  "stat",
  "tail",
  "touch",
  "tsc",
  "wc",
  "which"
];
