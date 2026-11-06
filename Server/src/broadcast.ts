import type { IncomingMessage } from "node:http";

import type {
  BroadcastSnapshot,
  CapabilityAdvertisement,
  ProductionConfig,
} from "@obvs/protocol";
import { WebSocket, WebSocketServer } from "ws";

import {
  DEFAULT_BROADCAST_PORT,
  DEFAULT_MAX_SUBSCRIBERS,
  DEFAULT_PRODUCTION,
  type ServerConfig,
} from "./config.js";
import { startHeartbeat, trackLiveness } from "./heartbeat.js";
import { GROUP_CODE_PATTERN } from "./logon.js";
import type { Match } from "./match.js";
import type { MatchRegistry } from "./registry.js";
import { buildSnapshotContent, seriesKey, type SeriesResult } from "./snapshot.js";

const POLICY_VIOLATION = 1008;
const TRY_AGAIN_LATER = 1013;
/** Frontends only listen; anything they send is ignored, so frames stay tiny. */
const MAX_SUBSCRIBER_PAYLOAD_BYTES = 1024;
/** A subscriber this far behind cannot catch up; drop it so it reconnects fresh. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** 100 ms between pushes keeps every group at or under 10 Hz (S.3). */
const DEFAULT_MIN_PUSH_INTERVAL_MS = 100;

export interface Subscriber {
  send(data: string): void;
}

export interface BroadcasterOptions {
  production: ProductionConfig;
  capabilities: CapabilityAdvertisement;
  minPushIntervalMs?: number;
}

interface GroupState {
  seriesResults: SeriesResult[];
  last: BroadcastSnapshot | null;
  lastContent: string | null;
}

interface Channel {
  /** Each subscriber's last-sent snapshot, so a push reaches only those behind. */
  subscribers: Map<Subscriber, BroadcastSnapshot>;
  lastPushAtMs: number;
  timer: NodeJS.Timeout | null;
}

/** Turns registry changes into throttled full-snapshot pushes per group code (S.3, ADR-0007). */
export class Broadcaster {
  readonly #registry: MatchRegistry;
  readonly #options: BroadcasterOptions;
  readonly #minPushIntervalMs: number;
  readonly #groups = new Map<string, GroupState>();
  readonly #channels = new Map<string, Channel>();
  readonly #stopListening: () => void;

  constructor(registry: MatchRegistry, options: BroadcasterOptions) {
    this.#registry = registry;
    this.#options = options;
    this.#minPushIntervalMs = options.minPushIntervalMs ?? DEFAULT_MIN_PUSH_INTERVAL_MS;
    this.#stopListening = registry.onChange((groupCode) => this.#changed(groupCode));
  }

  /** Send the current snapshot at once, then every change until unsubscribed. */
  subscribe(groupCode: string, subscriber: Subscriber): void {
    let channel = this.#channels.get(groupCode);

    if (channel === undefined) {
      channel = { subscribers: new Map(), lastPushAtMs: 0, timer: null };
      this.#channels.set(groupCode, channel);
    }

    const snapshot = this.snapshot(groupCode);
    channel.subscribers.set(subscriber, snapshot);
    deliver(subscriber, JSON.stringify(snapshot), groupCode);
  }

  unsubscribe(groupCode: string, subscriber: Subscriber): void {
    const channel = this.#channels.get(groupCode);

    if (channel === undefined || !channel.subscribers.delete(subscriber)) {
      return;
    }

    if (channel.subscribers.size === 0) {
      if (channel.timer !== null) clearTimeout(channel.timer);
      this.#channels.delete(groupCode);
      this.#forgetIfUnused(groupCode);
    }
  }

  /**
   * The group's current snapshot. The sequence rises only when the content changes,
   * and restarts at 0 when the live matchId changes.
   */
  snapshot(groupCode: string): BroadcastSnapshot {
    const match = this.#registry.get(groupCode);
    const group = this.#group(groupCode);
    const content = buildSnapshotContent({
      groupCode,
      match: match === undefined ? null : { matchId: match.matchId, state: match.state },
      seriesId: `series-${groupCode}`,
      seriesResults: group.seriesResults,
      production: this.#options.production,
      capabilities: this.#options.capabilities,
    });
    const serialized = JSON.stringify(content);

    if (group.last !== null && group.lastContent === serialized) {
      return group.last;
    }

    const sameMatch = group.last !== null && group.last.matchId === content.matchId;
    const { protocolVersion, ...body } = content;
    const snapshot: BroadcastSnapshot = {
      protocolVersion,
      sequence: sameMatch ? group.last!.sequence + 1 : 0,
      generatedAt: new Date().toISOString(),
      ...body,
    };

    group.last = snapshot;
    group.lastContent = serialized;

    return snapshot;
  }

  close(): void {
    this.#stopListening();

    for (const channel of this.#channels.values()) {
      if (channel.timer !== null) clearTimeout(channel.timer);
    }

    this.#channels.clear();
  }

  /** Runs inside the ingest message handler, so a failure here must never reach it. */
  #changed(groupCode: string): void {
    try {
      const match = this.#registry.get(groupCode);

      if (match?.state.ended) {
        this.#recordResult(groupCode, match);
      }

      if (this.#channels.has(groupCode)) {
        this.#schedule(groupCode);
      } else {
        this.#forgetIfUnused(groupCode);
      }
    } catch (error) {
      console.error(`[broadcast] change error group=${groupCode}: ${errorMessage(error)}`);
    }
  }

  /** Upsert by map, so replays and late events never count a map twice. */
  #recordResult(groupCode: string, match: Match): void {
    const results = this.#group(groupCode).seriesResults;
    const result: SeriesResult = {
      key: seriesKey(match.matchId, match.state),
      map: match.state.map ?? "unknown",
      winningTeamId: match.state.winningTeamId,
    };
    const index = results.findIndex((entry) => entry.key === result.key);
    const current = index === -1 ? undefined : results[index];

    if (current?.map === result.map && current.winningTeamId === result.winningTeamId) {
      return;
    }

    if (index === -1) {
      results.push(result);
    } else {
      results[index] = result;
    }

    const winner = result.winningTeamId ?? "draw";
    console.log(`[broadcast] series result group=${groupCode} map=${result.map} winner=${winner}`);
  }

  /** Leading push when idle, otherwise one trailing push that carries every change since. */
  #schedule(groupCode: string): void {
    const channel = this.#channels.get(groupCode);

    if (channel === undefined || channel.timer !== null) {
      return;
    }

    const wait = Math.max(0, channel.lastPushAtMs + this.#minPushIntervalMs - Date.now());

    channel.timer = setTimeout(() => {
      channel.timer = null;

      // Timers can fire a millisecond early; never push inside the interval.
      if (Date.now() < channel.lastPushAtMs + this.#minPushIntervalMs) {
        this.#schedule(groupCode);
        return;
      }

      this.#push(groupCode, channel);
    }, wait);
    channel.timer.unref();
  }

  #push(groupCode: string, channel: Channel): void {
    let snapshot: BroadcastSnapshot;

    try {
      snapshot = this.snapshot(groupCode);
    } catch (error) {
      console.error(`[broadcast] snapshot error group=${groupCode}: ${errorMessage(error)}`);
      return;
    }

    // Events such as raw GEP or frames change nothing visible, so nothing is sent.
    const behind = [...channel.subscribers].filter(([, sent]) => sent !== snapshot);

    if (behind.length === 0) {
      return;
    }

    // Stamped after serializing, so the throttle measures from the actual send.
    const data = JSON.stringify(snapshot);
    channel.lastPushAtMs = Date.now();

    for (const [subscriber] of behind) {
      channel.subscribers.set(subscriber, snapshot);
      deliver(subscriber, data, groupCode);
    }

    const { sequence } = snapshot;
    console.log(`[broadcast] push group=${groupCode} seq=${sequence} subscribers=${behind.length}`);
  }

  #group(groupCode: string): GroupState {
    let group = this.#groups.get(groupCode);

    if (group === undefined) {
      group = { seriesResults: [], last: null, lastContent: null };
      this.#groups.set(groupCode, group);
    }

    return group;
  }

  /**
   * Keep a group's sequence while its Match lives and its series once a map is recorded;
   * drop anything else so subscribing to random group codes cannot grow memory.
   */
  #forgetIfUnused(groupCode: string): void {
    const group = this.#groups.get(groupCode);

    if (
      group !== undefined &&
      group.seriesResults.length === 0 &&
      !this.#channels.has(groupCode) &&
      this.#registry.get(groupCode) === undefined
    ) {
      this.#groups.delete(groupCode);
    }
  }
}

export function createBroadcaster(config: ServerConfig, registry: MatchRegistry): Broadcaster {
  return new Broadcaster(registry, {
    production: config.production ?? DEFAULT_PRODUCTION,
    capabilities: config.capabilities,
  });
}

/** Frontends subscribe with `?groupCode=<code>`; resolves once the port is bound. */
export function startBroadcastServer(
  config: ServerConfig,
  broadcaster: Broadcaster,
): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      host: config.host ?? "127.0.0.1",
      port: config.broadcastPort ?? DEFAULT_BROADCAST_PORT,
      maxPayload: MAX_SUBSCRIBER_PAYLOAD_BYTES,
    });
    const maxSubscribers = config.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS;

    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve(server);
    });
    server.on("error", (error) => {
      console.error(`[broadcast] server error: ${error.message}`);
    });
    server.on("connection", (socket, request) => {
      const ip = remoteIp(request);
      console.log(`[broadcast] connection ${ip}`);

      // Attached first: a rejected socket can still error before its close completes.
      socket.on("error", (error) => {
        console.error(`[broadcast] socket error ${ip}: ${error.message}`);
        socket.terminate();
      });

      // `clients` already includes this socket.
      if (server.clients.size > maxSubscribers) {
        console.log(`[broadcast] rejected ${ip}: subscriber limit reached`);
        socket.close(TRY_AGAIN_LATER, "Subscriber limit reached");
        return;
      }

      trackLiveness(socket);
      handleSubscriber(socket, request, ip, broadcaster);
    });

    startHeartbeat(server);
    server.on("close", () => broadcaster.close());
  });
}

/** Subscribe a frontend socket to its group until it closes. */
function handleSubscriber(
  socket: WebSocket,
  request: IncomingMessage,
  ip: string,
  broadcaster: Broadcaster,
): void {
  const groupCode = groupCodeOf(request);

  if (groupCode === null || !GROUP_CODE_PATTERN.test(groupCode)) {
    console.log(`[broadcast] rejected ${ip}: invalid group code`);
    socket.close(POLICY_VIOLATION, "Invalid group code");
    return;
  }

  const subscriber = socketSubscriber(socket, ip, groupCode);

  socket.on("close", () => {
    broadcaster.unsubscribe(groupCode, subscriber);
    console.log(`[broadcast] unsubscribe ${ip} group=${groupCode}`);
  });

  console.log(`[broadcast] subscribe ${ip} group=${groupCode}`);
  broadcaster.subscribe(groupCode, subscriber);
}

/** Send guard: skip closed sockets and drop subscribers too slow to keep up. */
export function socketSubscriber(socket: WebSocket, ip: string, groupCode: string): Subscriber {
  return {
    send(data) {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        console.log(`[broadcast] dropped slow subscriber ${ip} group=${groupCode}`);
        socket.terminate();
        return;
      }

      socket.send(data, (error) => {
        if (error) {
          console.error(`[broadcast] send error ${ip} group=${groupCode}: ${error.message}`);
          socket.terminate();
        }
      });
    },
  };
}

/** One failing subscriber must not stop delivery to the rest of its group. */
function deliver(subscriber: Subscriber, data: string, groupCode: string): void {
  try {
    subscriber.send(data);
  } catch (error) {
    console.error(`[broadcast] send error group=${groupCode}: ${errorMessage(error)}`);
  }
}

/** A malformed request target must not throw inside the connection handler. */
function groupCodeOf(request: IncomingMessage): string | null {
  try {
    return new URL(request.url ?? "/", "ws://localhost").searchParams.get("groupCode");
  } catch {
    return null;
  }
}

function remoteIp(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
