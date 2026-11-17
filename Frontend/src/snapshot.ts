import { PROTOCOL_VERSION, type BroadcastSnapshot } from "@obvs/protocol";

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

export class MockSnapshotSource implements SnapshotSource {
  constructor(private readonly snapshot: BroadcastSnapshot = idleSnapshot) {}

  subscribe(listener: SnapshotListener): () => void {
    listener(this.snapshot);
    return () => {};
  }
}
