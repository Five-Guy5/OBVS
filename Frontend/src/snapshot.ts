import {
  PROTOCOL_VERSION,
  type BroadcastSnapshot,
  type PlayerSnapshot,
} from "@obvs/protocol";

export type SnapshotListener = (snapshot: BroadcastSnapshot) => void;

export interface SnapshotSource {
  subscribe(listener: SnapshotListener): () => void;
}

export const idleSnapshot: BroadcastSnapshot = {
  protocolVersion: PROTOCOL_VERSION,
  sequence: 0,
  generatedAt: "2026-01-01T00:00:00.000Z",
  groupCode: "obvs-demo",
  matchId: null,
  match: null,
  series: { seriesId: "mock-series", wins: [0, 0], maps: [], decided: false },
  production: {
    tournament: { name: "OBVS", logoUrl: null, backdropUrl: null },
    teams: [
      { name: "Team A", tricode: "TMA", logoUrl: null, startingSide: "attack" },
      {
        name: "Team B",
        tricode: "TMB",
        logoUrl: null,
        startingSide: "defense",
      },
    ],
    seriesFormat: "BO1",
    timeout: { durationMs: 60_000, countsPerTeam: 2 },
    sponsors: [],
    watermark: { text: "OBVS", enabled: false },
    playerNameOverrides: {},
    toasts: [],
  },
  capabilities: {
    gep: false,
    cv: { enabled: false, modelsLoaded: false },
    fields: {},
  },
};

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
    abilities: null,
    resources: null,
    availability: {},
    ...overrides,
  };
}

/** A player the Server knows by name only; every live field is missing. */
function unknownPlayer(puuid: string, name: string): PlayerSnapshot {
  return player(puuid, name, "", {
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
  });
}

/** A Match in round 6 with a planted spike, one dead player, and one unknown player. */
export const liveSnapshot: BroadcastSnapshot = {
  ...idleSnapshot,
  sequence: 1,
  matchId: "mock-match",
  match: {
    running: true,
    map: "Haven",
    gameMode: "Standard",
    round: { number: 6, phase: "combat" },
    spike: { status: "planted", site: "A" },
    thresholds: { switchAfterRound: 12, overtimeFromRound: 25 },
    availability: {},
    teams: [
      {
        teamId: 0,
        name: "Team A",
        tricode: "TMA",
        logoUrl: null,
        side: "attack",
        roundsWon: 3,
        roundHistory: [],
        roundSpend: null,
        players: [
          player("p1", "Ace", "Jett"),
          player("p2", "aooga", "Brimstone"),
          player("p3", "Recurz", "Sova", { alive: false, health: 0 }),
          player("p4", "TreeTops", "Omen"),
          player("p5", "duck", "Raze"),
        ],
      },
      {
        teamId: 1,
        name: "Team B",
        tricode: "TMB",
        logoUrl: null,
        side: "defense",
        roundsWon: 2,
        roundHistory: [],
        roundSpend: null,
        players: [
          player("p6", "Terminator", "Reyna"),
          player("p7", "Pyr", "Viper"),
          player("p8", "RapidRare", "Killjoy"),
          player("p9", "waffies", "Cypher"),
          unknownPlayer("p10", "loaf"),
        ],
      },
    ],
  },
  series: {
    seriesId: "mock-series",
    wins: [1, 0],
    maps: [{ map: "Ascent", winningTeamId: 0 }],
    decided: false,
  },
  production: { ...idleSnapshot.production, seriesFormat: "BO3" },
};

export class MockSnapshotSource implements SnapshotSource {
  constructor(private readonly snapshot: BroadcastSnapshot = idleSnapshot) {}

  subscribe(listener: SnapshotListener): () => void {
    listener(this.snapshot);
    return () => {};
  }
}
