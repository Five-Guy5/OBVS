import { PROTOCOL_VERSION, type BroadcastSnapshot } from "@obvs/protocol";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Missing #root element");
}

// Framework-free placeholder: replace this entry when the frontend stack is chosen.
function render(container: HTMLElement, snapshot: BroadcastSnapshot | null): void {
  const heading = document.createElement("h1");
  heading.textContent = "OBVS Overlay";

  const status = document.createElement("p");
  status.textContent =
    snapshot === null
      ? "Waiting for broadcast…"
      : `${snapshot.match?.map ?? "Match"} · round ${snapshot.match?.round.number ?? "-"}`;

  const version = document.createElement("small");
  version.textContent = `Protocol v${PROTOCOL_VERSION}`;

  container.replaceChildren(heading, status, version);
}

render(root, null);
