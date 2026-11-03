import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PROTOCOL_VERSION, type IngestEvent } from "@obvs/protocol";

import { Match, parseIngestEvent } from "../src/match.js";
import { MatchRegistry } from "../src/registry.js";

const observer = { name: "Observer", clientVersion: "0.1.0", connectedAt: "2026-01-01T00:00:00Z" };

function shopEvent(eventId: string, capturedAt: string): IngestEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId,
    type: "shop",
    capturedAt,
    payload: { open: true },
  };
}

function eventIds(match: Match): string[] {
  return match.events.map((event) => event.eventId);
}

describe("match event append", () => {
  it("stores events in capture-timestamp order", () => {
    const match = new Match("group_1", observer);

    match.append(shopEvent("c", "2026-01-01T00:00:03Z"));
    match.append(shopEvent("a", "2026-01-01T00:00:01Z"));
    match.append(shopEvent("b", "2026-01-01T00:00:02Z"));

    assert.deepEqual(eventIds(match), ["a", "b", "c"]);
  });

  it("keeps arrival order for equal capture timestamps", () => {
    const match = new Match("group_1", observer);

    match.append(shopEvent("first", "2026-01-01T00:00:01Z"));
    match.append(shopEvent("second", "2026-01-01T00:00:01.000Z"));

    assert.deepEqual(eventIds(match), ["first", "second"]);
  });

  it("ignores a repeated event id", () => {
    const match = new Match("group_1", observer);

    assert.equal(match.append(shopEvent("a", "2026-01-01T00:00:01Z")), "appended");
    assert.equal(match.append(shopEvent("a", "2026-01-01T00:00:05Z")), "duplicate");
    assert.deepEqual(eventIds(match), ["a"]);
    assert.equal(match.events[0]?.capturedAt, "2026-01-01T00:00:01Z");
  });
});

describe("ingest event parsing", () => {
  const valid = shopEvent("a", "2026-01-01T00:00:01Z");

  function reasonFor(patch: Record<string, unknown>): string | undefined {
    const result = parseIngestEvent({ ...valid, ...patch });

    return result.ok ? undefined : result.reason;
  }

  it("accepts a well-formed envelope", () => {
    assert.equal(parseIngestEvent(valid).ok, true);
  });

  it("rejects malformed envelopes", () => {
    assert.match(reasonFor({ protocolVersion: PROTOCOL_VERSION + 1 })!, /protocol version/);
    assert.match(reasonFor({ eventId: "" })!, /Event id/);
    assert.match(reasonFor({ type: "toString" })!, /event type/);
    assert.match(reasonFor({ capturedAt: "yesterday" })!, /Capture timestamp/);
    assert.match(reasonFor({ payload: null })!, /payload/);
    assert.equal(parseIngestEvent(null).ok, false);
  });
});

describe("match registry", () => {
  it("frees the group code once its Match is removed", () => {
    const registry = new MatchRegistry();
    const first = registry.claim("group_1", observer);

    assert.ok(first.ok);
    assert.equal(registry.claim("group_1", observer).ok, false);
    assert.equal(registry.remove(first.match), true);
    assert.equal(registry.claim("group_1", observer).ok, true);
  });

  it("does not remove a newer Match through a stale reference", () => {
    const registry = new MatchRegistry();
    const first = registry.claim("group_1", observer);

    assert.ok(first.ok);
    registry.remove(first.match);

    const second = registry.claim("group_1", observer);

    assert.ok(second.ok);
    assert.equal(registry.remove(first.match), false);
    assert.equal(registry.get("group_1"), second.match);
  });
});
