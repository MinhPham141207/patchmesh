import { resolve } from "node:path";
import { startObservationSidecarServer } from "./sidecar.js";

const root = resolve(process.argv[2] ?? process.cwd());
const server = await startObservationSidecarServer(root);
const stop = async (): Promise<void> => { await server.close(); process.exit(0); };
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
