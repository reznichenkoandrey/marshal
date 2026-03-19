import "electron";
import { OperatorTaskService } from "../operator/task-service.js";
const service = new OperatorTaskService();
const parentPort = process.parentPort;
if (!parentPort) {
    throw new Error("Marshal desktop backend must run inside an Electron utility process.");
}
const handlers = {
    getHealth: async () => service.getHealth(),
    listProjects: async () => service.listProjects(),
    createProject: async (name) => service.createProject(typeof name === "string" ? name : undefined),
    listSessions: async (projectId) => service.listSessions(typeof projectId === "string" ? projectId : undefined),
    createSession: async (input) => {
        const payload = isObject(input) ? input : {};
        return service.createSession(asOptionalString(payload.title), asOptionalString(payload.projectId));
    },
    readSession: async (input) => {
        const payload = expectObject(input);
        return service.readSession(asRequiredString(payload.sessionId, "sessionId"), asOptionalString(payload.projectId));
    },
    deleteSession: async (input) => {
        const payload = expectObject(input);
        await service.deleteSession(asRequiredString(payload.sessionId, "sessionId"), asOptionalString(payload.projectId));
        return null;
    },
    submitTask: async (input) => {
        const payload = expectObject(input);
        return service.submitTask({
            sessionId: asRequiredString(payload.sessionId, "sessionId"),
            projectId: asOptionalString(payload.projectId),
            text: asRequiredString(payload.text, "text"),
            route: payload.route === "local" || payload.route === "browser" ? payload.route : "auto",
            uploads: Array.isArray(payload.uploads) ? payload.uploads : []
        });
    },
    getSessionPaths: async (input) => {
        const payload = expectObject(input);
        return service.getSessionPaths(asRequiredString(payload.sessionId, "sessionId"), asOptionalString(payload.projectId));
    }
};
void bootstrap();
async function bootstrap() {
    await service.initialize();
    parentPort.on("message", async (event) => {
        const message = event.data;
        if (!message || message.kind !== "invoke") {
            return;
        }
        const response = await handleRequest(message);
        parentPort.postMessage(response);
    });
}
async function handleRequest(message) {
    try {
        const handler = handlers[message.method];
        if (!handler) {
            throw new Error(`Unsupported backend method: ${message.method}`);
        }
        const result = await handler(...message.params);
        return {
            kind: "success",
            id: message.id,
            result
        };
    }
    catch (error) {
        return {
            kind: "failure",
            id: message.id,
            error: error instanceof Error ? error.message : "Unknown desktop backend error."
        };
    }
}
function expectObject(value) {
    if (!isObject(value)) {
        throw new Error("Expected an object payload.");
    }
    return value;
}
function isObject(value) {
    return typeof value === "object" && value !== null;
}
function asOptionalString(value) {
    return typeof value === "string" ? value : undefined;
}
function asRequiredString(value, fieldName) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Expected a non-empty string for ${fieldName}.`);
    }
    return value;
}
