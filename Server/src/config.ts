import type { CapabilityAdvertisement } from "@obvs/protocol";

export interface ServerConfig {
  port: number;
  /** Null runs open ingest (S.2.1). */
  authKey: string | null;
  capabilities: CapabilityAdvertisement;
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

const DEFAULT_PORT = 3000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = env.OBVS_PORT === undefined ? DEFAULT_PORT : Number(env.OBVS_PORT);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("OBVS_PORT must be an integer from 0 to 65535.");
  }

  // A blank key is treated as unset so an empty variable never locks every Observer out.
  const authKey = env.OBVS_AUTH_KEY || null;

  return { port, authKey, capabilities: DEFAULT_CAPABILITIES };
}
