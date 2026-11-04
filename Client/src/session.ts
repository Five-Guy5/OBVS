import { randomUUID } from 'node:crypto';
import type {
  IngestEvent,
  IngestEventType,
  IngestPayloads,
  LogonRequest,
  LogonResponse,
  RoundPhase,
  Scene,
} from '@obvs/protocol';

// Protocol v1 is the only schema this Client speaks; keep in step with Protocol/src/version.ts.
const PROTOCOL_VERSION = 1 as IngestEvent['protocolVersion'];
const MAX_CONNECTING_EVENTS = 500;
const OPEN = 1;

export type SessionState = 'idle' | 'connecting' | 'live' | 'stopping';

export interface SessionStatus {
  state: SessionState;
  error: string | null;
}

export interface SessionConfig {
  serverUrl: string;
  groupCode: string;
  displayName: string;
  authKey: string;
}

export interface SocketLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: any) => void): void;
  send(data: string): void;
  close(): void;
}

export interface SessionOptions {
  clientVersion: string;
  createSocket: (url: string) => SocketLike;
  onChange?: (status: SessionStatus) => void;
}

/**
 * Owns the Client-side match session: GEP triggers, logon, event relay, and
 * manual Connect/Disconnect. Recovery/backoff belongs to F7; this class only
 * keeps the Match Secret in memory for a manual mid-match reconnect.
 */
export class Session {
  readonly #options: SessionOptions;
  #config: SessionConfig | null = null;
  #state: SessionState = 'idle';
  #error: string | null = null;
  #socket: SocketLike | null = null;
  #matchSecret: string | null = null;
  #pending: IngestEvent[] = [];
  #suppressAuto = false;
  #lastScene: Scene | null = null;
  #roundNumber: number | null = null;
  #roundPhase: RoundPhase | null = null;
  #ended = false;

  constructor(options: SessionOptions) {
    this.#options = options;
  }

  get status(): SessionStatus {
    return { state: this.#state, error: this.#error };
  }

  setConfig(config: SessionConfig | null): void {
    this.#config = config;
  }

  /** Manual Connect: keep any in-memory Match Secret so a mid-match reconnect resumes. */
  connect(): void {
    this.#suppressAuto = false;
    this.#connect();
  }

  /** Manual Disconnect: suppress automatic triggers until the next match begins. */
  disconnect(): void {
    this.#suppressAuto = true;
    this.#pending.length = 0;
    if (this.#state === 'idle') {
      this.#update('idle', null);
      return;
    }
    if (this.#state === 'connecting' || this.#state === 'live') {
      this.#update('stopping', null);
      this.#socket?.close();
    }
  }

  handleInfo(feature: string, key: string, value: unknown): void {
    this.#handleGep('info', feature, key, value);
  }

  handleEvent(feature: string, key: string, value: unknown): void {
    this.#handleGep('event', feature, key, value);
  }

  #connect(): void {
    if (this.#state !== 'idle') return;

    const config = this.#config;
    if (!config) {
      this.#update('idle', 'Save connection settings before connecting.');
      return;
    }

    let url: string;
    try {
      url = toWebSocketUrl(config.serverUrl);
    } catch {
      this.#update('idle', 'The server URL is not valid.');
      return;
    }

    this.#update('connecting', null);
    this.#ended = false;

    let socket: SocketLike;
    try {
      socket = this.#options.createSocket(url);
    } catch {
      this.#update('idle', 'Could not connect to the server.');
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
      if (this.#socket !== socket || this.#state !== 'connecting') return;
      try {
        socket.send(JSON.stringify(logon));
      } catch {
        this.#fail('Could not send the logon request.');
      }
    });

    socket.addEventListener('message', (event: { data?: unknown }) => {
      if (this.#socket !== socket || this.#state !== 'connecting') return;
      const response = parseLogonResponse(event.data);
      if (!response) {
        this.#fail('The server sent an invalid logon response.');
        return;
      }
      if (!response.accepted) {
        this.#fail(response.reason);
        return;
      }
      this.#matchSecret = response.matchSecret;
      this.#update('live', null);
      this.#flush();
    });

    socket.addEventListener('error', () => {
      if (this.#socket !== socket) return;
      this.#fail(this.#state === 'connecting'
        ? 'Could not connect to the server.'
        : 'Connection lost.');
    });

    socket.addEventListener('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      if (this.#state === 'connecting') {
        this.#update('idle', 'The server closed the connection during logon.');
      } else if (this.#state === 'live') {
        this.#update('idle', 'Connection lost.');
      } else if (this.#state === 'stopping') {
        this.#update('idle', null);
      }
    });
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
    if (roundNumber !== null) this.#roundNumber = roundNumber;
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

    if (this.#state === 'live' || this.#state === 'connecting') {
      this.#relay(makeEvent('gep.raw', {
        feature,
        key,
        value,
        timestamp: capturedAt,
      }, capturedAt));

      if (scene !== null) {
        this.#relay(makeEvent('scene', { scene }, capturedAt));
      }
      if (feature === 'match_info' && (key === 'round_number' || key === 'round_phase')) {
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
      return;
    }
    if (this.#state !== 'idle' || this.#suppressAuto) return;

    // A transition into a match scene starts a new Match; drop any old secret.
    if (previous === null || previous === 'main_menu' || previous === 'practice_range') {
      this.#matchSecret = null;
    }
    this.#connect();
  }

  #onMatchStart(): void {
    if (this.#state !== 'idle' || this.#suppressAuto) return;
    this.#matchSecret = null;
    this.#connect();
  }

  #emitRound(capturedAt: string): void {
    if (this.#roundNumber === null || this.#roundPhase === null) return;
    this.#relay(makeEvent('round', {
      number: this.#roundNumber,
      phase: this.#roundPhase,
    }, capturedAt));
  }

  #relay(event: IngestEvent): void {
    if (this.#state === 'live') {
      this.#send(event);
      return;
    }
    if (this.#state === 'connecting') {
      // shortcut: in-memory queue only; F7 replaces this with the persistent outbox.
      if (this.#pending.length >= MAX_CONNECTING_EVENTS) this.#pending.shift();
      this.#pending.push(event);
    }
  }

  #flush(): void {
    for (const event of this.#pending.splice(0)) this.#send(event);
  }

  #send(event: IngestEvent): void {
    if (this.#state !== 'live' || this.#socket?.readyState !== OPEN) return;
    try {
      this.#socket.send(JSON.stringify(event));
    } catch {
      this.#fail('Could not send an event to the server.');
    }
  }

  #stop(): void {
    this.#matchSecret = null;
    this.#ended = true;
    this.#pending.length = 0;
    this.#suppressAuto = false;

    if (this.#state === 'idle' || this.#state === 'stopping') {
      this.#update('idle', null);
      return;
    }
    this.#update('stopping', null);
    this.#socket?.close();
  }

  #fail(message: string): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#pending.length = 0;
    this.#update('idle', message);
    socket?.close();
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

function toWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new Error('Unsupported server URL protocol.');
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
