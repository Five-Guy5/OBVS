import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSupportedIngestVersion } from "../src/version.js";
import {
  V1_PROTOCOL_VERSION,
  type BroadcastSnapshot,
  type IngestEvent,
  type LogonRequest,
} from "../src/v1/index.js";
import {
  fullSnapshot,
  idleSnapshot,
  ingestSequence,
  logonExchange,
} from "./fixtures/index.js";

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Explicit assignments prove the fixtures use the shared v1 types. The
// fixtures themselves use `satisfies`, so a wire-shape change fails `tsc`.
const logonRequest: LogonRequest = logonExchange.request;
const ingestEvents: IngestEvent[] = ingestSequence;
const snapshots: BroadcastSnapshot[] = [idleSnapshot, fullSnapshot];

// @ts-expect-error - protocolVersion is numeric on the wire.
const invalidLogonVersion: LogonRequest = { ...logonRequest, protocolVersion: "1" };

// @ts-expect-error - an IngestEvent payload must match its event type.
const invalidShopPayload: IngestEvent["payload"] = { open: "yes" };

// @ts-expect-error - a BroadcastSnapshot match cannot omit its required state.
const incompleteSnapshot: BroadcastSnapshot = { ...idleSnapshot, match: { running: true } };

describe("protocol contract fixtures", () => {
  it("round-trips the logon exchange through JSON", () => {
    assert.deepEqual(roundTrip(logonExchange), logonExchange);
    assert.ok(isSupportedIngestVersion(logonExchange.request.protocolVersion));
  });

  it("round-trips the ingest sequence through JSON", () => {
    assert.deepEqual(roundTrip(ingestSequence), ingestSequence);
    assert.ok(ingestEvents.every((event) => event.protocolVersion === V1_PROTOCOL_VERSION));

    const capturedAtMs = ingestSequence.map((event) => Date.parse(event.capturedAt));
    assert.deepEqual(capturedAtMs, [...capturedAtMs].sort((left, right) => left - right));
  });

  it("round-trips idle and full Broadcast snapshots through JSON", () => {
    for (const snapshot of snapshots) {
      assert.deepEqual(roundTrip(snapshot), snapshot);
      assert.equal(snapshot.protocolVersion, V1_PROTOCOL_VERSION);
    }

    assert.equal(idleSnapshot.match, null);
    assert.equal(idleSnapshot.matchId, null);
    assert.notEqual(fullSnapshot.match, null);
    assert.notEqual(fullSnapshot.matchId, null);
  });
});
