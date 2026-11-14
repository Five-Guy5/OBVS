import type { IncomingMessage } from "node:http";

import type { LogonResponse } from "@obvs/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  type ServerConfig,
} from "./config.js";
import { startHeartbeat, trackLiveness } from "./heartbeat.js";
import { constantTimeEqual, isAuthorized, parseLogonRequest } from "./logon.js";
import { parseIngestEvent, type AppendResult, type Match } from "./match.js";
import type { MatchRegistry } from "./registry.js";

const POLICY_VIOLATION = 1008;
const FAILED_LOGON_WINDOW_MS = 60_000;
const MAX_FAILED_LOGONS = 5;
const SWEEP_INTERVAL_MS = 60_000;
const LOGON_TIMEOUT_MS = 10_000;

export interface LogonOutcome {
  response: LogonResponse;
  match: Match | null;
}

/** Five failed auth keys per IP per minute (NF.4.2). */
export class LogonLimiter {
  readonly #entries = new Map<string, { count: number; resetAt: number }>();

  allow(ip: string): boolean {
    const now = Date.now();
    const entry = this.#entries.get(ip);
    if (entry === undefined) return true;
    if (entry.resetAt <= now) {
      this.#entries.delete(ip);
      return true;
    }
    return entry.count < MAX_FAILED_LOGONS;
  }

  fail(ip: string): void {
    const now = Date.now();
    const entry = this.#entries.get(ip);
    if (entry === undefined || entry.resetAt <= now) {
      this.#entries.set(ip, { count: 1, resetAt: now + FAILED_LOGON_WINDOW_MS });
      return;
    }
    entry.count += 1;
  }

  reset(ip: string): void {
    this.#entries.delete(ip);
  }
}

/** Start the Observer ingest endpoint; resolves once the port is bound. */
export function startIngestServer(
  config: ServerConfig,
  registry: MatchRegistry,
): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      host: config.host ?? "127.0.0.1",
      port: config.port,
      maxPayload: config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    });
    const limiter = new LogonLimiter();

    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve(server);
    });
    server.on("error", (error) => {
      console.error(`[ingest] server error: ${error.message}`);
    });
    server.on("connection", (socket, request) => {
      trackLiveness(socket);
      handleConnection(socket, request, config, registry, limiter);
    });

    startHeartbeat(server);

    const sweeper = setInterval(() => {
      const removed = registry.sweep(config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
      if (removed > 0) console.log(`[ingest] expired ${removed} idle match(es)`);
    }, SWEEP_INTERVAL_MS);
    sweeper.unref();

    server.on("close", () => clearInterval(sweeper));
  });
}

/** The first frame must be a logon; every later frame is an ingest event (S.2.1). */
export function handleConnection(
  socket: WebSocket,
  request: IncomingMessage,
  config: ServerConfig,
  registry: MatchRegistry,
  limiter: LogonLimiter,
): void {
  let match: Match | null = null;
  const ip = request.socket.remoteAddress ?? "unknown";
  console.log(`[ingest] connection ${ip}`);

  const logonTimer = setTimeout(() => {
    if (match === null) {
      console.log(`[ingest] logon timeout ${ip}`);
      socket.close(POLICY_VIOLATION, "Logon timeout");
    }
  }, LOGON_TIMEOUT_MS);
  logonTimer.unref();

  socket.on("error", (error) => {
    clearTimeout(logonTimer);
    console.error(`[ingest] socket error ${ip}: ${error.message}`);
    socket.terminate();
  });

  socket.on("message", (data, isBinary) => {
    const message = isBinary ? undefined : parseJson(data);

    if (match === null) {
      clearTimeout(logonTimer);

      if (!limiter.allow(ip)) {
        console.log(`[ingest] logon rate limited ${ip}`);
        sendJson(socket, { accepted: false, reason: "Too many failed logons." });
        socket.close(POLICY_VIOLATION, "Logon rejected");
        return;
      }

      const outcome = logon(message, config, registry);

      if (outcome.response.accepted) {
        match = outcome.match;
        if (!match || !match.attach(socket)) {
          sendJson(socket, {
            accepted: false,
            reason: "Another Observer is already logged on for this group code.",
          });
          socket.close(POLICY_VIOLATION, "Logon rejected");
          return;
        }
        limiter.reset(ip);
        console.log(`[ingest] logon accepted ${ip} group=${match.groupCode}`);
      } else {
        if (outcome.response.reason === "Auth key rejected.") {
          limiter.fail(ip);
        }
        console.log(`[ingest] logon rejected ${ip}: ${outcome.response.reason}`);
      }

      if (!sendJson(socket, outcome.response)) {
        if (match !== null) match.detach(socket);
        socket.terminate();
        return;
      }

      if (!outcome.response.accepted) {
        socket.close(POLICY_VIOLATION, "Logon rejected");
      }
      return;
    }

    const parsed = parseIngestEvent(message);

    // Malformed events are dropped so one bad frame cannot end the Match.
    if (!parsed.ok) {
      console.log(`[ingest] dropped event ${match.groupCode}: ${parsed.reason}`);
      return;
    }

    let result: AppendResult;

    // Parsing already checks payloads; this keeps any missed case from crashing the process.
    try {
      result = match.append(parsed.event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ingest] apply error ${match.groupCode} ${parsed.event.eventId}: ${message}`);
      return;
    }

    console.log(`[ingest] event ${match.groupCode} ${parsed.event.type} ${parsed.event.eventId} (${result})`);
  });

  socket.on("close", () => {
    clearTimeout(logonTimer);
    if (match !== null) {
      match.detach(socket);
      console.log(`[ingest] disconnect ${ip} group=${match.groupCode}`);
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

  const existing = registry.get(request.groupCode);

  if (existing !== undefined) {
    if (!request.matchSecret || !constantTimeEqual(existing.secret, request.matchSecret)) {
      return reject("Match Secret rejected or missing.");
    }
    if (existing.isConnected) {
      return reject("Another Observer is already logged on for this group code.");
    }
    return {
      response: {
        accepted: true,
        matchSecret: existing.secret,
        capabilities: config.capabilities,
      },
      match: existing,
    };
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

function sendJson(socket: WebSocket, value: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    socket.send(JSON.stringify(value), (error) => {
      if (error) {
        console.error(`[ingest] send error: ${error.message}`);
        socket.terminate();
      }
    });
    return true;
  } catch (error) {
    console.error(`[ingest] send error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function parseJson(data: RawData): unknown {
  try {
    return JSON.parse(data.toString());
  } catch {
    return undefined;
  }
}
