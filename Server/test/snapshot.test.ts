import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProductionConfig } from "@obvs/protocol";

import { DEFAULT_CAPABILITIES, DEFAULT_PRODUCTION } from "../src/config.js";
import {
  buildSnapshotContent,
  seriesKey,
  sideFor,
  stripUrlCredentials,
  type SnapshotInput,
} from "../src/snapshot.js";
import { replay } from "../src/state.js";
import { ingestSequence } from "../../Protocol/test/fixtures/index.js";

const production: ProductionConfig = {
  ...DEFAULT_PRODUCTION,
  seriesFormat: "BO3",
  playerNameOverrides: { "player-1": "Ace" },
};

function input(patch: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    groupCode: "group_1",
    match: { matchId: "match-1", state: replay(ingestSequence) },
    seriesId: "series-group_1",
    seriesResults: [],
    production,
    capabilities: DEFAULT_CAPABILITIES,
    ...patch,
  };
}

describe("snapshot content", () => {
  it("renders an idle group with no Match", () => {
    const content = buildSnapshotContent(input({ match: null }));

    assert.equal(content.matchId, null);
    assert.equal(content.match, null);
    assert.deepEqual(content.series, {
      seriesId: "series-group_1",
      wins: [0, 0],
      maps: [],
      decided: false,
    });
    assert.deepEqual(content.production, production);
    assert.deepEqual(content.capabilities, DEFAULT_CAPABILITIES);
  });

  it("fills five players per team in slot order, with placeholders", () => {
    const match = buildSnapshotContent(input()).match;

    assert.ok(match);
    for (const team of match.teams) {
      assert.equal(team.players.length, 5);
    }

    const [ace, ...empty] = match.teams[0].players;
    assert.equal(ace.puuid, "player-1");
    assert.equal(ace.name, "Ace");
    assert.equal(ace.observed, true);
    assert.equal(ace.availability.observed?.updatedAt, "2026-01-01T00:00:07.000Z");
    assert.equal(match.teams[1].players[0].puuid, "player-6");
    assert.equal(match.teams[1].players[0].observed, false);
    assert.ok(empty.every((player) => player.puuid === "" && player.agent === null));
  });

  it("takes team identity and starting sides from the production config", () => {
    const match = buildSnapshotContent(input()).match;

    assert.ok(match);
    assert.equal(match.teams[0].name, "Team A");
    assert.equal(match.teams[0].side, "attack");
    assert.equal(match.teams[1].side, "defense");
    assert.deepEqual(match.thresholds, { switchAfterRound: 12, overtimeFromRound: 25 });
  });

  it("counts recorded maps and the live map in the series", () => {
    const series = buildSnapshotContent(
      input({ seriesResults: [{ key: "earlier:game", map: "Ascent", winningTeamId: 1 }] }),
    ).series;

    assert.deepEqual(series.maps, [
      { map: "Ascent", winningTeamId: 1 },
      { map: "/Game/Maps/Haven/Haven", winningTeamId: null },
    ]);
    assert.deepEqual(series.wins, [0, 1]);
    assert.equal(series.decided, false);
  });

  it("marks the series decided once a team reaches the format's wins", () => {
    const series = buildSnapshotContent(
      input({
        seriesResults: [
          { key: "m1:game", map: "Ascent", winningTeamId: 0 },
          { key: seriesKey("match-1", replay(ingestSequence)), map: "Haven", winningTeamId: 0 },
        ],
      }),
    ).series;

    assert.deepEqual(series.wins, [2, 0]);
    assert.equal(series.maps.length, 2);
    assert.equal(series.decided, true);
  });

  it("strips credentials from production URLs", () => {
    const content = buildSnapshotContent(
      input({
        production: {
          ...production,
          tournament: {
            ...production.tournament,
            logoUrl: "https://user:pass@cdn.example.com/logo.png",
          },
          sponsors: [
            { name: "S", logoUrl: "https://token@cdn.example.com/s.png", durationMs: 1000 },
          ],
        },
      }),
    );

    assert.equal(content.production.tournament.logoUrl, "https://cdn.example.com/logo.png");
    assert.equal(content.production.sponsors[0]?.logoUrl, "https://cdn.example.com/s.png");
    assert.equal(stripUrlCredentials("not a url"), "not a url");
  });
});

describe("team sides", () => {
  const thresholds = { switchAfterRound: 12, overtimeFromRound: 25 };

  it("swaps after the first half and alternates in overtime", () => {
    assert.equal(sideFor("attack", 1, thresholds), "attack");
    assert.equal(sideFor("attack", 12, thresholds), "attack");
    assert.equal(sideFor("attack", 13, thresholds), "defense");
    assert.equal(sideFor("attack", 24, thresholds), "defense");
    assert.equal(sideFor("attack", 25, thresholds), "attack");
    assert.equal(sideFor("attack", 26, thresholds), "defense");
  });
});
