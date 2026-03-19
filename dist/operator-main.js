import { OperatorServer } from "./operator/server.js";
const server = new OperatorServer();
await server.start();
console.log(`Operator web console listening on http://127.0.0.1:${server.port}`);
const shutdown = async () => {
    await server.close().catch(() => undefined);
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
