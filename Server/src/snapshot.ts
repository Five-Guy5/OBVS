import {
  PROTOCOL_VERSION,
  type BroadcastSnapshot,
  type CapabilityAdvertisement,
  type MatchSnapshot,
  type MatchThresholds,
  type PlayerSnapshot,
  type PlayerTuple,
  type ProductionConfig,
  type SeriesFormat,
  type SeriesState,
  type TeamId,
  type TeamSide,
  type TeamSnapshot,
} from "@obvs/protocol";

import type { MatchState, PlayerState } from "./state.js";

export interface SeriesResult {
  /** One entry per map; see `seriesKey`. */
  key: string;
  map: string;
  winningTeamId: TeamId | null;
}

export interface SnapshotInput {
  groupCode: string;
  /** Null while no Match is live for the group. */
  match: { matchId: string; state: MatchState } | null;
  seriesId: string;
  /** Finished Matches, oldest first; survives Match removal (S.4, ADR-0009). */
  seriesResults: readonly SeriesResult[];
  production: ProductionConfig;
  capabilities: CapabilityAdvertisement;
}

/** Everything but the per-push fields, so unchanged state can be detected. */
export type SnapshotContent = Omit<BroadcastSnapshot, "sequence" | "generatedAt">;

// Standard-mode values; other modes get their own entry once their GEP mode names are confirmed.
const DEFAULT_THRESHOLDS: MatchThresholds = { switchAfterRound: 12, overtimeFromRound: 25 };

const WINS_NEEDED: Record<SeriesFormat, number> = { BO1: 1, BO3: 2, BO5: 3 };

const TEAM_SIZE = 5;

/**
 * Build the snapshot body field by field from state and config. Nothing is spread
 * from the Match, so the Match Secret, auth key, and Observer details never reach it.
 */
export function buildSnapshotContent(input: SnapshotInput): SnapshotContent {
  const production = withoutCredentials(input.production);
  const live = input.match;

  return {
    protocolVersion: PROTOCOL_VERSION,
    groupCode: input.groupCode,
    matchId: live?.matchId ?? null,
    match: live === null ? null : buildMatch(live.state, production),
    series: buildSeries(input, production.seriesFormat),
    production,
    capabilities: structuredClone(input.capabilities),
  };
}

function buildMatch(state: MatchState, production: ProductionConfig): MatchSnapshot {
  const thresholds = { ...DEFAULT_THRESHOLDS };

  return {
    running: state.running,
    map: state.map,
    gameMode: state.gameMode,
    round: { ...state.round },
    spike: state.spike === null ? null : { ...state.spike },
    thresholds,
    teams: [
      buildTeam(0, state, production, thresholds),
      buildTeam(1, state, production, thresholds),
    ],
    availability: structuredClone(state.availability),
  };
}

function buildTeam(
  teamId: TeamId,
  state: MatchState,
  production: ProductionConfig,
  thresholds: MatchThresholds,
): TeamSnapshot {
  const config = production.teams[teamId];

  return {
    teamId,
    name: config.name,
    tricode: config.tricode,
    logoUrl: config.logoUrl,
    side: sideFor(config.startingSide, state.round.number, thresholds),
    roundsWon: state.roundsWon[teamId],
    roundHistory: structuredClone(state.roundHistory),
    // Spend needs per-round buy tracking the event catalog does not provide yet.
    roundSpend: null,
    players: buildPlayers(teamId, state, production.playerNameOverrides),
  };
}

/**
 * A Match can span several maps. A map is identified by its GEP game id, which
 * survives Match removal; the Match id is only a provisional key until it arrives.
 */
export function seriesKey(matchId: string, state: MatchState): string {
  return state.gameId ?? matchId;
}

/** Sides swap after the first half; in overtime they alternate every round. */
export function sideFor(
  startingSide: TeamSide,
  roundNumber: number,
  thresholds: MatchThresholds,
): TeamSide {
  const { switchAfterRound, overtimeFromRound } = thresholds;
  let swapped = roundNumber > switchAfterRound;

  if (overtimeFromRound !== null && roundNumber >= overtimeFromRound) {
    swapped = (roundNumber - overtimeFromRound) % 2 === 1;
  }

  if (!swapped) {
    return startingSide;
  }

  return startingSide === "attack" ? "defense" : "attack";
}

/** Always five players per team, ordered by spectator slot; empty slots are placeholders. */
function buildPlayers(
  teamId: TeamId,
  state: MatchState,
  nameOverrides: Record<string, string>,
): PlayerTuple {
  const players = Object.values(state.players)
    .filter((player) => player.teamId === teamId)
    .sort(
      (left, right) =>
        (left.slot ?? Number.MAX_SAFE_INTEGER) - (right.slot ?? Number.MAX_SAFE_INTEGER) ||
        left.puuid.localeCompare(right.puuid),
    )
    .slice(0, TEAM_SIZE)
    .map((player) => buildPlayer(player, state, nameOverrides));

  while (players.length < TEAM_SIZE) {
    players.push(placeholderPlayer());
  }

  return players as PlayerTuple;
}

function buildPlayer(
  player: PlayerState,
  state: MatchState,
  nameOverrides: Record<string, string>,
): PlayerSnapshot {
  const { observedPuuid, observedAt } = state;
  const availability = structuredClone(player.availability);

  if (observedAt !== null) {
    availability.observed = { source: "gep", updatedAt: observedAt };
  }

  return {
    puuid: player.puuid,
    name: Object.hasOwn(nameOverrides, player.puuid) ? nameOverrides[player.puuid]! : player.name,
    agent: player.agent,
    alive: player.alive,
    // Health, shield, abilities, and resources arrive with the CV pipeline (V.2).
    health: null,
    shield: null,
    armor: player.armor,
    weapon: player.weapon === null ? null : { ...player.weapon },
    money: player.money,
    kda: player.kda === null ? null : { ...player.kda },
    ult: player.ult === null ? null : { ...player.ult },
    spikeCarrier: player.spikeCarrier,
    observed: observedPuuid === null ? null : observedPuuid === player.puuid,
    abilities: null,
    resources: null,
    availability,
  };
}

function placeholderPlayer(): PlayerSnapshot {
  return {
    puuid: "",
    name: "",
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
  };
}

function buildSeries(input: SnapshotInput, format: SeriesFormat): SeriesState {
  const maps = input.seriesResults.map(({ map, winningTeamId }) => ({ map, winningTeamId }));
  const live = input.match;
  const liveKey = live === null ? null : seriesKey(live.matchId, live.state);
  const liveRecorded = input.seriesResults.some((result) => result.key === liveKey);

  // The map being played shows as undecided until its Match ends.
  if (live !== null && !liveRecorded && live.state.map !== null) {
    maps.push({ map: live.state.map, winningTeamId: null });
  }

  const wins: [number, number] = [0, 0];

  for (const { winningTeamId } of maps) {
    if (winningTeamId !== null) {
      wins[winningTeamId] += 1;
    }
  }

  return {
    seriesId: input.seriesId,
    wins,
    maps,
    decided: Math.max(...wins) >= WINS_NEEDED[format],
  };
}

/** Admin-entered URLs may embed basic-auth credentials; never broadcast them. */
function withoutCredentials(production: ProductionConfig): ProductionConfig {
  const copy = structuredClone(production);

  copy.tournament.logoUrl = stripNullableUrl(copy.tournament.logoUrl);
  copy.tournament.backdropUrl = stripNullableUrl(copy.tournament.backdropUrl);

  for (const team of copy.teams) {
    team.logoUrl = stripNullableUrl(team.logoUrl);
  }

  for (const sponsor of copy.sponsors) {
    sponsor.logoUrl = stripUrlCredentials(sponsor.logoUrl);
  }

  return copy;
}

function stripNullableUrl(url: string | null): string | null {
  return url === null ? null : stripUrlCredentials(url);
}

export function stripUrlCredentials(url: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (parsed.username === "" && parsed.password === "") {
    return url;
  }

  parsed.username = "";
  parsed.password = "";

  return parsed.toString();
}
