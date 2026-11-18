import type {
  BroadcastSnapshot,
  MatchSnapshot,
  PlayerSnapshot,
  TeamSnapshot,
} from "@obvs/protocol";

export type Page = (snapshot: BroadcastSnapshot) => HTMLElement;

/** Shown for any field the Server has not reported. */
const MISSING = "—";

function el(tag: string, className: string, ...children: Array<Node | string>): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.append(...children);
  return element;
}

function title(text: string): HTMLElement {
  const heading = document.createElement("h1");
  heading.textContent = text;
  return heading;
}

function show(value: string | number | null): string {
  return value === null ? MISSING : String(value);
}

function playerPanel(player: PlayerSnapshot): HTMLElement {
  const dead = player.alive === false;

  return el(
    "div",
    dead ? "dead" : "",
    `${player.name} · ${show(player.agent)} · ${dead ? "Dead" : `${show(player.health)} HP`}`,
  );
}

function teamPanels(team: TeamSnapshot): HTMLElement {
  return el("div", `team team-${team.teamId}`, ...team.players.map(playerPanel));
}

function header(snapshot: BroadcastSnapshot, match: MatchSnapshot): HTMLElement {
  const [left, right] = match.teams;
  const spike = match.spike === null ? "" : `Spike ${match.spike.status}`;

  return el(
    "div",
    "header",
    el("div", "", `${left.tricode} ${left.roundsWon} – ${right.roundsWon} ${right.tricode}`),
    el("div", "", `Round ${match.round.number}`),
    el("div", "", spike),
    el("div", "", `Series ${snapshot.series.wins[0]} – ${snapshot.series.wins[1]}`),
  );
}

export const liveMatchPage: Page = (snapshot) => {
  if (snapshot.match === null) {
    return title("Live Match");
  }

  const [left, right] = snapshot.match.teams;
  return el("div", "safe-area", header(snapshot, snapshot.match), teamPanels(left), teamPanels(right));
};

export const agentSelectPage: Page = () => title("Agent Select");

export const autoswitchPage: Page = (snapshot) =>
  snapshot.match !== null && snapshot.match.round.number === 0
    ? agentSelectPage(snapshot)
    : liveMatchPage(snapshot);

export const timeoutPage: Page = () => title("Timeout / Tech Pause");
