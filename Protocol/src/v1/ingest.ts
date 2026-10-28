import type {
  ArmorTier,
  CapabilityAdvertisement,
  PlayerKda,
  PlayerUlt,
  RoundState,
  SpikeSite,
  SpikeStatus,
  TeamId,
  V1ProtocolVersion,
} from "./common.js";

/** Typed ingest catalog (C.1, S.1.2, S.2, V.4). */
export type IngestEventType =
  | "match.info"
  | "roster"
  | "round"
  | "score"
  | "spike"
  | "scoreboard"
  | "kill"
  | "observing"
  | "shop"
  | "scoreboard.screen"
  | "scene"
  | "match.end"
  | "manual"
  | "gep.raw"
  | "frame";

export interface MatchInfoPayload {
  matchId?: string;
  pseudoMatchId?: string;
  /** Riot map codename; unknown codenames pass through (BR-09). */
  map?: string;
  gameMode?: string;
  isPbe?: boolean;
  isCustom?: boolean;
  isRanked?: boolean;
  startedAt?: string;
}

export interface RosterPlayer {
  puuid: string;
  /** Display name with tagline. */
  name: string;
  agent: string;
  rankedTier?: number;
  locked?: boolean;
  isLocal?: boolean;
  isTeammate?: boolean;
  teamId: TeamId;
  /** Spectator slot, 1-10. */
  slot: number;
}

export interface RosterPayload {
  players: RosterPlayer[];
}

export type RoundPayload = RoundState;

export interface ScorePayload {
  /** Rounds won, indexed by TeamId. */
  rounds: [number, number];
}

export type SpikeAction = Exclude<SpikeStatus, "carried">;

export interface SpikePayload {
  action: SpikeAction;
  site?: SpikeSite;
}

export interface ScoreboardPlayer extends PlayerKda {
  puuid: string;
  name: string;
  agent: string;
  teamId: TeamId;
  money: number;
  alive: boolean;
  armor: ArmorTier;
  primaryWeapon: string | null;
  spikeCarrier: boolean;
  ult: PlayerUlt;
}

export interface ScoreboardPayload {
  players: ScoreboardPlayer[];
}

/** GEP kill feed carries at most four assists. */
export type AssistPuids =
  | []
  | [string]
  | [string, string]
  | [string, string, string]
  | [string, string, string, string];

export interface KillPayload {
  attackerPuuid: string | null;
  victimPuuid: string;
  weapon: string;
  isAbility: boolean;
  isUltimate: boolean;
  headshot: boolean;
  assistantPuids: AssistPuids;
}

export interface ObservingPayload {
  puuid: string;
}

export interface ShopPayload {
  open: boolean;
}

export interface ScoreboardScreenPayload {
  open: boolean;
}

export type Scene = "main_menu" | "agent_select" | "practice_range" | "in_game";

export interface ScenePayload {
  scene: Scene;
}

export interface MatchEndPayload {
  winningTeamId: TeamId | null;
}

export type ManualAction =
  | "tech_pause_toggle"
  | "timeout_left"
  | "timeout_right"
  | "spike_planted";

export interface ManualPayload {
  action: ManualAction;
}

/** Raw GEP pass-through (ADR-0006). */
export interface RawGepPayload {
  feature: string;
  key: string;
  value: unknown;
  timestamp: string;
}

/** Single captured frame for the optional CV pipeline (V.4). */
export interface FramePayload {
  frameId: string;
  /** POV player identity for this frame. */
  povPuuid: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  /** Encoded image bytes, base64. */
  data: string;
}

export interface IngestPayloads {
  "match.info": MatchInfoPayload;
  roster: RosterPayload;
  round: RoundPayload;
  score: ScorePayload;
  spike: SpikePayload;
  scoreboard: ScoreboardPayload;
  kill: KillPayload;
  observing: ObservingPayload;
  shop: ShopPayload;
  "scoreboard.screen": ScoreboardScreenPayload;
  scene: ScenePayload;
  "match.end": MatchEndPayload;
  manual: ManualPayload;
  "gep.raw": RawGepPayload;
  frame: FramePayload;
}

/** Every ingest event carries an idempotent id and its capture timestamp (S.1.2, NF.3.2). */
export type IngestEvent = {
  [TType in IngestEventType]: {
    protocolVersion: V1ProtocolVersion;
    eventId: string;
    type: TType;
    /** ISO 8601 capture time; server applies events in this order. */
    capturedAt: string;
    payload: IngestPayloads[TType];
  };
}[IngestEventType];

/** First logon and resume logon (S.2.1). */
export interface LogonRequest {
  /** Untrusted on arrival; the server gate validates it (NF.9.1). */
  protocolVersion: number;
  groupCode: string;
  observerName: string;
  clientVersion: string;
  /** Null means open ingest; a value must match the server's auth key. */
  authKey: string | null;
  /** Present only when resuming a live Match (C.3.3, S.2.3). */
  matchSecret?: string;
}

/** Logon acknowledgement (S.2.2). */
export type LogonResponse =
  | {
      accepted: true;
      matchSecret: string;
      capabilities: CapabilityAdvertisement;
    }
  | {
      accepted: false;
      reason: string;
    };
