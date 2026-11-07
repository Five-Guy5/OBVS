import {
  V1_PROTOCOL_VERSION,
  type BroadcastSnapshot,
  type CapabilityAdvertisement,
  type PlayerSnapshot,
  type PlayerTuple,
  type ProductionConfig,
  type RoundResult,
  type TeamId,
  type TeamSide,
  type TeamSnapshot,
} from "../../src/v1/index.js";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

function player(
  puuid: string,
  name: string,
  agent: string,
  overrides: Partial<PlayerSnapshot> = {},
): PlayerSnapshot {
  return {
    puuid,
    name,
    agent,
    alive: true,
    health: 100,
    shield: 50,
    armor: "heavy",
    weapon: { primary: "Vandal", secondary: "Classic", equipped: "Vandal" },
    money: 3900,
    kda: { kills: 3, deaths: 1, assists: 2 },
    ult: { points: 4, max: 7 },
    spikeCarrier: false,
    observed: false,
    abilities: [
      { slot: "C", charges: 1 },
      { slot: "Q", charges: 2 },
      { slot: "E", charges: 1 },
      { slot: "X", charges: 0 },
    ],
    resources: null,
    availability: {
      agent: { source: "gep", updatedAt: UPDATED_AT },
      alive: { source: "gep", updatedAt: UPDATED_AT },
      health: { source: "cv", updatedAt: UPDATED_AT },
      shield: { source: "cv", updatedAt: UPDATED_AT },
    },
    ...overrides,
  };
}

function team(
  teamId: TeamId,
  name: string,
  tricode: string,
  side: TeamSide,
  roundsWon: number,
  roundHistory: RoundResult[],
  players: PlayerTuple,
): TeamSnapshot {
  return {
    teamId,
    name,
    tricode,
    logoUrl: null,
    side,
    roundsWon,
    roundHistory,
    roundSpend: 20_000,
    players,
  };
}

const roundHistory: RoundResult[] = [
  { roundNumber: 1, winningTeamId: 0, reason: "elimination", recordedAt: UPDATED_AT },
  { roundNumber: 2, winningTeamId: 1, reason: "detonated", recordedAt: UPDATED_AT },
  { roundNumber: 3, winningTeamId: 0, reason: "defused", recordedAt: UPDATED_AT },
  { roundNumber: 4, winningTeamId: null, reason: "unknown", recordedAt: UPDATED_AT },
  { roundNumber: 5, winningTeamId: 1, reason: "timeout", recordedAt: UPDATED_AT },
];

const teamZeroPlayers: PlayerTuple = [
  player("player-1", "Ace#NA1", "Jett", { observed: true }),
  player("player-2", "Brim#NA1", "Brimstone", {
    armor: "light",
    weapon: { primary: null, secondary: "Classic", equipped: "Classic" },
    money: 1200,
  }),
  player("player-3", "Cypher#NA1", "Cypher", {
    armor: "none",
    abilities: [
      { slot: "C", charges: 0 },
      { slot: "Q", charges: 1 },
      { slot: "E", charges: 2 },
      { slot: "X", charges: null },
    ],
  }),
  player("player-4", "Viper#NA1", "Viper", {
    weapon: { primary: "Spectre", secondary: "Classic", equipped: "Spectre" },
    resources: [{ name: "Viper fuel", value: 85 }],
  }),
  player("player-5", "Raze#NA1", "Raze", {
    kda: { kills: 5, deaths: 0, assists: 0 },
    ult: { points: 7, max: 8 },
  }),
];

const teamOnePlayers: PlayerTuple = [
  player("player-6", "Rival#NA1", "Sova", { observed: false }),
  player("player-7", "Smoke#NA1", "Omen"),
  player("player-8", "Sentinel#NA1", "Killjoy", { alive: false, health: 0 }),
  player("player-9", "Duelist#NA1", "Reyna", {
    spikeCarrier: true,
    weapon: { primary: "Phantom", secondary: "Ghost", equipped: "Phantom" },
  }),
  // Null fields exercise the placeholder path the Frontend must render (F.3).
  player("player-10", "Placeholder#NA1", "Unknown", {
    agent: null,
    alive: null,
    health: null,
    shield: null,
    armor: null,
    weapon: null,
    money: null,
    kda: null,
    ult: null,
    spikeCarrier: null,
    observed: null,
    abilities: null,
    resources: null,
    availability: {},
  }),
];

const production = {
  tournament: {
    name: "OBVS Fixture Cup",
    logoUrl: null,
    backdropUrl: null,
  },
  teams: [
    {
      name: "Missouri S&T Esports",
      tricode: "MST",
      logoUrl: null,
      startingSide: "attack",
    },
    {
      name: "Fixture State",
      tricode: "FIX",
      logoUrl: null,
      startingSide: "defense",
    },
  ],
  seriesFormat: "BO3",
  timeout: { durationMs: 30_000, countsPerTeam: 2 },
  sponsors: [
    {
      name: "Fixture Sponsor",
      logoUrl: "https://example.com/fixture-sponsor.png",
      durationMs: 15_000,
    },
  ],
  watermark: { text: "OBVS", enabled: true },
  playerNameOverrides: { "player-1": "Ace" },
  toasts: [{ id: "tech-pause", text: "Tech pause" }],
} satisfies ProductionConfig;

const capabilities = {
  gep: true,
  cv: { enabled: true, modelsLoaded: true },
  fields: { map: "gep", health: "cv", shield: "cv", weapon: "gep" },
} satisfies CapabilityAdvertisement;

/** Nothing live yet: pages render placeholders from this shape (S.3, F.3). */
export const idleSnapshot = {
  protocolVersion: V1_PROTOCOL_VERSION,
  sequence: 0,
  generatedAt: "2026-01-01T00:00:00.000Z",
  groupCode: "obvs-demo",
  matchId: null,
  match: null,
  series: {
    seriesId: "fixture-series",
    wins: [0, 0],
    maps: [],
    decided: false,
  },
  production,
  capabilities,
} satisfies BroadcastSnapshot;

/** A live Match with full player, series, config, and capability data (S.3). */
export const fullSnapshot = {
  protocolVersion: V1_PROTOCOL_VERSION,
  sequence: 42,
  generatedAt: "2026-01-01T00:20:00.000Z",
  groupCode: "obvs-demo",
  matchId: "fixture-match",
  match: {
    running: true,
    map: "Haven",
    gameMode: "Standard",
    round: { number: 6, phase: "combat" },
    spike: { status: "planted", site: "A" },
    thresholds: { switchAfterRound: 12, overtimeFromRound: 25 },
    teams: [
      team(0, "Missouri S&T Esports", "MST", "attack", 2, roundHistory, teamZeroPlayers),
      team(1, "Fixture State", "FIX", "defense", 2, roundHistory, teamOnePlayers),
    ],
    availability: {
      map: { source: "gep", updatedAt: UPDATED_AT },
      gameMode: { source: "gep", updatedAt: UPDATED_AT },
      round: { source: "gep", updatedAt: UPDATED_AT },
      spike: { source: "manual", updatedAt: UPDATED_AT },
    },
  },
  series: {
    seriesId: "fixture-series",
    wins: [1, 1],
    maps: [
      { map: "Ascent", winningTeamId: 0 },
      { map: "Bind", winningTeamId: 1 },
      { map: "Haven", winningTeamId: null },
    ],
    decided: false,
  },
  production,
  capabilities,
} satisfies BroadcastSnapshot;
