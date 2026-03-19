export function createToolErrorMessage(message: string): string {
  return `TOOL ERROR.\n${message}\nChoose a different action or correct the INPUT.`;
}

export function createSelectorErrorMessage(message: string): string {
  return `SELECTOR ERROR.\n${message}\nRetry with a more robust selector or a different browser action.`;
}

export function createPlannerErrorMessage(message: string): string {
  return `PLANNER ERROR.\n${message}\nReturn JSON only in the required shape.`;
}
