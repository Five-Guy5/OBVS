import type {
  ArmorTier,
  CapabilityAdvertisement,
  FieldAvailabilityMap,
  MatchField,
  PlayerField,
  PlayerKda,
  PlayerUlt,
  ProductionConfig,
  RoundResult,
  RoundState,
  SeriesState,
  SpikeSite,
  SpikeStatus,
  TeamId,
  TeamIdentity,
  TeamSide,
  V1ProtocolVersion,
} from "./common.js";

export interface PlayerWeapon {
  primary: string | null;
  secondary: string | null;
  equipped: string | null;
}

export interface AbilityCharge {
  slot: "C" | "Q" | "E" | "X";
  charges: number | null;
}

/** Agent-specific meter such as Viper fuel or Neon energy (V.2.4). */
export interface AgentResource {
  name: string;
  /** Level/state, not an exact cooldown. */
  value: number | null;
}

export interface PlayerSnapshot {
  puuid: string;
  name: string;
  agent: string | null;
  alive: boolean | null;
  health: number | null;
  shield: number | null;
  armor: ArmorTier | null;
  weapon: PlayerWeapon | null;
  money: number | null;
  kda: PlayerKda | null;
  ult: PlayerUlt | null;
  spikeCarrier: boolean | null;
  observed: boolean | null;
  abilities: AbilityCharge[] | null;
  resources: AgentResource[] | null;
  availability: FieldAvailabilityMap<PlayerField>;
}

export type PlayerTuple = [
  PlayerSnapshot,
  PlayerSnapshot,
  PlayerSnapshot,
  PlayerSnapshot,
  PlayerSnapshot,
];

export interface TeamSnapshot extends TeamIdentity {
  teamId: TeamId;
  side: TeamSide;
  roundsWon: number;
  roundHistory: RoundResult[];
  roundSpend: number | null;
  players: PlayerTuple;
}

export type TeamTuple = [TeamSnapshot, TeamSnapshot];

export interface SpikeState {
  status: SpikeStatus;
  site: SpikeSite | null;
}

export interface MatchThresholds {
  switchAfterRound: number;
  /** Null when the mode has no overtime. */
  overtimeFromRound: number | null;
}

export interface MatchSnapshot {
  running: boolean;
  map: string | null;
  gameMode: string | null;
  round: RoundState;
  spike: SpikeState | null;
  thresholds: MatchThresholds;
  teams: TeamTuple;
  availability: FieldAvailabilityMap<MatchField>;
}

/** Full-state push to every subscribed frontend on change (S.3, ADR-0007). */
export interface BroadcastSnapshot {
  protocolVersion: V1ProtocolVersion;
  /** Monotonic while matchId stays the same; a new Match restarts it. */
  sequence: number;
  generatedAt: string;
  groupCode: string;
  /** Stable id of the live Match; null while idle. */
  matchId: string | null;
  /** Null while no Match is live; pages render placeholders (F.3). */
  match: MatchSnapshot | null;
  /** Survives Match removal (S.4, ADR-0009). */
  series: SeriesState;
  production: ProductionConfig;
  capabilities: CapabilityAdvertisement;
}
