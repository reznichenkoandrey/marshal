export function createToolErrorMessage(message) {
    return `TOOL ERROR.\n${message}\nChoose a different action or correct the INPUT.`;
}
export function createSelectorErrorMessage(message) {
    return `SELECTOR ERROR.\n${message}\nRetry with a more robust selector or a different browser action.`;
}
export function createPlannerErrorMessage(message) {
    return `PLANNER ERROR.\n${message}\nReturn JSON only in the required shape.`;
}
