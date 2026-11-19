import type { CapabilityAdvertisement, ProductionConfig } from "@obvs/protocol";

export interface ServerConfig {
  port: number;
  /** Null runs open ingest (S.2.1). */
  authKey: string | null;
  capabilities: CapabilityAdvertisement;
  /** Bind address; loopback by default. */
  host?: string;
  /** Maximum WebSocket payload; frames are base64 and need headroom. */
  maxPayloadBytes?: number;
  /** Inactivity window before a disconnected Match is removed (S.4). */
  idleTimeoutMs?: number;
  /** Frontend subscription port, separate from Observer ingest (S.3). */
  broadcastPort?: number;
  /** Broadcast is read-only and unauthenticated, so cap open subscriber sockets. */
  maxSubscribers?: number;
  /** Carried in every snapshot; admin editing replaces this default later (S.5.1). */
  production?: ProductionConfig;
}

/** GEP is the base source; CV stays off until the CV pipeline lands (ADR-0008). */
export const DEFAULT_CAPABILITIES: CapabilityAdvertisement = {
  gep: true,
  cv: {
    enabled: false,
    modelsLoaded: false,
  },
  fields: {},
};

/** Neutral placeholders until an admin edits the production config. */
export const DEFAULT_PRODUCTION: ProductionConfig = {
  tournament: { name: "OBVS", logoUrl: null, backdropUrl: null },
  teams: [
    { name: "Team A", tricode: "TMA", logoUrl: null, startingSide: "attack" },
    { name: "Team B", tricode: "TMB", logoUrl: null, startingSide: "defense" },
  ],
  seriesFormat: "BO1",
  timeout: { durationMs: 60_000, countsPerTeam: 2 },
  sponsors: [],
  watermark: { text: "", enabled: false },
  playerNameOverrides: {},
  toasts: [],
};

const DEFAULT_PORT = 3000;
export const DEFAULT_BROADCAST_PORT = 3001;
export const DEFAULT_MAX_SUBSCRIBERS = 256;
export const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = env.OBVS_PORT === undefined ? DEFAULT_PORT : Number(env.OBVS_PORT);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("OBVS_PORT must be an integer from 0 to 65535.");
  }

  const maxPayloadBytes = env.OBVS_MAX_PAYLOAD_BYTES === undefined
    ? DEFAULT_MAX_PAYLOAD_BYTES
    : Number(env.OBVS_MAX_PAYLOAD_BYTES);
  if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
    throw new Error("OBVS_MAX_PAYLOAD_BYTES must be a positive integer.");
  }

  const idleTimeoutMs = env.OBVS_IDLE_TIMEOUT_MS === undefined
    ? DEFAULT_IDLE_TIMEOUT_MS
    : Number(env.OBVS_IDLE_TIMEOUT_MS);
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new Error("OBVS_IDLE_TIMEOUT_MS must be a positive integer.");
  }

  const broadcastPort = env.OBVS_BROADCAST_PORT === undefined
    ? DEFAULT_BROADCAST_PORT
    : Number(env.OBVS_BROADCAST_PORT);
  if (!Number.isInteger(broadcastPort) || broadcastPort < 0 || broadcastPort > 65535) {
    throw new Error("OBVS_BROADCAST_PORT must be an integer from 0 to 65535.");
  }

  const maxSubscribers = env.OBVS_MAX_SUBSCRIBERS === undefined
    ? DEFAULT_MAX_SUBSCRIBERS
    : Number(env.OBVS_MAX_SUBSCRIBERS);
  if (!Number.isInteger(maxSubscribers) || maxSubscribers <= 0) {
    throw new Error("OBVS_MAX_SUBSCRIBERS must be a positive integer.");
  }

  // A blank key is treated as unset so an empty variable never locks every Observer out.
  const authKey = env.OBVS_AUTH_KEY || null;

  return {
    host: env.OBVS_HOST?.trim() || "127.0.0.1",
    port,
    authKey,
    capabilities: DEFAULT_CAPABILITIES,
    maxPayloadBytes,
    idleTimeoutMs,
    broadcastPort,
    maxSubscribers,
    production: DEFAULT_PRODUCTION,
  };
}
