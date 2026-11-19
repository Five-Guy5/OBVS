import { randomUUID } from 'node:crypto';
import type {
  IngestEvent,
  IngestEventType,
  IngestPayloads,
  LogonRequest,
  LogonResponse,
  ManualAction,
  RoundPhase,
  Scene,
} from '@obvs/protocol';
import type { OutboxStore, StoredOutbox } from './outbox';
import { isLoopbackHost } from './settings';

// The Electron main runs as CommonJS and @obvs/protocol ships ESM-only, so the
// numeric wire version is mirrored here; all event and logon shapes are imported.
const PROTOCOL_VERSION = 1 as IngestEvent['protocolVersion'];
const OPEN = 1;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
const MAX_OUTBOX_EVENTS = 10_000;
const MAX_OUTBOX_AGE_MS = 10 * 60_000;
// The logon response has no machine-readable rejection code; the Server's
// wording is the only signal that the Match cannot be resumed.
const MATCH_SECRET_REJECTION = 'Match Secret rejected or missing.';
const OTHER_OBSERVER_REJECTION = 'Another Observer is already logged on for this group code.';
// A half-open old socket can hold the Match for up to two heartbeats; retry
// long enough to cover that, then accept that another Observer took over.
const MAX_RESUME_REJECTIONS = 10;

export type SessionState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'stopping';

export interface SessionStatus {
  state: SessionState;
  error: string | null;
  warning: string | null;
}

export interface SessionConfig {
  serverUrl: string;
  groupCode: string;
  displayName: string;
  authKey: string;
}

export interface GepUpdate {
  feature: string;
  key: string;
  value: unknown;
  /** Native GEP payloads may carry `data` instead of `value`. */
  data?: unknown;
}

export interface SocketLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: any) => void): void;
  send(data: string): void;
  close(): void;
}

export interface SessionOptions {
  clientVersion: string;
  allowInsecure: boolean;
  createSocket: (url: string) => SocketLike;
  onChange?: (status: SessionStatus) => void;
  outbox?: OutboxStore;
}

/**
 * Owns the Client-side match session: GEP triggers, logon, event relay, and
 * manual Connect/Disconnect. The outbox keeps the latest 10 minutes / 10,000
 * events of the Match, so a reconnect re-sends them and the Server drops them
 * by event ID.
 */
export class Session {
  readonly #options: SessionOptions;
  #config: SessionConfig | null = null;
  #state: SessionState = 'idle';
  #error: string | null = null;
  #warning: string | null = null;
  #socket: SocketLike | null = null;
  #matchSecret: string | null = null;
  #outbox: IngestEvent[] = [];
  #outboxIds = new Set<string>();
  #sentIds = new Set<string>();
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempt = 0;
  #suppressAuto = false;
  #auto = false;
  #autoPending = false;
  #lastScene: Scene | null = null;
  #roundNumber: number | null = null;
  #roundPhase: RoundPhase | null = null;
  #ended = false;

  constructor(options: SessionOptions) {
    this.#options = options;
  }

  get status(): SessionStatus {
    return { state: this.#state, error: this.#error, warning: this.#warning };
  }

  setConfig(config: SessionConfig | null): void {
    const previous = this.#config;
    this.#config = config;

    // A different server or group code cannot resume the old Match.
    if (previous && (!config || previous.serverUrl !== config.serverUrl ||
        previous.groupCode !== config.groupCode)) {
      if (this.#matchSecret !== null || this.#outbox.length > 0) {
        if (this.#state === 'idle') {
          this.#discardSession();
          this.#update('idle', null);
        } else {
          this.#stop();
        }
      }
    }

    // Settings may load after GEP already reported agent select/match start.
    if (config && this.#autoPending && this.#state === 'idle' && !this.#suppressAuto) {
      this.#startConnect(false);
    }
  }

  /** Load the secret and event log saved by a previous process. */
  restore(stored: StoredOutbox | null): boolean {
    if (!stored || this.#state !== 'idle') return false;
    const config = this.#config;
    if (!config) return false;

    // A secret belongs to one server and group code; never replay it elsewhere.
    if (stored.serverUrl !== config.serverUrl || stored.groupCode !== config.groupCode) {
      this.#options.outbox?.clear();
      return false;
    }

    this.#matchSecret = stored.matchSecret;
    for (const event of stored.events) this.#addToOutbox(event, false);
    this.#pruneOutbox();
    this.#persist();
    return true;
  }

  /** Resume a restored live Match without waiting for another GEP trigger. */
  resume(): void {
    if (this.#state !== 'idle' || this.#matchSecret === null) return;
    this.#suppressAuto = false;
    this.#auto = true;
    this.#autoPending = this.#config === null;
    if (this.#config === null) {
      this.#update('idle', 'Save connection settings before connecting.');
      return;
    }
    this.#startConnect(false);
  }

  /** Manual Connect: keep any stored Match Secret so a mid-match reconnect resumes. */
  connect(): void {
    if (this.#state !== 'idle') return;
    this.#suppressAuto = false;
    this.#auto = false;
    this.#autoPending = false;
    this.#startConnect(false);
  }

  /** Manual Disconnect: suppress automatic triggers until the next match begins. */
  disconnect(): void {
    this.#suppressAuto = true;
    this.#auto = false;
    this.#autoPending = false;
    this.#clearReconnectTimer();
    this.#reconnectAttempt = 0;
    if (this.#state === 'idle') {
      this.#update('idle', null);
      return;
    }
    if (this.#state === 'connecting' || this.#state === 'live' ||
        this.#state === 'reconnecting') {
      this.#update('stopping', null);
      if (this.#socket === null) {
        this.#update('idle', null);
        return;
      }
      this.#socket.close();
    }
  }

  /** Emit a manual ingest event; the result says whether it reached the socket. */
  emitManual(action: ManualAction): 'sent' | 'queued' | 'none' {
    if (!this.#isActive()) return 'none';
    const event = makeEvent('manual', { action });
    this.#addToOutbox(event);
    if (this.#state === 'live') this.#drain();
    return this.#sentIds.has(event.eventId) ? 'sent' : 'queued';
  }

  handleInfo(update: GepUpdate): void {
    // Only substitute when `value` is entirely absent; null is a real payload
    // (e.g., match_start, spike_defused/detonated fire with no data).
    const value = update.value === undefined ? update.data : update.value;
    this.#handleGep('info', update.feature, update.key, value);
  }

  handleEvent(update: GepUpdate): void {
    const value = update.value === undefined ? update.data : update.value;
    this.#handleGep('event', update.feature, update.key, value);
  }

  #startConnect(reconnecting: boolean): void {
    if (this.#state !== 'idle' && this.#state !== 'reconnecting') return;

    const config = this.#config;
    if (!config) {
      this.#clearReconnectTimer();
      this.#update('idle', 'Save connection settings before connecting.');
      return;
    }

    let url: string;
    try {
      url = toWebSocketUrl(config.serverUrl, this.#options.allowInsecure);
    } catch (error) {
      this.#clearReconnectTimer();
      this.#update('idle', error instanceof Error
        ? error.message
        : 'The server URL is not valid.');
      return;
    }

    this.#ended = false;
    this.#sentIds.clear();
    if (!reconnecting) this.#update('connecting', null);

    let socket: SocketLike;
    try {
      socket = this.#options.createSocket(url);
    } catch {
      this.#connectionFailed('Could not connect to the server.');
      return;
    }

    this.#socket = socket;
    const logon: LogonRequest = {
      protocolVersion: PROTOCOL_VERSION,
      groupCode: config.groupCode,
      observerName: config.displayName,
      clientVersion: this.#options.clientVersion,
      authKey: config.authKey.length > 0 ? config.authKey : null,
    };
    if (this.#matchSecret !== null) logon.matchSecret = this.#matchSecret;

    socket.addEventListener('open', () => {
      if (this.#socket !== socket) return;
      if (this.#state !== 'connecting' && this.#state !== 'reconnecting') return;
      try {
        socket.send(JSON.stringify(logon));
      } catch {
        this.#connectionFailed('Could not send the logon request.');
      }
    });

    socket.addEventListener('message', (event: { data?: unknown }) => {
      if (this.#socket !== socket) return;
      if (this.#state !== 'connecting' && this.#state !== 'reconnecting') return;
      const response = parseLogonResponse(event.data);
      if (!response) {
        this.#fail('The server sent an invalid logon response.');
        return;
      }
      if (!response.accepted) {
        this.#rejected(response.reason);
        return;
      }
      this.#matchSecret = response.matchSecret;
      this.#sentIds.clear();
      this.#reconnectAttempt = 0;
      this.#clearReconnectTimer();
      this.#update('live', null);
      this.#persist();
      this.#drain();
    });

    socket.addEventListener('error', () => {
      if (this.#socket !== socket) return;
      this.#connectionFailed(this.#state === 'connecting'
        ? 'Could not connect to the server.'
        : 'Connection lost.');
    });

    socket.addEventListener('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#sentIds.clear();
      if (this.#state === 'stopping') {
        this.#update('idle', null);
      } else if (this.#state === 'connecting' || this.#state === 'reconnecting') {
        this.#connectionFailed('The server closed the connection during logon.');
      } else if (this.#state === 'live') {
        this.#connectionFailed('Connection lost.');
      }
    });
  }

  #connectionFailed(message: string): void {
    const socket = this.#detachSocket();
    socket?.close();

    if (this.#state === 'idle') return;
    if (this.#state === 'stopping') {
      this.#update('idle', null);
      return;
    }

    if (this.#matchSecret !== null || this.#auto || this.#state === 'reconnecting') {
      this.#update('reconnecting', message);
      this.#scheduleReconnect();
      return;
    }

    this.#update('idle', message);
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null) return;
    const delay = Math.min(
      RECONNECT_INITIAL_MS * 2 ** this.#reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#state !== 'reconnecting') return;
      this.#startConnect(true);
    }, delay);
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === null) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #handleGep(kind: 'info' | 'event', feature: string, key: string, value: unknown): void {
    const capturedAt = new Date().toISOString();
    const scene = feature === 'game_info' && key === 'scene' ? toScene(value) : null;
    const phase = feature === 'match_info' && key === 'round_phase' ? toRoundPhase(value) : null;
    const roundNumber = feature === 'match_info' && key === 'round_number'
      ? toRoundNumber(value)
      : null;
    let ending = false;

    if (scene !== null) this.#onScene(scene);
    if (roundNumber !== null) {
      // The previous round's phase is stale once the round number changes.
      if (roundNumber !== this.#roundNumber) this.#roundPhase = null;
      this.#roundNumber = roundNumber;
    }
    if (phase !== null) {
      this.#roundPhase = phase;
      if (phase === 'game_end') ending = true;
    }
    if (kind === 'event' && feature === 'match_info' && key === 'match_start') {
      this.#onMatchStart();
    }
    if (kind === 'event' && feature === 'match_info' && key === 'match_end') {
      ending = true;
    }

    if (this.#isActive()) {
      this.#relay(makeEvent('gep.raw', {
        feature,
        key,
        value,
        timestamp: capturedAt,
      }, capturedAt));

      if (scene !== null) {
        this.#relay(makeEvent('scene', { scene }, capturedAt));
      }
      if (feature === 'match_info' && (
        (key === 'round_number' && roundNumber !== null) ||
        (key === 'round_phase' && phase !== null)
      )) {
        this.#emitRound(capturedAt);
      }
      if (ending && !this.#ended) {
        this.#ended = true;
        this.#relay(makeEvent('match.end', { winningTeamId: null }, capturedAt));
      }
    }

    if (ending) this.#stop();
  }

  #onScene(scene: Scene): void {
    const previous = this.#lastScene;
    this.#lastScene = scene;

    if (scene === 'main_menu' || scene === 'practice_range') {
      this.#suppressAuto = false;
      this.#autoPending = false;
      const wasAuto = this.#auto;
      this.#auto = false;
      if (wasAuto && this.#isActive()) {
        this.#stop();
      }
      return;
    }
    if (this.#state !== 'idle' || this.#suppressAuto) return;

    const newMatch = previous === null ||
      previous === 'main_menu' ||
      previous === 'practice_range';
    if (newMatch) {
      // Keep a restored secret when the app restarts in-game; a menu/range
      // transition, or a fresh session with no secret, discards the old log.
      if (previous !== null || this.#matchSecret === null) {
        this.#discardSession();
      }
      this.#roundNumber = null;
      this.#roundPhase = null;
    }
    this.#auto = true;
    this.#autoPending = true;
    this.#startConnect(false);
  }

  #onMatchStart(): void {
    if (this.#state !== 'idle' || this.#suppressAuto) return;
    if (this.#lastScene === 'main_menu' || this.#lastScene === 'practice_range') return;
    if (this.#matchSecret === null) this.#discardSession();
    this.#roundNumber = null;
    this.#roundPhase = null;
    this.#auto = true;
    this.#autoPending = true;
    this.#startConnect(false);
  }

  #emitRound(capturedAt: string): void {
    if (this.#roundNumber === null || this.#roundPhase === null) return;
    this.#relay(makeEvent('round', {
      number: this.#roundNumber,
      phase: this.#roundPhase,
    }, capturedAt));
  }

  #relay(event: IngestEvent): void {
    if (!this.#isActive()) return;
    this.#addToOutbox(event);
    if (this.#state === 'live') this.#drain();
  }

  #addToOutbox(event: IngestEvent, persist = true): void {
    if (this.#outboxIds.has(event.eventId)) return;
    this.#outboxIds.add(event.eventId);
    this.#outbox.push(event);
    this.#pruneOutbox();
    if (persist) this.#persist();
  }

  #pruneOutbox(): void {
    const cutoff = Date.now() - MAX_OUTBOX_AGE_MS;
    let dropped = 0;

    while (dropped < this.#outbox.length) {
      const event = this.#outbox[dropped]!;
      if (this.#outbox.length - dropped <= MAX_OUTBOX_EVENTS &&
          Date.parse(event.capturedAt) >= cutoff) {
        break;
      }
      dropped += 1;
    }

    if (dropped > 0) {
      for (const event of this.#outbox.splice(0, dropped)) {
        this.#outboxIds.delete(event.eventId);
        this.#sentIds.delete(event.eventId);
      }
      this.#setWarning('Event buffer limit reached; the oldest events were dropped.');
    }
  }

  #drain(): void {
    if (this.#state !== 'live' || this.#socket?.readyState !== OPEN) return;
    this.#pruneOutbox();

    for (const event of this.#outbox) {
      if (this.#sentIds.has(event.eventId)) continue;
      try {
        this.#socket.send(JSON.stringify(event));
        this.#sentIds.add(event.eventId);
      } catch {
        this.#connectionFailed('Could not send an event to the server.');
        return;
      }
    }
  }

  #stop(): void {
    this.#ended = true;
    this.#discardSession();
    this.#suppressAuto = false;
    this.#auto = false;
    this.#autoPending = false;
    this.#roundNumber = null;
    this.#roundPhase = null;

    if (this.#state === 'idle' || this.#socket === null) {
      this.#update('idle', null);
      return;
    }
    this.#update('stopping', null);
    this.#socket.close();
  }

  #rejected(reason: string): void {
    this.#clearReconnectTimer();
    const socket = this.#detachSocket();
    this.#autoPending = false;

    // While resuming, the Server may still see our half-open socket from
    // before the outage. Retry until its heartbeat clears it.
    if (this.#matchSecret !== null &&
        reason === OTHER_OBSERVER_REJECTION &&
        this.#reconnectAttempt <= MAX_RESUME_REJECTIONS) {
      this.#update('reconnecting', reason);
      this.#scheduleReconnect();
      socket?.close();
      return;
    }

    this.#reconnectAttempt = 0;

    // A rejected resume cannot be retried; the Server's Match is gone or held
    // by another Observer. An auth-key rejection keeps the log for a manual try.
    if (reason === MATCH_SECRET_REJECTION) this.#discardSession();

    this.#update('idle', reason);
    socket?.close();
  }

  #fail(message: string): void {
    this.#clearReconnectTimer();
    this.#reconnectAttempt = 0;
    const socket = this.#detachSocket();
    this.#update('idle', message);
    socket?.close();
  }

  #detachSocket(): SocketLike | null {
    const socket = this.#socket;
    this.#socket = null;
    this.#sentIds.clear();
    return socket;
  }

  #discardSession(): void {
    this.#clearReconnectTimer();
    this.#reconnectAttempt = 0;
    this.#matchSecret = null;
    this.#outbox.length = 0;
    this.#outboxIds.clear();
    this.#sentIds.clear();
    this.#warning = null;
    this.#options.outbox?.clear();
  }

  #persist(): void {
    const store = this.#options.outbox;
    if (!store) return;
    if (this.#matchSecret === null && this.#outbox.length === 0) {
      store.clear();
      return;
    }
    store.save({
      serverUrl: this.#config?.serverUrl ?? null,
      groupCode: this.#config?.groupCode ?? null,
      matchSecret: this.#matchSecret,
      events: this.#outbox,
    });
  }

  #isActive(): boolean {
    return this.#state === 'connecting' || this.#state === 'live' ||
      this.#state === 'reconnecting';
  }

  #setWarning(warning: string | null): void {
    if (this.#warning === warning) return;
    this.#warning = warning;
    this.#options.onChange?.(this.status);
  }

  #update(state: SessionState, error: string | null): void {
    if (this.#state === state && this.#error === error) return;
    this.#state = state;
    this.#error = error;
    this.#options.onChange?.(this.status);
  }
}

function makeEvent<TType extends IngestEventType>(
  type: TType,
  payload: IngestPayloads[TType],
  capturedAt = new Date().toISOString(),
): IngestEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId: randomUUID(),
    type,
    capturedAt,
    payload,
  } as IngestEvent;
}

function parseLogonResponse(data: unknown): LogonResponse | null {
  if (typeof data !== 'string') return null;
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object') return null;
    const response = value as Record<string, unknown>;
    if (response.accepted === true && typeof response.matchSecret === 'string') {
      return value as LogonResponse;
    }
    if (response.accepted === false && typeof response.reason === 'string') {
      return value as LogonResponse;
    }
    return null;
  } catch {
    return null;
  }
}

function toWebSocketUrl(serverUrl: string, allowInsecure: boolean): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error('The server URL is not valid.');
  }

  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:' || url.protocol === 'ws:') {
    if (!allowInsecure || !isLoopbackHost(url.hostname)) {
      throw new Error(
        'Use HTTPS or WSS. Non-TLS is only allowed for localhost in development.',
      );
    }
    url.protocol = 'ws:';
  } else if (url.protocol !== 'wss:') {
    throw new Error('Use an HTTPS or WSS URL.');
  }

  return url.toString();
}

function toScene(value: unknown): Scene | null {
  if (typeof value !== 'string') return null;
  const scene = value.trim();
  if (scene === 'MainMenu') return 'main_menu';
  if (scene === 'CharacterSelectPersistentLevel') return 'agent_select';
  if (scene === 'Range') return 'practice_range';
  // Any other non-empty scene is a map codename (including new maps).
  return scene.length > 0 ? 'in_game' : null;
}

function toRoundPhase(value: unknown): RoundPhase | null {
  if (typeof value !== 'string') return null;
  const phase = value.trim().toLowerCase();
  return phase === 'shopping' || phase === 'combat' || phase === 'end' || phase === 'game_end'
    ? phase
    : null;
}

function toRoundNumber(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number >= 0 ? number : null;
}
