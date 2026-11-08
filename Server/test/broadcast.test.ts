import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import { after, before, describe, it } from "node:test";

import { PROTOCOL_VERSION, type BroadcastSnapshot, type IngestEvent } from "@obvs/protocol";
import { WebSocket, type WebSocketServer } from "ws";

import {
  Broadcaster,
  socketSubscriber,
  startBroadcastServer,
  type Subscriber,
} from "../src/broadcast.js";
import { DEFAULT_CAPABILITIES, DEFAULT_PRODUCTION, type ServerConfig } from "../src/config.js";
import { startIngestServer } from "../src/ingest.js";
import { MatchRegistry } from "../src/registry.js";
import { ingestSequence } from "../../Protocol/test/fixtures/index.js";

const observer = { name: "Observer", clientVersion: "0.1.0", connectedAt: "2026-01-01T00:00:00Z" };
const options = { production: DEFAULT_PRODUCTION, capabilities: DEFAULT_CAPABILITIES };

interface Received {
  snapshot: BroadcastSnapshot;
  atMs: number;
}

function recorder(): Subscriber & { received: Received[] } {
  const received: Received[] = [];

  return {
    received,
    send(data) {
      const atMs = Date.now();
      received.push({ snapshot: JSON.parse(data) as BroadcastSnapshot, atMs });
    },
  };
}

function rawGepEvent(eventId: string): IngestEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId,
    type: "gep.raw",
    capturedAt: "2026-01-01T00:00:30.000Z",
    payload: { feature: "f", key: "k", value: 1, timestamp: "2026-01-01T00:00:30.000Z" },
  };
}

function scoreboardEvent(eventId: string, money: number): IngestEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId,
    type: "scoreboard",
    capturedAt: "2026-01-01T00:01:00.000Z",
    payload: {
      players: [
        {
          puuid: "player-1",
          name: "Ace#NA1",
          agent: "Jett",
          teamId: 0,
          kills: 0,
          deaths: 0,
          assists: 0,
          money,
          alive: true,
          armor: "none",
          primaryWeapon: null,
          spikeCarrier: false,
          ult: { points: 0, max: 7 },
        },
      ],
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await sleep(10);
  }

  assert.ok(condition(), "condition was not met in time");
}

function setup(minPushIntervalMs = 50) {
  const registry = new MatchRegistry();
  const broadcaster = new Broadcaster(registry, { ...options, minPushIntervalMs });

  return { registry, broadcaster };
}

describe("broadcaster", () => {
  it("sends an idle snapshot immediately on subscribe", () => {
    const { broadcaster } = setup();
    const subscriber = recorder();

    broadcaster.subscribe("group_1", subscriber);

    assert.equal(subscriber.received.length, 1);
    const [{ snapshot }] = subscriber.received as [Received];
    assert.equal(snapshot.protocolVersion, PROTOCOL_VERSION);
    assert.equal(snapshot.groupCode, "group_1");
    assert.equal(snapshot.sequence, 0);
    assert.equal(snapshot.matchId, null);
    assert.equal(snapshot.match, null);
    broadcaster.close();
  });

  it("pushes changes with a rising sequence that restarts for a new Match", async () => {
    const { registry, broadcaster } = setup();
    const subscriber = recorder();
    broadcaster.subscribe("group_1", subscriber);

    const claim = registry.claim("group_1", observer);
    assert.ok(claim.ok);
    await waitFor(() => subscriber.received.length === 2);
    assert.equal(subscriber.received[1]?.snapshot.matchId, claim.match.matchId);
    assert.equal(subscriber.received[1]?.snapshot.sequence, 0);

    for (const next of ingestSequence) {
      claim.match.append(next);
      await sleep(60);
    }

    const sequences = subscriber.received.slice(1).map(({ snapshot }) => snapshot.sequence);
    assert.deepEqual(sequences, sequences.map((_, index) => index));
    assert.ok(sequences.length > 2);
    broadcaster.close();
  });

  it("pushes at most once per interval and always delivers the final state", async () => {
    const { registry, broadcaster } = setup(50);
    const subscriber = recorder();
    const claim = registry.claim("group_1", observer);
    assert.ok(claim.ok);
    broadcaster.subscribe("group_1", subscriber);

    for (let index = 0; index < 40; index += 1) {
      claim.match.append(scoreboardEvent(`money-${index}`, index));
      await sleep(5);
    }

    const final = () => subscriber.received.at(-1)?.snapshot.match?.teams[0].players[0].money;
    await waitFor(() => final() === 39);
    const pushes = subscriber.received.slice(1);
    const spanMs = pushes.at(-1)!.atMs - pushes[0]!.atMs;
    const minimumSpanMs = (pushes.length - 1) * 50;

    assert.ok(pushes.length < 40, `expected coalescing, got ${pushes.length} pushes`);
    // Judged over the whole run: one receipt delayed by a busy CI machine can shrink a
    // single gap, but N pushes can never fit inside less than N - 1 intervals.
    assert.ok(
      spanMs >= minimumSpanMs - 20,
      `${pushes.length} pushes in ${spanMs} ms, under the ${minimumSpanMs} ms minimum`,
    );
    broadcaster.close();
  });

  it("sends nothing when an event changes nothing visible", async () => {
    const { registry, broadcaster } = setup();
    const subscriber = recorder();
    const claim = registry.claim("group_1", observer);
    assert.ok(claim.ok);
    broadcaster.subscribe("group_1", subscriber);

    claim.match.append(rawGepEvent("raw-1"));
    await sleep(100);

    assert.equal(subscriber.received.length, 1);
    broadcaster.close();
  });

  it("keeps the series after the Match is removed", async () => {
    const { registry, broadcaster } = setup();
    const subscriber = recorder();
    const claim = registry.claim("group_1", observer);
    assert.ok(claim.ok);

    for (const next of ingestSequence) {
      claim.match.append(next);
    }

    registry.remove(claim.match);
    broadcaster.subscribe("group_1", subscriber);

    const [{ snapshot }] = subscriber.received as [Received];
    assert.equal(snapshot.match, null);
    assert.deepEqual(snapshot.series.maps, [
      { map: "/Game/Maps/Haven/Haven", winningTeamId: 0 },
    ]);
    assert.deepEqual(snapshot.series.wins, [1, 0]);
    broadcaster.close();
  });

  it("counts a finished map once even if match.end repeats", () => {
    const { registry, broadcaster } = setup();
    const claim = registry.claim("group_1", observer);
    assert.ok(claim.ok);

    for (const next of ingestSequence) {
      claim.match.append(next);
    }
    claim.match.append({ ...ingestSequence.at(-1)!, eventId: "ingest-016" });

    assert.deepEqual(broadcaster.snapshot("group_1").series.wins, [1, 0]);
    broadcaster.close();
  });

  it("records each map when one Match spans a series", () => {
    const { registry, broadcaster } = setup();
    const claim = registry.claim("group_1", observer);
    assert.ok(claim.ok);

    for (const next of ingestSequence) {
      claim.match.append(next);
    }
    claim.match.append({
      protocolVersion: PROTOCOL_VERSION,
      eventId: "map-2",
      type: "match.info",
      capturedAt: "2026-01-01T00:10:00.000Z",
      payload: { matchId: "map-2", map: "Bind" },
    });

    const snapshot = broadcaster.snapshot("group_1");
    assert.deepEqual(snapshot.series.maps, [
      { map: "/Game/Maps/Haven/Haven", winningTeamId: 0 },
      { map: "Bind", winningTeamId: null },
    ]);
    assert.deepEqual(snapshot.series.wins, [1, 0]);
    assert.equal(snapshot.match?.running, true);
    broadcaster.close();
  });

  it("replaces a provisional result when match.info arrives late", () => {
    const { registry, broadcaster } = setup();
    const claim = registry.claim("group_1", observer);
    assert.ok(claim.ok);

    const endEvent: IngestEvent = {
      protocolVersion: PROTOCOL_VERSION,
      eventId: "late-end",
      type: "match.end",
      capturedAt: "2026-01-01T00:00:10.000Z",
      payload: { winningTeamId: 0 },
    };
    claim.match.append(endEvent);
    assert.deepEqual(broadcaster.snapshot("group_1").series.maps, [
      { map: "unknown", winningTeamId: 0 },
    ]);

    claim.match.append({
      protocolVersion: PROTOCOL_VERSION,
      eventId: "late-info",
      type: "match.info",
      capturedAt: "2026-01-01T00:00:00.000Z",
      payload: { matchId: "late-game", map: "Haven" },
    });

    const series = broadcaster.snapshot("group_1").series;
    assert.deepEqual(series.maps, [{ map: "Haven", winningTeamId: 0 }]);
    assert.deepEqual(series.wins, [1, 0]);
    broadcaster.close();
  });

  it("does not count a replayed stream twice when a new Match starts", () => {
    const { registry, broadcaster } = setup();
    const first = registry.claim("group_1", observer);
    assert.ok(first.ok);

    for (const next of ingestSequence) {
      first.match.append(next);
    }
    registry.remove(first.match);

    const second = registry.claim("group_1", observer);
    assert.ok(second.ok);
    for (const next of ingestSequence) {
      second.match.append(next);
    }

    const series = broadcaster.snapshot("group_1").series;
    assert.deepEqual(series.maps, [
      { map: "/Game/Maps/Haven/Haven", winningTeamId: 0 },
    ]);
    assert.deepEqual(series.wins, [1, 0]);
    broadcaster.close();
  });

  it("still pushes to existing subscribers when another subscribes mid-interval", async () => {
    const { registry, broadcaster } = setup();
    const first = recorder();
    const claim = registry.claim("group_1", observer);
    assert.ok(claim.ok);
    broadcaster.subscribe("group_1", first);

    claim.match.append(scoreboardEvent("money-1", 100));
    broadcaster.subscribe("group_1", recorder());

    await waitFor(() => first.received.length === 2);
    assert.equal(first.received[1]?.snapshot.match?.teams[0].players[0].money, 100);
    broadcaster.close();
  });

  it("keeps delivering to the group when one subscriber throws", async () => {
    const { registry, broadcaster } = setup();
    const healthy = recorder();
    const claim = registry.claim("group_1", observer);
    assert.ok(claim.ok);

    broadcaster.subscribe("group_1", { send: () => { throw new Error("socket gone"); } });
    broadcaster.subscribe("group_1", healthy);
    claim.match.append(scoreboardEvent("money-1", 100));

    await waitFor(() => healthy.received.length === 2);
    assert.equal(healthy.received[1]?.snapshot.match?.teams[0].players[0].money, 100);
    broadcaster.close();
  });

  it("never includes the Match Secret, auth key, or Observer details", async () => {
    const { registry, broadcaster } = setup();
    const subscriber = recorder();
    const claim = registry.claim("group_1", { ...observer, name: "Secret Observer Name" });
    assert.ok(claim.ok);
    broadcaster.subscribe("group_1", subscriber);

    for (const next of ingestSequence) {
      claim.match.append(next);
    }
    await sleep(100);

    const wire = JSON.stringify(subscriber.received.map(({ snapshot }) => snapshot));
    assert.ok(!wire.includes(claim.match.secret));
    assert.ok(!wire.includes("Secret Observer Name"));
    assert.ok(!/authKey|matchSecret/.test(wire));
    broadcaster.close();
  });
});

describe("socket subscriber send guard", () => {
  function fakeSocket(patch: { readyState?: number; bufferedAmount?: number; sendError?: Error }) {
    const socket = {
      readyState: patch.readyState ?? WebSocket.OPEN,
      bufferedAmount: patch.bufferedAmount ?? 0,
      sent: [] as string[],
      terminated: false,
      send(data: string, callback: (error?: Error) => void) {
        socket.sent.push(data);
        callback(patch.sendError);
      },
      terminate() {
        socket.terminated = true;
      },
    };

    return socket;
  }

  function subscriberFor(socket: ReturnType<typeof fakeSocket>): Subscriber {
    return socketSubscriber(socket as unknown as WebSocket, "1.2.3.4", "group_1");
  }

  it("sends to an open socket", () => {
    const socket = fakeSocket({});
    subscriberFor(socket).send("snapshot");

    assert.deepEqual(socket.sent, ["snapshot"]);
    assert.equal(socket.terminated, false);
  });

  it("skips a socket that is no longer open", () => {
    const socket = fakeSocket({ readyState: WebSocket.CLOSING });
    subscriberFor(socket).send("snapshot");

    assert.deepEqual(socket.sent, []);
  });

  it("drops a subscriber that has fallen too far behind", () => {
    const socket = fakeSocket({ bufferedAmount: 5 * 1024 * 1024 });
    subscriberFor(socket).send("snapshot");

    assert.deepEqual(socket.sent, []);
    assert.equal(socket.terminated, true);
  });

  it("terminates the socket when a send fails", () => {
    const socket = fakeSocket({ sendError: new Error("broken pipe") });
    subscriberFor(socket).send("snapshot");

    assert.equal(socket.terminated, true);
  });
});

describe("broadcast subscriber limit", () => {
  it("turns away subscribers past the configured limit", async () => {
    const registry = new MatchRegistry();
    const config: ServerConfig = {
      port: 0,
      broadcastPort: 0,
      maxSubscribers: 1,
      authKey: null,
      capabilities: DEFAULT_CAPABILITIES,
    };
    const server = await startBroadcastServer(config, new Broadcaster(registry, options));
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    const url = `ws://127.0.0.1:${address.port}/?groupCode=group_1`;

    const first = new WebSocket(url);
    await once(first, "message");

    const second = new WebSocket(url);
    const [code] = (await once(second, "close")) as [number];
    assert.equal(code, 1013);

    first.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("broadcast WebSocket", () => {
  const registry = new MatchRegistry();
  const config: ServerConfig = {
    port: 0,
    broadcastPort: 0,
    authKey: "secret",
    capabilities: DEFAULT_CAPABILITIES,
  };
  let ingest: WebSocketServer;
  let broadcast: WebSocketServer;

  function urlOf(server: WebSocketServer, path = ""): string {
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    return `ws://127.0.0.1:${address.port}${path}`;
  }

  before(async () => {
    ingest = await startIngestServer(config, registry);
    broadcast = await startBroadcastServer(config, new Broadcaster(registry, options));
  });

  after(async () => {
    for (const server of [ingest, broadcast]) {
      for (const client of server.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("streams snapshots for the subscribed group as the Observer sends events", async () => {
    const frontend = new WebSocket(urlOf(broadcast, "/?groupCode=ws_live"));
    const snapshots: BroadcastSnapshot[] = [];
    frontend.on("message", (data) => snapshots.push(JSON.parse(data.toString())));
    await waitFor(() => snapshots.length === 1);
    assert.equal(snapshots[0]?.match, null);

    const observerSocket = new WebSocket(urlOf(ingest));
    await once(observerSocket, "open");
    observerSocket.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        groupCode: "ws_live",
        observerName: "Observer",
        clientVersion: "0.1.0",
        authKey: "secret",
      }),
    );
    await once(observerSocket, "message");

    for (const next of ingestSequence) {
      observerSocket.send(JSON.stringify(next));
    }

    await waitFor(() => snapshots.at(-1)?.match?.running === false && snapshots.length > 2);
    const last = snapshots.at(-1)!;
    assert.equal(last.match?.map, "/Game/Maps/Haven/Haven");
    assert.equal(last.match?.teams[0].players[0].puuid, "player-1");
    assert.deepEqual(last.series.wins, [1, 0]);

    observerSocket.close();
    frontend.close();
  });

  it("rejects a subscription without a valid group code", async () => {
    const frontend = new WebSocket(urlOf(broadcast, "/?groupCode=bad.code"));
    const [code] = (await once(frontend, "close")) as [number];

    assert.equal(code, 1008);
  });

  async function assertStillServing(): Promise<void> {
    const frontend = new WebSocket(urlOf(broadcast, "/?groupCode=ws_alive"));
    await once(frontend, "message");
    frontend.close();
  }

  it("survives an oversized frame from a socket it is rejecting", async () => {
    const frontend = new WebSocket(urlOf(broadcast, "/?groupCode=bad.code"));
    // Send inside `open` itself: once awaited, the server's close frame has already arrived.
    frontend.on("open", () => frontend.send("x".repeat(4096)));
    frontend.on("error", () => {});
    await once(frontend, "close");

    await assertStillServing();
  });

  it("survives a malformed request target", async () => {
    const address = broadcast.address();
    assert.ok(typeof address === "object" && address !== null);
    const raw = connect(address.port, "127.0.0.1");
    await once(raw, "connect");
    raw.write(
      "GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    await once(raw, "data");
    raw.destroy();

    await assertStillServing();
  });

  it("drops a malformed event payload without crashing or breaking the Match", async () => {
    const observerSocket = new WebSocket(urlOf(ingest));
    await once(observerSocket, "open");
    observerSocket.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        groupCode: "ws_bad_payload",
        observerName: "Observer",
        clientVersion: "0.1.0",
        authKey: "secret",
      }),
    );
    await once(observerSocket, "message");

    observerSocket.send(JSON.stringify({ ...ingestSequence[5], eventId: "bad", payload: {} }));
    observerSocket.send(JSON.stringify(ingestSequence[5]));

    await waitFor(() => registry.get("ws_bad_payload")?.events.length === 1);
    assert.equal(registry.get("ws_bad_payload")?.events[0]?.eventId, ingestSequence[5]!.eventId);
    observerSocket.close();
    await assertStillServing();
  });
});
