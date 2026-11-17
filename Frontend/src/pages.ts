import type { BroadcastSnapshot } from "@obvs/protocol";

export type Page = (snapshot: BroadcastSnapshot) => HTMLElement;

function title(text: string): HTMLElement {
  const heading = document.createElement("h1");
  heading.textContent = text;
  return heading;
}

const waiting = (): HTMLElement => title("Waiting for match…");

// F.3: a page without an active Match shows a placeholder, never live data.
function pageFor(liveTitle: string): Page {
  return (snapshot) =>
    snapshot.match === null ? waiting() : title(liveTitle);
}

export const liveMatchPage = pageFor("Live Match");

export const agentSelectPage = pageFor("Agent Select");

export const autoswitchPage: Page = (snapshot) =>
  snapshot.match === null
    ? waiting()
    : snapshot.match.round.number === 0
      ? agentSelectPage(snapshot)
      : liveMatchPage(snapshot);

export const timeoutPage = pageFor("Timeout / Tech Pause");
