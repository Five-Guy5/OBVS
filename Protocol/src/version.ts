import { V1_PROTOCOL_VERSION } from "./v1/common.js";

export const PROTOCOL_VERSION = V1_PROTOCOL_VERSION;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** Keep the previous schema in this list when the protocol version bumps (NF.9.1). */
export const SUPPORTED_INGEST_VERSIONS = [V1_PROTOCOL_VERSION] as const;
export type SupportedIngestVersion = (typeof SUPPORTED_INGEST_VERSIONS)[number];

export function isSupportedIngestVersion(
  version: number,
): version is SupportedIngestVersion {
  return (SUPPORTED_INGEST_VERSIONS as readonly number[]).includes(version);
}
