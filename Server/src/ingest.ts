import type { LogonResponse } from "@obvs/protocol";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import type { ServerConfig } from "./config.js";
import { isAuthorized, parseLogonRequest } from "./logon.js";
import { parseIngestEvent, type Match } from "./match.js";
import type { MatchRegistry } from "./registry.js";

const POLICY_VIOLATION = 1008;

export interface LogonOutcome {
  response: LogonResponse;
  match: Match | null;
}

/** Start the Observer ingest endpoint; resolves once the port is bound. */
export function startIngestServer(
  config: ServerConfig,
  registry: MatchRegistry,
): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ port: config.port });

    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve(server);
    });
    server.on("connection", (socket) => handleConnection(socket, config, registry));
  });
}

/** The first frame must be a logon; every later frame is an ingest event (S.2.1). */
export function handleConnection(
  socket: WebSocket,
  config: ServerConfig,
  registry: MatchRegistry,
): void {
  let match: Match | null = null;

  socket.on("message", (data, isBinary) => {
    const message = isBinary ? undefined : parseJson(data);

    if (match === null) {
      const outcome = logon(message, config, registry);

      socket.send(JSON.stringify(outcome.response));

      if (!outcome.response.accepted) {
        socket.close(POLICY_VIOLATION, "Logon rejected");
        return;
      }

      match = outcome.match;
      return;
    }

    const parsed = parseIngestEvent(message);

    // Malformed events are dropped so one bad frame cannot end the Match.
    if (parsed.ok) {
      match.append(parsed.event);
    }
  });

  socket.on("close", () => {
    if (match !== null) {
      registry.remove(match);
    }
  });
}

export function logon(
  input: unknown,
  config: ServerConfig,
  registry: MatchRegistry,
): LogonOutcome {
  const parsed = parseLogonRequest(input);

  if (!parsed.ok) {
    return reject(parsed.reason);
  }

  const { request } = parsed;

  if (!isAuthorized(config.authKey, request.authKey)) {
    return reject("Auth key rejected.");
  }

  const claim = registry.claim(request.groupCode, {
    name: request.observerName,
    clientVersion: request.clientVersion,
    connectedAt: new Date().toISOString(),
  });

  if (!claim.ok) {
    return reject(claim.reason);
  }

  return {
    response: {
      accepted: true,
      matchSecret: claim.match.secret,
      capabilities: config.capabilities,
    },
    match: claim.match,
  };
}

function reject(reason: string): LogonOutcome {
  return { response: { accepted: false, reason }, match: null };
}

function parseJson(data: RawData): unknown {
  try {
    return JSON.parse(data.toString());
  } catch {
    return undefined;
  }
}
