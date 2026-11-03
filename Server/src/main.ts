import { loadConfig } from "./config.js";
import { startIngestServer } from "./ingest.js";
import { MatchRegistry } from "./registry.js";

const config = loadConfig();
const server = await startIngestServer(config, new MatchRegistry());
const address = server.address();
const port = typeof address === "object" && address !== null ? address.port : config.port;

console.log(
  `OBVS ingest listening on port ${port} (${config.authKey === null ? "open ingest" : "auth key required"})`,
);
