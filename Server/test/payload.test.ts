import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PROTOCOL_VERSION, type IngestEvent } from "@obvs/protocol";

import { Match, parseIngestEvent } from "../src/match.js";
import { ingestSequence } from "../../Protocol/test/fixtures/index.js";

const observer = { name: "Observer", clientVersion: "0.1.0", connectedAt: "2026-01-01T00:00:00Z" };

function reasonFor(type: string, payload: unknown): string | undefined {
  const result = parseIngestEvent({
    protocolVersion: PROTOCOL_VERSION,
    eventId: "e1",
    type,
    capturedAt: "2026-01-01T00:00:00Z",
    payload,
  });

  return result.ok ? undefined : result.reason;
}

const scoreboardPlayer = {
  puuid: "player-1",
  name: "Ace#NA1",
  agent: "Jett",
  teamId: 0,
  kills: 0,
  deaths: 0,
  assists: 0,
  money: 800,
  alive: true,
  armor: "none",
  primaryWeapon: null,
  spikeCarrier: false,
  ult: { points: 0, max: 7 },
};

describe("ingest payload validation", () => {
  it("accepts every event in the recorded fixture", () => {
    for (const event of ingestSequence) {
      assert.equal(parseIngestEvent(event).ok, true, event.type);
    }
  });

  it("rejects payloads the reducer cannot read", () => {
    assert.match(reasonFor("score", {})!, /Score/);
    assert.match(reasonFor("score", { rounds: [1] })!, /Score/);
    assert.match(reasonFor("score", { rounds: [1, -1] })!, /Score/);
    assert.match(reasonFor("round", { number: "1", phase: "combat" })!, /Round/);
    assert.match(reasonFor("round", { number: 1, phase: "overtime" })!, /Round/);
    assert.match(reasonFor("spike", { action: "exploded" })!, /Spike/);
    assert.match(reasonFor("spike", { action: "planted", site: "D" })!, /Spike/);
    assert.match(reasonFor("roster", { players: [{ puuid: "" }] })!, /Roster/);
    assert.match(reasonFor("roster", {})!, /Roster/);
    for (const patch of [{ ult: null }, { teamId: 2 }, { money: -1 }, { armor: "medium" }]) {
      const players = [{ ...scoreboardPlayer, ...patch }];
      assert.match(reasonFor("scoreboard", { players })!, /Scoreboard/, JSON.stringify(patch));
    }
    assert.match(reasonFor("kill", {})!, /Kill/);
    assert.match(reasonFor("observing", { puuid: 7 })!, /Observing/);
    assert.match(reasonFor("manual", { action: "reboot" })!, /manual/);
    assert.match(reasonFor("match.end", { winningTeamId: 5 })!, /Match end/);
    assert.match(reasonFor("match.info", { map: 42 })!, /match.info/);
  });

  it("accepts a valid scoreboard and a drawn match end", () => {
    assert.equal(reasonFor("scoreboard", { players: [scoreboardPlayer] }), undefined);
    assert.equal(reasonFor("match.end", { winningTeamId: null }), undefined);
  });
});

describe("match append failure", () => {
  it("leaves the Match intact when an event cannot be applied", () => {
    const match = new Match("group_1", observer);
    match.append(ingestSequence[0]!);

    // Bypasses the parse gate on purpose to prove state is applied before the event is stored.
    const broken = { ...ingestSequence[5]!, eventId: "broken", payload: {} } as IngestEvent;

    assert.throws(() => match.append(broken));
    assert.equal(match.events.length, 1);
    const repaired = { ...broken, payload: { rounds: [0, 0] } } as IngestEvent;
    assert.equal(match.append(repaired), "appended");
  });
});
