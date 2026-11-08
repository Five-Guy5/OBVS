import { randomBytes, randomUUID } from "node:crypto";

import {
  isSupportedIngestVersion,
  type IngestEvent,
  type IngestEventType,
} from "@obvs/protocol";

import { payloadError } from "./payload.js";
import { applyEvent, initialMatchState, replay, type MatchState } from "./state.js";

export interface ObserverInfo {
  name: string;
  clientVersion: string;
  connectedAt: string;
}

export type AppendResult = "appended" | "duplicate";

export type EventParseResult =
  | { ok: true; event: IngestEvent }
  | { ok: false; reason: string };

// `satisfies` keeps this list in step with the protocol catalog at compile time.
const INGEST_EVENT_TYPES = {
  "match.info": true,
  roster: true,
  round: true,
  score: true,
  spike: true,
  scoreboard: true,
  kill: true,
  observing: true,
  shop: true,
  "scoreboard.screen": true,
  scene: true,
  "match.end": true,
  manual: true,
  "gep.raw": true,
  frame: true,
} as const satisfies Record<IngestEventType, true>;

const MAX_EVENT_ID_LENGTH = 128;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Authoritative in-memory record for one group code's live Match. */
export class Match {
  readonly matchId = randomUUID();
  /** Issued once at creation and returned only in the accepting logon response (S.2.2). */
  readonly secret = randomBytes(32).toString("base64url");
  readonly createdAt = new Date().toISOString();

  readonly #events: IngestEvent[] = [];
  readonly #capturedAtMs: number[] = [];
  readonly #eventIds = new Set<string>();
  #connection: object | null = null;
  #lastActivityAtMs = Date.now();
  #state = initialMatchState();
  readonly #onChange: () => void;

  /** `onChange` runs after every appended event so Broadcast can push the change. */
  constructor(
    readonly groupCode: string,
    readonly observer: ObserverInfo,
    onChange: () => void = () => {},
  ) {
    this.#onChange = onChange;
  }

  /** Events in capture-timestamp order; ties keep arrival order. */
  get events(): readonly IngestEvent[] {
    return this.#events;
  }

  /** Authoritative state; always equal to replaying `events` from the start. */
  get state(): MatchState {
    return this.#state;
  }

  get isConnected(): boolean {
    return this.#connection !== null;
  }

  attach(connection: object): boolean {
    if (this.#connection !== null) {
      return false;
    }
    this.#connection = connection;
    this.#lastActivityAtMs = Date.now();
    return true;
  }

  detach(connection: object): void {
    if (this.#connection === connection) {
      this.#connection = null;
    }
  }

  isIdle(now: number, timeoutMs: number): boolean {
    return !this.isConnected && now - this.#lastActivityAtMs >= timeoutMs;
  }

  /** Idempotent on eventId, so client retries never double-apply (NF.3.2). */
  append(event: IngestEvent): AppendResult {
    this.#lastActivityAtMs = Date.now();

    if (this.#eventIds.has(event.eventId)) {
      return "duplicate";
    }

    const capturedAtMs = Date.parse(event.capturedAt);
    const index = this.#insertionIndex(capturedAtMs);
    // A late event lands mid-stream, so state is rebuilt to stay in capture order.
    // State is computed before the event is stored, so a throw leaves the Match intact.
    const state =
      index === this.#events.length
        ? applyEvent(this.#state, event)
        : replay([...this.#events.slice(0, index), event, ...this.#events.slice(index)]);

    this.#events.splice(index, 0, event);
    this.#capturedAtMs.splice(index, 0, capturedAtMs);
    this.#eventIds.add(event.eventId);
    this.#state = state;
    this.#onChange();

    return "appended";
  }

  /** First position whose capture time is later than `capturedAtMs`. */
  #insertionIndex(capturedAtMs: number): number {
    let low = 0;
    let high = this.#capturedAtMs.length;

    while (low < high) {
      const middle = (low + high) >>> 1;

      if (this.#capturedAtMs[middle]! <= capturedAtMs) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    return low;
  }
}

/** Check the event envelope and the payload fields Match state reads. */
export function parseIngestEvent(input: unknown): EventParseResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "Event must be a JSON object." };
  }

  const { protocolVersion, eventId, type, capturedAt, payload } = input as Record<
    string,
    unknown
  >;

  if (typeof protocolVersion !== "number" || !isSupportedIngestVersion(protocolVersion)) {
    return { ok: false, reason: "Unsupported protocol version." };
  }

  if (
    typeof eventId !== "string" ||
    eventId.length === 0 ||
    eventId.length > MAX_EVENT_ID_LENGTH
  ) {
    return { ok: false, reason: "Event id must be a 1-128 character string." };
  }

  if (typeof type !== "string" || !Object.hasOwn(INGEST_EVENT_TYPES, type)) {
    return { ok: false, reason: "Unknown event type." };
  }

  if (typeof capturedAt !== "string" ||
      !ISO_TIMESTAMP.test(capturedAt) ||
      Number.isNaN(Date.parse(capturedAt))) {
    return { ok: false, reason: "Capture timestamp must be an ISO 8601 string." };
  }

  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "Event payload must be an object." };
  }

  const payloadReason = payloadError(type as IngestEventType, payload as Record<string, unknown>);

  if (payloadReason !== null) {
    return { ok: false, reason: payloadReason };
  }

  return { ok: true, event: input as IngestEvent };
}
