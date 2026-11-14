import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PROTOCOL_VERSION, type IngestEvent } from "@obvs/protocol";

import { Match } from "../src/match.js";
import { applyEvent, initialMatchState, replay, type MatchState } from "../src/state.js";
import { ingestSequence } from "../../Protocol/test/fixtures/index.js";

const observer = { name: "Observer", clientVersion: "0.1.0", connectedAt: "2026-01-01T00:00:00Z" };

function event<TType extends IngestEvent["type"]>(
  eventId: string,
  type: TType,
  capturedAt: string,
  payload: Extract<IngestEvent, { type: TType }>["payload"],
): IngestEvent {
  return { protocolVersion: PROTOCOL_VERSION, eventId, type, capturedAt, payload } as IngestEvent;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }

  return value;
}

describe("applyEvent against the recorded ingest fixture", () => {
  const state = replay(ingestSequence);

  it("derives match info, round, spike, and result", () => {
    assert.equal(state.map, "/Game/Maps/Haven/Haven");
    assert.equal(state.gameMode, "Standard");
    assert.deepEqual(state.round, { number: 1, phase: "shopping" });
    assert.deepEqual(state.spike, { status: "planted", site: "A" });
    assert.deepEqual(state.roundsWon, [0, 0]);
    assert.equal(state.running, false);
    assert.equal(state.ended, true);
    assert.equal(state.winningTeamId, 0);
    assert.equal(state.observedPuuid, "player-1");
  });

  it("merges roster and scoreboard data per player", () => {
    const ace = state.players["player-1"];

    assert.ok(ace);
    assert.equal(ace.slot, 1);
    assert.equal(ace.agent, "Jett");
    assert.deepEqual(ace.kda, { kills: 3, deaths: 1, assists: 2 });
    assert.equal(ace.money, 3900);
    assert.deepEqual(ace.weapon, { primary: "Vandal", secondary: null, equipped: null });
    assert.equal(ace.availability.money?.updatedAt, "2026-01-01T00:00:06.000Z");
    assert.equal(state.players["player-6"]?.alive, false);
  });

  it("is deterministic and never mutates its input", () => {
    let frozen: MatchState = deepFreeze(initialMatchState());

    for (const next of ingestSequence) {
      frozen = deepFreeze(applyEvent(frozen, next));
    }

    assert.deepEqual(frozen, state);
    assert.deepEqual(replay(ingestSequence), state);
  });

  it("reaches the same state when events arrive out of capture order", () => {
    const match = new Match("group_1", observer);

    for (const next of [...ingestSequence].reverse()) {
      match.append(next);
    }

    match.append(ingestSequence[3]!);
    assert.deepEqual(match.state, state);
  });
});

describe("applyEvent round tracking", () => {
  it("records a round result with the spike outcome as the reason", () => {
    const state = replay([
      event("r1", "round", "2026-01-01T00:00:01Z", { number: 1, phase: "combat" }),
      event("s1", "spike", "2026-01-01T00:00:02Z", { action: "planted", site: "B" }),
      event("s2", "spike", "2026-01-01T00:00:03Z", { action: "detonated" }),
      event("c1", "score", "2026-01-01T00:00:04Z", { rounds: [0, 1] }),
      event("r2", "round", "2026-01-01T00:00:05Z", { number: 2, phase: "shopping" }),
      event("c2", "score", "2026-01-01T00:00:06Z", { rounds: [1, 1] }),
    ]);

    assert.deepEqual(state.roundHistory, [
      { roundNumber: 1, winningTeamId: 1, reason: "detonated", recordedAt: "2026-01-01T00:00:04Z" },
      { roundNumber: 2, winningTeamId: 0, reason: "unknown", recordedAt: "2026-01-01T00:00:06Z" },
    ]);
    assert.equal(state.spike, null);
    assert.deepEqual(state.roundsWon, [1, 1]);
  });

  it("does not invent history when the score jumps", () => {
    const state = replay([
      event("c1", "score", "2026-01-01T00:00:01Z", { rounds: [5, 3] }),
    ]);

    assert.deepEqual(state.roundsWon, [5, 3]);
    assert.deepEqual(state.roundHistory, []);
  });

  it("starts the next map fresh when GEP reports a new game id", () => {
    const state = replay([
      ...ingestSequence,
      event("next", "match.info", "2026-01-01T00:10:00.000Z", { matchId: "map-2", map: "Bind" }),
    ]);

    assert.equal(state.gameId, "map-2");
    assert.equal(state.map, "Bind");
    assert.equal(state.running, true);
    assert.equal(state.ended, false);
    assert.deepEqual(state.players, {});
  });

  it("keeps state when match.info repeats the same game id", () => {
    const state = replay([
      ...ingestSequence.slice(0, 7),
      event("again", "match.info", "2026-01-01T00:00:06.500Z", { matchId: "fixture-match" }),
    ]);

    assert.ok(state.players["player-1"]);
    assert.equal(state.map, "/Game/Maps/Haven/Haven");
  });

  it("records a manual spike plant with the manual source", () => {
    const state = replay([
      event("m1", "manual", "2026-01-01T00:00:01Z", { action: "spike_planted" }),
    ]);

    assert.deepEqual(state.spike, { status: "planted", site: null });
    assert.equal(state.availability.spike?.source, "manual");
  });
});
