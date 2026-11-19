import type {
  ArmorTier,
  IngestEventType,
  ManualAction,
  RoundPhase,
  SpikeAction,
  SpikeSite,
} from "@obvs/protocol";

// `satisfies` keeps each list in step with the protocol unions at compile time.
const ROUND_PHASES = {
  shopping: true,
  combat: true,
  end: true,
  game_end: true,
} as const satisfies Record<RoundPhase, true>;

const SPIKE_ACTIONS = {
  planted: true,
  defused: true,
  detonated: true,
} as const satisfies Record<SpikeAction, true>;

const SPIKE_SITES = { A: true, B: true, C: true } as const satisfies Record<SpikeSite, true>;

const ARMOR_TIERS = {
  none: true,
  light: true,
  heavy: true,
} as const satisfies Record<ArmorTier, true>;

const MANUAL_ACTIONS = {
  tech_pause_toggle: true,
  timeout_left: true,
  timeout_right: true,
  spike_planted: true,
} as const satisfies Record<ManualAction, true>;

type Values = Record<string, unknown>;

/**
 * Check the payload fields the reducer reads, so a malformed event is dropped at the
 * gate instead of corrupting Match state (S.1.2). Null means the payload is usable.
 */
export function payloadError(type: IngestEventType, payload: Values): string | null {
  switch (type) {
    case "match.info":
      return ["map", "gameMode", "matchId", "pseudoMatchId"].every((key) =>
        isOptionalText(payload[key]),
      )
        ? null
        : "match.info fields must be strings.";

    case "roster":
      return isListOf(payload.players, isRosterPlayer) ? null : "Roster players are malformed.";

    case "round":
      return isCount(payload.number) && isOneOf(ROUND_PHASES, payload.phase)
        ? null
        : "Round needs a whole-number round and a known phase.";

    case "score":
      return Array.isArray(payload.rounds) &&
        payload.rounds.length === 2 &&
        payload.rounds.every(isCount)
        ? null
        : "Score needs two whole-number round counts.";

    case "spike":
      return isOneOf(SPIKE_ACTIONS, payload.action) &&
        (payload.site === undefined || isOneOf(SPIKE_SITES, payload.site))
        ? null
        : "Spike needs a known action and site.";

    case "scoreboard":
      return isListOf(payload.players, isScoreboardPlayer)
        ? null
        : "Scoreboard players are malformed.";

    case "kill":
      return isId(payload.victimPuuid) ? null : "Kill needs a victim puuid.";

    case "observing":
      return isId(payload.puuid) ? null : "Observing needs a puuid.";

    case "manual":
      return isOneOf(MANUAL_ACTIONS, payload.action) ? null : "Unknown manual action.";

    case "match.end":
      return payload.winningTeamId === null || isTeamId(payload.winningTeamId)
        ? null
        : "Match end needs a team id or null.";

    // The reducer ignores these; the slices that consume them add their own checks.
    case "scene":
    case "shop":
    case "scoreboard.screen":
    case "gep.raw":
    case "frame":
      return null;
  }
}

function isRosterPlayer(value: Values): boolean {
  return (
    isId(value.puuid) &&
    typeof value.name === "string" &&
    typeof value.agent === "string" &&
    isTeamId(value.teamId) &&
    Number.isInteger(value.slot)
  );
}

function isScoreboardPlayer(value: Values): boolean {
  const ult = value.ult as Values | null | undefined;

  return (
    isId(value.puuid) &&
    typeof value.name === "string" &&
    typeof value.agent === "string" &&
    isTeamId(value.teamId) &&
    [value.kills, value.deaths, value.assists, value.money].every(isCount) &&
    typeof value.alive === "boolean" &&
    typeof value.spikeCarrier === "boolean" &&
    isOneOf(ARMOR_TIERS, value.armor) &&
    (value.primaryWeapon === null || typeof value.primaryWeapon === "string") &&
    typeof ult === "object" &&
    ult !== null &&
    isCount(ult.points) &&
    isCount(ult.max)
  );
}

function isListOf(value: unknown, isEntry: (entry: Values) => boolean): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "object" && entry !== null && isEntry(entry))
  );
}

function isOneOf(options: Record<string, true>, value: unknown): boolean {
  return typeof value === "string" && Object.hasOwn(options, value);
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** Empty puuids are reserved for placeholder players in the snapshot. */
function isId(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isTeamId(value: unknown): boolean {
  return value === 0 || value === 1;
}

function isCount(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}
