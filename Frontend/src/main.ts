import { resolveRoute } from "./router.js";
import { liveSnapshot, MockSnapshotSource, type SnapshotSource } from "./snapshot.js";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Missing #root element");
}

const page = resolveRoute(window.location.pathname);
// Replace with the Broadcast socket source once it exists.
const source: SnapshotSource = new MockSnapshotSource(liveSnapshot);

let lastMatchId: string | null = null;
let lastSequence = -1;

source.subscribe((snapshot) => {
  // Drop stale updates: an older snapshot for the same Match arriving late.
  if (snapshot.matchId === lastMatchId && snapshot.sequence <= lastSequence) {
    return;
  }

  lastMatchId = snapshot.matchId;
  lastSequence = snapshot.sequence;
  root.replaceChildren(page(snapshot));
});
