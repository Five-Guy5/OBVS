import type { WebSocketServer } from "ws";

import { createBroadcaster, startBroadcastServer } from "./broadcast.js";
import { loadConfig } from "./config.js";
import { startIngestServer } from "./ingest.js";
import { MatchRegistry } from "./registry.js";

const config = loadConfig();
const registry = new MatchRegistry();
const host = config.host ?? "127.0.0.1";
const servers: WebSocketServer[] = [];

try {
  const ingest = await startIngestServer(config, registry);
  servers.push(ingest);
  const broadcast = await startBroadcastServer(config, createBroadcaster(config, registry));
  servers.push(broadcast);

  const access = config.authKey === null ? "open ingest" : "auth key required";
  console.log(`OBVS ingest listening on ${host}:${portOf(ingest)} (${access})`);
  console.log(`OBVS broadcast listening on ${host}:${portOf(broadcast)}`);
} catch (error) {
  // Usually a port already in use; say which before exiting.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[server] failed to start: ${message}`);
  await closeAll();
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`[server] ${signal} received, shutting down`);
    void closeAll().then(() => process.exit(0));
  });
}

/** `close()` waits for open sockets, so terminate them first. */
async function closeAll(): Promise<void> {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) {
            client.terminate();
          }
          server.close(() => resolve());
        }),
    ),
  );
}

function portOf(server: WebSocketServer): number | string {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : String(address);
}
