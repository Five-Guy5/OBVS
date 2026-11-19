import { timingSafeEqual } from "node:crypto";

import { isSupportedIngestVersion, type LogonRequest } from "@obvs/protocol";

export type LogonParseResult =
  | { ok: true; request: LogonRequest }
  | { ok: false; reason: string };

export const GROUP_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const MAX_TEXT_LENGTH = 64;
const MAX_AUTH_KEY_LENGTH = 1024;
// Update alongside the Client package version.
const SUPPORTED_CLIENT_VERSIONS = new Set(["0.1.0"]);

/** Check an untrusted logon frame; the version gate runs before any other field (NF.9.1). */
export function parseLogonRequest(input: unknown): LogonParseResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "Logon must be a JSON object." };
  }

  const values = input as Record<string, unknown>;

  if (
    typeof values.protocolVersion !== "number" ||
    !isSupportedIngestVersion(values.protocolVersion)
  ) {
    return { ok: false, reason: "Unsupported protocol version." };
  }

  const { protocolVersion, groupCode, observerName, clientVersion, authKey, matchSecret } =
    values;

  if (typeof groupCode !== "string" || !GROUP_CODE_PATTERN.test(groupCode)) {
    return {
      ok: false,
      reason: "Group code must be 1-64 letters, digits, hyphens, or underscores.",
    };
  }

  if (!isDisplayText(observerName)) {
    return { ok: false, reason: "Observer display name must be 1-64 printable characters." };
  }

  if (!isDisplayText(clientVersion)) {
    return { ok: false, reason: "Client version must be 1-64 printable characters." };
  }

  if (!SUPPORTED_CLIENT_VERSIONS.has(clientVersion.trim())) {
    return { ok: false, reason: "Unsupported client version." };
  }

  if (
    authKey !== null &&
    (typeof authKey !== "string" || authKey.length === 0 || authKey.length > MAX_AUTH_KEY_LENGTH)
  ) {
    return { ok: false, reason: "Auth key must be null or a 1-1024 character string." };
  }

  if (matchSecret !== undefined && typeof matchSecret !== "string") {
    return { ok: false, reason: "Match secret must be a string when present." };
  }

  const request: LogonRequest = {
    protocolVersion,
    groupCode,
    observerName: observerName.trim(),
    clientVersion: clientVersion.trim(),
    authKey,
  };

  if (matchSecret !== undefined) {
    request.matchSecret = matchSecret;
  }

  return { ok: true, request };
}

/** A null server key means open ingest; otherwise the client key must match exactly. */
export function isAuthorized(serverKey: string | null, clientKey: string | null): boolean {
  if (serverKey === null) {
    return true;
  }

  return clientKey !== null && constantTimeEqual(serverKey, clientKey);
}

function isDisplayText(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const text = value.trim();

  return text.length > 0 && text.length <= MAX_TEXT_LENGTH && !CONTROL_CHARACTERS.test(text);
}

export function constantTimeEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");

  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
