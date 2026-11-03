import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";

import { PROTOCOL_VERSION, type LogonResponse } from "@obvs/protocol";
import { WebSocket, type WebSocketServer } from "ws";

import { DEFAULT_CAPABILITIES } from "../src/config.js";
import { startIngestServer } from "../src/ingest.js";
import { MatchRegistry } from "../src/registry.js";

const registry = new MatchRegistry();
let server: WebSocketServer;
let url: string;

function logonFrame(groupCode: string, authKey: string | null = "secret"): string {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    groupCode,
    observerName: "Observer",
    clientVersion: "0.1.0",
    authKey,
  });
}

function shopFrame(eventId: string, capturedAt: string): string {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    eventId,
    type: "shop",
    capturedAt,
    payload: { open: true },
  });
}

async function connect(): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await once(socket, "open");
  return socket;
}

async function logonOn(socket: WebSocket, frame: string): Promise<LogonResponse> {
  const reply = once(socket, "message");
  socket.send(frame);
  const [data] = (await reply) as [Buffer];
  return JSON.parse(data.toString()) as LogonResponse;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.ok(condition(), "condition was not met in time");
}

describe("ingest WebSocket", () => {
  before(async () => {
    server = await startIngestServer(
      { port: 0, authKey: "secret", capabilities: DEFAULT_CAPABILITIES },
      registry,
    );

    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    url = `ws://127.0.0.1:${address.port}`;
  });

  after(async () => {
    for (const client of server.clients) {
      client.terminate();
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("accepts a logon and stores ordered, deduplicated events", async () => {
    const socket = await connect();
    const response = await logonOn(socket, logonFrame("ws_accept"));

    assert.ok(response.accepted);
    assert.equal(response.matchSecret, registry.get("ws_accept")?.secret);
    assert.deepEqual(response.capabilities, DEFAULT_CAPABILITIES);

    socket.send(shopFrame("b", "2026-01-01T00:00:02Z"));
    socket.send(shopFrame("a", "2026-01-01T00:00:01Z"));
    socket.send(shopFrame("a", "2026-01-01T00:00:01Z"));
    socket.send("not json");

    await waitFor(() => registry.get("ws_accept")?.events.length === 2);
    assert.deepEqual(
      registry.get("ws_accept")?.events.map((event) => event.eventId),
      ["a", "b"],
    );

    socket.close();
  });

  it("rejects a bad auth key and closes the socket", async () => {
    const socket = await connect();
    const closed = once(socket, "close");
    const response = await logonOn(socket, logonFrame("ws_auth", "wrong"));

    assert.deepEqual(response, { accepted: false, reason: "Auth key rejected." });

    const [code] = (await closed) as [number];
    assert.equal(code, 1008);
    assert.equal(registry.get("ws_auth"), undefined);
  });

  it("rejects a second Observer and frees the group code on disconnect", async () => {
    const first = await connect();
    assert.ok((await logonOn(first, logonFrame("ws_single"))).accepted);

    const second = await connect();
    const rejected = await logonOn(second, logonFrame("ws_single"));
    assert.equal(rejected.accepted, false);

    first.close();
    await waitFor(() => registry.get("ws_single") === undefined);

    const third = await connect();
    assert.ok((await logonOn(third, logonFrame("ws_single"))).accepted);
    third.close();
  });
});
