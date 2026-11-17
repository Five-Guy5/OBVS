import { resolveRoute } from "./router.js";
import { MockSnapshotSource, type SnapshotSource } from "./snapshot.js";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Missing #root element");
}

const page = resolveRoute(window.location.pathname);
// Idle fixture only; replace with the Broadcast socket source once it exists.
const source: SnapshotSource = new MockSnapshotSource();

source.subscribe((snapshot) => {
  root.replaceChildren(page(snapshot));
});
