/**
 * Protocol v1 primitives shared by ingest events and broadcast snapshots.
 * Change a wire shape here, never in a deployable (ADR-0002).
 */

export const V1_PROTOCOL_VERSION = 1 as const;
export type V1ProtocolVersion = typeof V1_PROTOCOL_VERSION;

export type TeamId = 0 | 1;
export type TeamSide = "attack" | "defense";
export type RoundPhase = "shopping" | "combat" | "end" | "game_end";
export type ArmorTier = "none" | "light" | "heavy";
export type DataSource = "gep" | "cv" | "manual";
export type SpikeSite = "A" | "B" | "C";
export type SpikeStatus = "carried" | "planted" | "defused" | "detonated";

export interface RoundState {
  number: number;
  phase: RoundPhase;
}

export interface PlayerKda {
  kills: number;
  deaths: number;
  assists: number;
}

export interface PlayerUlt {
  points: number;
  max: number;
}

/** Per-field availability so frontends can render placeholders (S.3, F.3). */
export interface FieldAvailability {
  source: DataSource;
  updatedAt: string;
}

export type FieldAvailabilityMap<TField extends string> = Partial<
  Record<TField, FieldAvailability>
>;

export type PlayerField =
  | "agent"
  | "alive"
  | "health"
  | "shield"
  | "armor"
  | "weapon"
  | "money"
  | "kda"
  | "ult"
  | "spikeCarrier"
  | "observed"
  | "abilities"
  | "resources";

export type MatchField = "map" | "gameMode" | "round" | "spike";

export type SeriesFormat = "BO1" | "BO3" | "BO5";

export type RoundWinReason =
  | "detonated"
  | "defused"
  | "timeout"
  | "elimination"
  | "unknown";

export interface RoundResult {
  roundNumber: number;
  /** Null records a draw. */
  winningTeamId: TeamId | null;
  reason: RoundWinReason;
  recordedAt: string;
}

export interface SeriesState {
  seriesId: string;
  /** Indexed by TeamId. */
  wins: [number, number];
  maps: Array<{ map: string; winningTeamId: TeamId | null }>;
  decided: boolean;
}

export interface TeamIdentity {
  name: string;
  tricode: string;
  logoUrl: string | null;
}

export interface TeamConfig extends TeamIdentity {
  startingSide: TeamSide;
}

export interface Sponsor {
  name: string;
  logoUrl: string;
  durationMs: number;
}

export interface ToastPreset {
  id: string;
  text: string;
}

/** Admin-edited production config carried in every snapshot (S.3, S.5.1, F.4). */
export interface ProductionConfig {
  tournament: {
    name: string;
    logoUrl: string | null;
    backdropUrl: string | null;
  };
  /** Indexed by TeamId. */
  teams: [TeamConfig, TeamConfig];
  seriesFormat: SeriesFormat;
  timeout: {
    durationMs: number;
    countsPerTeam: number;
  };
  sponsors: Sponsor[];
  watermark: {
    text: string;
    enabled: boolean;
  };
  /** Keyed by player puuid. */
  playerNameOverrides: Record<string, string>;
  toasts: ToastPreset[];
}

/** GEP is the base source; CV only fills GEP gaps (V.1.1, ADR-0008). */
export interface CapabilityAdvertisement {
  gep: boolean;
  cv: {
    enabled: boolean;
    modelsLoaded: boolean;
  };
  /** Field -> source, so frontends can degrade field by field. */
  fields: Partial<Record<PlayerField | MatchField, DataSource>>;
}
