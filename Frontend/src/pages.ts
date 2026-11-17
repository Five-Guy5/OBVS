import type { BroadcastSnapshot } from "@obvs/protocol";

export type Page = (snapshot: BroadcastSnapshot) => HTMLElement;

function title(text: string): HTMLElement {
  const heading = document.createElement("h1");
  heading.textContent = text;
  return heading;
}

export const liveMatchPage: Page = () => title("Live Match");

export const agentSelectPage: Page = () => title("Agent Select");

export const autoswitchPage: Page = (snapshot) =>
  snapshot.match !== null && snapshot.match.round.number === 0
    ? agentSelectPage(snapshot)
    : liveMatchPage(snapshot);

export const timeoutPage: Page = () => title("Timeout / Tech Pause");
