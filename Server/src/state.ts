import type {
  ArmorTier,
  FieldAvailabilityMap,
  IngestEvent,
  MatchField,
  PlayerField,
  PlayerKda,
  PlayerUlt,
  PlayerWeapon,
  RoundResult,
  RoundState,
  SpikeState,
  TeamId,
} from "@obvs/protocol";

export interface PlayerState {
  puuid: string;
  name: string;
  agent: string | null;
  teamId: TeamId;
  /** Spectator slot from the roster; null until a roster event names it. */
  slot: number | null;
  alive: boolean | null;
  armor: ArmorTier | null;
  weapon: PlayerWeapon | null;
  money: number | null;
  kda: PlayerKda | null;
  ult: PlayerUlt | null;
  spikeCarrier: boolean | null;
  availability: FieldAvailabilityMap<PlayerField>;
}

/** Authoritative Match state, derived only from ingest events. */
export interface MatchState {
  /** GEP's id for the game on this map; a new id means the next map started. */
  gameId: string | null;
  running: boolean;
  ended: boolean;
  winningTeamId: TeamId | null;
  map: string | null;
  gameMode: string | null;
  round: RoundState;
  spike: SpikeState | null;
  /** Indexed by TeamId. */
  roundsWon: [number, number];
  roundHistory: RoundResult[];
  /** Keyed by puuid. */
  players: Record<string, PlayerState>;
  observedPuuid: string | null;
  /** Capture time of the last observing event, for the `observed` field's availability. */
  observedAt: string | null;
  availability: FieldAvailabilityMap<MatchField>;
}

export function initialMatchState(): MatchState {
  return {
    gameId: null,
    running: false,
    ended: false,
    winningTeamId: null,
    map: null,
    gameMode: null,
    round: { number: 0, phase: "shopping" },
    spike: null,
    roundsWon: [0, 0],
    roundHistory: [],
    players: {},
    observedPuuid: null,
    observedAt: null,
    availability: {},
  };
}

/** Rebuild state from events already in capture-timestamp order. */
export function replay(events: readonly IngestEvent[]): MatchState {
  return events.reduce(applyEvent, initialMatchState());
}

/**
 * Pure reducer: the same state and event always give the same result, and the
 * input state is never mutated. Timestamps come from the event, not the clock.
 */
export function applyEvent(state: MatchState, event: IngestEvent): MatchState {
  const at = event.capturedAt;

  switch (event.type) {
    case "match.info": {
      const { map, gameMode } = event.payload;
      const gameId = event.payload.matchId ?? event.payload.pseudoMatchId ?? null;
      // One Observer session can span a series; a new game id starts the next map fresh.
      const nextMap = gameId !== null && state.gameId !== null && gameId !== state.gameId;
      const base = nextMap ? initialMatchState() : state;

      return {
        ...base,
        gameId: gameId ?? base.gameId,
        running: !base.ended,
        map: map ?? base.map,
        gameMode: gameMode ?? base.gameMode,
        availability: {
          ...base.availability,
          ...(map === undefined ? {} : { map: { source: "gep", updatedAt: at } }),
          ...(gameMode === undefined ? {} : { gameMode: { source: "gep", updatedAt: at } }),
        },
      };
    }

    case "roster": {
      const players = { ...state.players };

      for (const entry of event.payload.players) {
        const current = players[entry.puuid] ?? emptyPlayer(entry.puuid, entry.teamId);

        players[entry.puuid] = {
          ...current,
          name: entry.name,
          agent: entry.agent,
          teamId: entry.teamId,
          slot: entry.slot,
          availability: { ...current.availability, agent: { source: "gep", updatedAt: at } },
        };
      }

      return { ...state, players };
    }

    case "round": {
      const round = { number: event.payload.number, phase: event.payload.phase };
      const newRound = round.number !== state.round.number;

      return {
        ...state,
        running: !state.ended,
        round,
        // The spike belongs to one round; a new round starts without one.
        spike: newRound ? null : state.spike,
        availability: { ...state.availability, round: { source: "gep", updatedAt: at } },
      };
    }

    case "score": {
      const rounds = event.payload.rounds;
      const winner = singleRoundWinner(state.roundsWon, rounds);
      const roundHistory =
        winner === null
          ? state.roundHistory
          : [
              ...state.roundHistory,
              {
                roundNumber: state.round.number,
                winningTeamId: winner,
                reason: roundWinReason(state.spike),
                recordedAt: at,
              },
            ];

      return { ...state, roundsWon: [rounds[0], rounds[1]], roundHistory };
    }

    case "spike": {
      const { action, site } = event.payload;

      return {
        ...state,
        spike: { status: action, site: site ?? state.spike?.site ?? null },
        availability: { ...state.availability, spike: { source: "gep", updatedAt: at } },
      };
    }

    case "scoreboard": {
      const players = { ...state.players };
      const fields: PlayerField[] = [
        "agent",
        "alive",
        "armor",
        "weapon",
        "money",
        "kda",
        "ult",
        "spikeCarrier",
      ];

      for (const entry of event.payload.players) {
        const current = players[entry.puuid] ?? emptyPlayer(entry.puuid, entry.teamId);
        const availability = { ...current.availability };

        for (const field of fields) {
          availability[field] = { source: "gep", updatedAt: at };
        }

        players[entry.puuid] = {
          ...current,
          name: entry.name,
          agent: entry.agent,
          teamId: entry.teamId,
          alive: entry.alive,
          armor: entry.armor,
          weapon: {
            primary: entry.primaryWeapon,
            secondary: current.weapon?.secondary ?? null,
            equipped: current.weapon?.equipped ?? null,
          },
          money: entry.money,
          kda: { kills: entry.kills, deaths: entry.deaths, assists: entry.assists },
          ult: { points: entry.ult.points, max: entry.ult.max },
          spikeCarrier: entry.spikeCarrier,
          availability,
        };
      }

      return { ...state, players };
    }

    case "kill": {
      // KDA stays with the scoreboard, which already counts this kill.
      const victim = state.players[event.payload.victimPuuid];

      if (victim === undefined) {
        return state;
      }

      return {
        ...state,
        players: {
          ...state.players,
          [victim.puuid]: {
            ...victim,
            alive: false,
            availability: { ...victim.availability, alive: { source: "gep", updatedAt: at } },
          },
        },
      };
    }

    case "observing":
      return { ...state, observedPuuid: event.payload.puuid, observedAt: at };

    case "manual":
      if (event.payload.action === "spike_planted") {
        return {
          ...state,
          spike: { status: "planted", site: state.spike?.site ?? null },
          availability: { ...state.availability, spike: { source: "manual", updatedAt: at } },
        };
      }

      // Pause and timeout controls are not part of the snapshot yet.
      return state;

    case "match.end":
      return {
        ...state,
        running: false,
        ended: true,
        winningTeamId: event.payload.winningTeamId,
      };

    // Screen toggles, raw GEP, and frames carry nothing the snapshot shows yet.
    case "scene":
    case "shop":
    case "scoreboard.screen":
    case "gep.raw":
    case "frame":
      return state;
  }
}

function emptyPlayer(puuid: string, teamId: TeamId): PlayerState {
  return {
    puuid,
    name: "",
    agent: null,
    teamId,
    slot: null,
    alive: null,
    armor: null,
    weapon: null,
    money: null,
    kda: null,
    ult: null,
    spikeCarrier: null,
    availability: {},
  };
}

/** A round result is recorded only when exactly one team's score rises by one. */
function singleRoundWinner(
  previous: [number, number],
  next: [number, number],
): TeamId | null {
  const zeroWon = next[0] === previous[0] + 1 && next[1] === previous[1];
  const oneWon = next[1] === previous[1] + 1 && next[0] === previous[0];

  if (zeroWon) {
    return 0;
  }

  return oneWon ? 1 : null;
}

function roundWinReason(spike: SpikeState | null): RoundResult["reason"] {
  if (spike?.status === "detonated" || spike?.status === "defused") {
    return spike.status;
  }

  // Elimination and timeout cannot be told apart from the current event catalog.
  return "unknown";
}
