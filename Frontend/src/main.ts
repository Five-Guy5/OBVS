import { resolveRoute } from "./router.js";
import { MockSnapshotSource, type SnapshotSource } from "./snapshot.js";
import type { BroadcastSnapshot } from "@obvs/protocol";
import { idleSnapshot } from "./snapshot.js";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Missing #root element");
}

const page = resolveRoute(window.location.pathname);
// Replace with the Broadcast socket source once it exists.
const player = (name: string, agent: string | null, alive = true) => ({
  puuid: name,
  name,
  agent,
  alive,
});

const testSnapshot = {
  ...idleSnapshot,
  match: {
    running: true,
    map: "Haven",
    gameMode: "Standard",
    round: { number: 0, phase: "shopping" }, // 0 = Agent Select, 1+ = Live Match
    spike: null,
    thresholds: { switchAfterRound: 12, overtimeFromRound: 25 },
    availability: {},
    teams: [
      {
        teamId: 0,
        tricode: "TMA",
        roundsWon: 3,
        players: [
          player("Ace", "Jett"),
          player("aooga", null),
          player("Recurz", "Sova", false),
          player("TreeTops", "Omen"),
          player("duck", "Raze"),
        ],
      },
      {
        teamId: 1,
        tricode: "TMB",
        roundsWon: 2,
        players: [
          player("Terminator", "Reyna"),
          player("Pyr", null),
          player("RapidRare", "Killjoy"),
          player("waffies", "Viper"),
          player("loaf", "Cypher"),
        ],
      },
    ],
  },
} as unknown as BroadcastSnapshot;

const source: SnapshotSource = new MockSnapshotSource(testSnapshot);

source.subscribe((snapshot) => {
  root.replaceChildren(page(snapshot));
});
