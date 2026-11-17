/**
 * T3 (#25) - Reducer and broadcast verification (parent US.8 / #9; covers S.3, US.8.AC.2).
 *
 * Replays fixture streams through the real pipeline:
 *   ingest events -> Match.append -> applyEvent -> buildSnapshotContent -> Broadcaster -> subscriber
 *
 * The 10 Hz tests run on node:test mock timers (setTimeout + Date), so they are
 * deterministic and instant. One end-to-end test uses real sockets.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { after, afterEach, before, describe, it, mock } from "node:test";

import {
  PROTOCOL_VERSION,
  type BroadcastSnapshot,
  type IngestEvent,
  type RoundWinReason,
  type TeamId,
  type TeamSide,
} from "@obvs/protocol";
import { WebSocket, type WebSocketServer } from "ws";

import { Broadcaster, startBroadcastServer, type Subscriber } from "../src/broadcast.js";
import {
  DEFAULT_CAPABILITIES,
  DEFAULT_PRODUCTION,
  type ServerConfig,
} from "../src/config.js";
import { startIngestServer } from "../src/ingest.js";
import { MatchRegistry } from "../src/registry.js";
import { buildSnapshotContent } from "../src/snapshot.js";
import { applyEvent, initialMatchState, type MatchState } from "../src/state.js";

// ---------------------------------------------------------------------------
// Fixture streams
// ---------------------------------------------------------------------------

const GROUP = "t3_replay";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const OBSERVER = {
  name: "T3 Secret Observer",
  clientVersion: "0.1.0",
  connectedAt: "2026-01-01T00:00:00Z",
};
const options = { production: DEFAULT_PRODUCTION, capabilities: DEFAULT_CAPABILITIES };

type PayloadOf<T extends IngestEvent["type"]> = Extract<IngestEvent, { type: T }>["payload"];

/** Builds an ordered, self-consistent stream: unique eventIds, capturedAt rising 100 ms per event. */
class Stream {
  readonly puuids: [string[], string[]] = [
    Array.from({ length: 5 }, (_, i) => `p${i}`),
    Array.from({ length: 5 }, (_, i) => `p${i + 5}`),
  ];
  #seq = 0;
  #tick = 0;
  #round = 0;
  #scores: [number, number] = [0, 0];

  ev<T extends IngestEvent["type"]>(type: T, payload: PayloadOf<T>): IngestEvent {
    return {
      protocolVersion: PROTOCOL_VERSION,
      eventId: `t3-${++this.#seq}`,
      type,
      capturedAt: new Date(T0 + ++this.#tick * 100).toISOString(),
      payload,
    } as IngestEvent;
  }

  /** match.info + a full 5v5 roster. */
  start(): IngestEvent[] {
    const players = this.puuids.flatMap((team, teamId) =>
      team.map((puuid, i) => ({
        puuid,
        name: `Player-${puuid}#T3`,
        agent: "Jett",
        teamId: teamId as TeamId,
        slot: teamId * 5 + i + 1,
      })),
    );

    return [
      this.ev("match.info", { matchId: "t3-game", map: "Ascent", gameMode: "Standard" }),
      this.ev("roster", { players }),
    ];
  }

  /** One full round: shopping, combat, reason-specific events, score, end. */
  playRound(winner: TeamId, reason: RoundWinReason): IngestEvent[] {
    const round = ++this.#round;
    const loser: TeamId = winner === 0 ? 1 : 0;
    const events = [
      this.ev("round", { number: round, phase: "shopping" }),
      this.ev("round", { number: round, phase: "combat" }),
    ];

    if (reason === "detonated" || reason === "defused") {
      events.push(this.ev("spike", { action: "planted", site: "A" }));
      events.push(this.ev("spike", { action: reason, site: "A" }));
    } else if (reason === "elimination") {
      for (const victimPuuid of this.puuids[loser]) {
        events.push(
          this.ev("kill", {
            attackerPuuid: this.puuids[winner][0]!,
            victimPuuid,
            weapon: "Vandal",
            isAbility: false,
            isUltimate: false,
            headshot: true,
            assistantPuids: [],
          }),
        );
      }
    } // "timeout": no events until the round ends

    this.#scores[winner] += 1;
    events.push(this.ev("score", { rounds: [...this.#scores] }));
    events.push(this.ev("round", { number: round, phase: "end" }));

    return events;
  }

  /** n rounds with alternating winners (team 0 first), so the score stays tied or one apart. */
  alternating(n: number): IngestEvent[] {
    const reasons: RoundWinReason[] = ["detonated", "defused", "elimination", "timeout"];
    const events: IngestEvent[] = [];

    for (let i = 0; i < n; i += 1) {
      events.push(...this.playRound((i % 2) as TeamId, reasons[i % 4]!));
    }

    return events;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stateOf = (events: readonly IngestEvent[]): MatchState =>
  events.reduce(applyEvent, initialMatchState());

function snapshotOf(state: MatchState) {
  return buildSnapshotContent({
    groupCode: GROUP,
    match: { matchId: "t3-match", state },
    seriesId: `series-${GROUP}`,
    seriesResults: [],
    production: DEFAULT_PRODUCTION,
    capabilities: DEFAULT_CAPABILITIES,
  });
}

function liveMatch() {
  const registry = new MatchRegistry();
  const claim = registry.claim(GROUP, OBSERVER);
  assert.ok(claim.ok);

  return { registry, match: claim.match };
}

interface Received {
  atMs: number;
  raw: string;
  snapshot: BroadcastSnapshot;
}

function recorder(): Subscriber & { received: Received[] } {
  const received: Received[] = [];

  return {
    received,
    send(raw) {
      received.push({ atMs: Date.now(), raw, snapshot: JSON.parse(raw) as BroadcastSnapshot });
    },
  };
}

const FORBIDDEN_KEY = /auth|secret|token|password|api[_-]?key/i;

/** Fails on credential-looking keys anywhere in the snapshot, and on any seeded secret value. */
function assertNoCredentials(snapshot: unknown, secrets: readonly string[]): void {
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        assert.ok(!FORBIDDEN_KEY.test(key), `credential-like key at ${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
    }
  };

  walk(snapshot, "$");
  const wire = JSON.stringify(snapshot);

  for (const secret of secrets) {
    assert.ok(!wire.includes(secret), "a secret value reached the snapshot");
  }
}

/** The ticket's rule: sequence rises while matchId is unchanged and restarts at 0 for a new Match. */
function assertSequenceRule(snapshots: readonly BroadcastSnapshot[]): void {
  for (let i = 1; i < snapshots.length; i += 1) {
    const previous = snapshots[i - 1]!;
    const current = snapshots[i]!;

    if (current.matchId === previous.matchId) {
      assert.ok(
        current.sequence > previous.sequence,
        `sequence did not rise within one matchId: ${previous.sequence} -> ${current.sequence}`,
      );
    } else {
      assert.equal(current.sequence, 0, "sequence must restart at 0 for a new matchId");
    }
  }
}

async function waitFor(condition: () => boolean, attempts = 300): Promise<void> {
  for (let i = 0; i < attempts && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.ok(condition(), "condition was not met in time");
}

// ---------------------------------------------------------------------------
// Reducer -> snapshot
// ---------------------------------------------------------------------------

describe("replay: reducer and snapshot", () => {
  it("swaps sides after round 12, and alternates every round from round 25", () => {
    const stream = new Stream();
    const events = [...stream.start(), ...stream.alternating(28)];

    let state = initialMatchState();
    const seen: { round: number; sides: [TeamSide, TeamSide] }[] = [];

    for (const event of events) {
      state = applyEvent(state, event);

      if (event.type === "round") {
        const match = snapshotOf(state).match!;
        seen.push({ round: match.round.number, sides: [match.teams[0].side, match.teams[1].side] });
      }
    }

    const [startA, startB] = DEFAULT_PRODUCTION.teams.map((team) => team.startingSide) as [
      TeamSide,
      TeamSide,
    ];
    const start: [TeamSide, TeamSide] = [startA, startB];
    const swapped: [TeamSide, TeamSide] = [startB, startA];

    // Rounds 1-12 start sides (including the end of round 12), 13-24 swapped,
    // then overtime: round 25 back to start, 26 swapped, 27 start, 28 swapped.
    const expected = (round: number): [TeamSide, TeamSide] =>
      round <= 12 ? start : round <= 24 ? swapped : round % 2 === 1 ? start : swapped;

    assert.equal(snapshotOf(state).match?.thresholds.switchAfterRound, 12);
    assert.ok(seen.some((s) => s.round === 12), "round 12 was replayed");
    assert.ok(seen.some((s) => s.round === 28), "overtime rounds were replayed");
    for (const { round, sides } of seen) {
      assert.deepEqual(sides, expected(round), `sides at round ${round}`);
    }
  });

  it("reaches round 25 from a 12-12 tie with the overtime threshold at 25", () => {
    const stream = new Stream();
    const events = [...stream.start(), ...stream.alternating(24)];
    const atTie = snapshotOf(stateOf(events)).match!;

    assert.deepEqual(
      atTie.teams.map((team) => team.roundsWon),
      [12, 12],
    );
    assert.equal(atTie.thresholds.overtimeFromRound, 25);
    assert.ok(atTie.round.number < atTie.thresholds.overtimeFromRound!, "round 24 is not overtime");

    const inOvertime = snapshotOf(
      stateOf([...events, stream.ev("round", { number: 25, phase: "shopping" })]),
    ).match!;

    assert.equal(inOvertime.round.number, 25);
    assert.ok(inOvertime.round.number >= inOvertime.thresholds.overtimeFromRound!, "round 25 is overtime");
  });

  const winReasons: { reason: RoundWinReason; winner: TeamId; todo?: string }[] = [
    { reason: "detonated", winner: 0 },
    { reason: "defused", winner: 1 },
    {
      reason: "elimination",
      winner: 0,
      todo: "state.ts roundWinReason() records 'unknown': elimination is not derivable from the current event catalog",
    },
    {
      reason: "timeout",
      winner: 1,
      todo: "state.ts roundWinReason() records 'unknown': timeout is not derivable from the current event catalog",
    },
  ];

  for (const { reason, winner, todo } of winReasons) {
    it(`records the win reason "${reason}" in the round history`, todo ? { todo } : {}, () => {
      const stream = new Stream();
      const match = snapshotOf(stateOf([...stream.start(), ...stream.playRound(winner, reason)])).match!;

      // roundHistory is the Match's full history, copied onto both teams.
      assert.deepEqual(match.teams[0].roundHistory.map(({ roundNumber, winningTeamId, reason }) => ({
        roundNumber,
        winningTeamId,
        reason,
      })), [{ roundNumber: 1, winningTeamId: winner, reason }]);
      assert.deepEqual(match.teams[1].roundHistory, match.teams[0].roundHistory);
      assert.equal(match.teams[winner].roundsWon, 1);
    });
  }

  it("every recorded reason is one of the protocol's win reasons across a 26-round replay", () => {
    const stream = new Stream();
    const match = snapshotOf(stateOf([...stream.start(), ...stream.alternating(26)])).match!;
    const allowed = new Set<RoundWinReason>(["detonated", "defused", "timeout", "elimination", "unknown"]);

    assert.equal(match.teams[0].roundHistory.length, 26);
    match.teams[0].roundHistory.forEach((result, i) => {
      assert.equal(result.roundNumber, i + 1, "history is ordered with no gaps");
      assert.ok(allowed.has(result.reason));
    });
  });
});

// ---------------------------------------------------------------------------
// Match: duplicates, stale resends, late events
// ---------------------------------------------------------------------------

describe("replay: duplicate and stale events", () => {
  it("suppresses a duplicate eventId without changing state", () => {
    const stream = new Stream();
    const events = [...stream.start(), ...stream.playRound(0, "detonated")];
    const { match } = liveMatch();

    for (const event of events) match.append(event);
    const before = structuredClone(match.state);

    assert.equal(match.append(events.at(-1)!), "duplicate");
    assert.deepEqual(match.state, before);
    assert.equal(match.events.length, events.length);
    assert.equal(match.state.roundsWon[0], 1, "score not double counted");
  });

  it("ignores a stale resend of an already-applied prefix (reconnect replay)", () => {
    const stream = new Stream();
    const events = [...stream.start(), ...stream.alternating(6)];
    const { match } = liveMatch();

    for (const event of events) match.append(event);
    const before = structuredClone(match.state);

    const resent = events.slice(0, Math.floor(events.length / 2)).map((event) => match.append(event));

    assert.ok(resent.every((result) => result === "duplicate"));
    assert.deepEqual(match.state, before);
    assert.equal(match.events.length, events.length);
  });

  it("applies a late event in capture order, ending in the same state as in-order delivery", () => {
    const stream = new Stream();
    const events = [...stream.start(), ...stream.alternating(4)];
    const late = events.findIndex((e) => e.type === "spike" && e.payload.action === "detonated");
    assert.ok(late > 0);

    const { match } = liveMatch();
    for (const [i, event] of events.entries()) {
      if (i !== late) match.append(event);
    }
    match.append(events[late]!); // arrives after everything else

    assert.deepEqual(match.state, stateOf(events));
    assert.deepEqual(match.events.map((e) => e.eventId), events.map((e) => e.eventId));
    assert.equal(match.state.roundHistory[0]?.reason, "detonated");
  });

  it("converges to the same state when the whole stream arrives in reverse", () => {
    const stream = new Stream();
    const events = [...stream.start(), ...stream.alternating(6)];
    const { match } = liveMatch();

    for (const event of [...events].reverse()) match.append(event);

    assert.deepEqual(match.state, stateOf(events));
  });
});

// ---------------------------------------------------------------------------
// Broadcaster (mock timers: setTimeout + Date)
// ---------------------------------------------------------------------------

describe("replay: broadcast pushes", () => {
  afterEach(() => mock.timers.reset());

  it("sends an immediate full snapshot of current state to a late subscriber", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
    const registry = new MatchRegistry();
    const broadcaster = new Broadcaster(registry, options);
    const claim = registry.claim(GROUP, OBSERVER);
    assert.ok(claim.ok);

    const stream = new Stream();
    for (const event of [...stream.start(), ...stream.alternating(5)]) claim.match.append(event);

    const subscriber = recorder();
    broadcaster.subscribe(GROUP, subscriber);

    assert.equal(subscriber.received.length, 1, "exactly one immediate snapshot");
    const [{ snapshot }] = subscriber.received as [Received];
    assert.equal(snapshot.match?.round.number, 5);
    assert.deepEqual(snapshot, JSON.parse(JSON.stringify(broadcaster.snapshot(GROUP))));
    broadcaster.close();
  });

  it("never pushes more than 10 times in any 1 s window, and still delivers the final state", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
    const registry = new MatchRegistry();
    const broadcaster = new Broadcaster(registry, options); // default interval = the shipped cap
    const claim = registry.claim(GROUP, OBSERVER);
    assert.ok(claim.ok);
    const subscriber = recorder();
    broadcaster.subscribe(GROUP, subscriber);

    const stream = new Stream();
    for (const event of stream.start()) claim.match.append(event);
    mock.timers.tick(200);

    // 400 distinct changes at 200 Hz for 2 simulated seconds.
    for (let i = 0; i < 400; i += 1) {
      claim.match.append(stream.ev("observing", { puuid: i % 2 === 0 ? "p0" : "p5" }));
      mock.timers.tick(5);
    }
    mock.timers.tick(200); // flush the trailing push

    const pushes = subscriber.received.slice(1); // minus the immediate snapshot
    assert.ok(pushes.length > 10, `expected sustained pushing, got ${pushes.length}`);
    assert.ok(pushes.length < 100, `expected coalescing, got ${pushes.length} pushes for 400 changes`);

    for (const [i, push] of pushes.entries()) {
      const inWindow = pushes.filter((p) => p.atMs >= push.atMs && p.atMs < push.atMs + 1000);
      assert.ok(inWindow.length <= 10, `${inWindow.length} pushes in 1 s starting at push ${i}`);
    }

    const observed = subscriber.received
      .at(-1)!
      .snapshot.match!.teams.flatMap((team) => team.players)
      .filter((player) => player.observed)
      .map((player) => player.puuid);
    assert.deepEqual(observed, ["p5"], "the final state was delivered");
    assertSequenceRule(subscriber.received.map((r) => r.snapshot));
    broadcaster.close();
  });

  it("does not push for a duplicate event", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
    const registry = new MatchRegistry();
    const broadcaster = new Broadcaster(registry, options);
    const claim = registry.claim(GROUP, OBSERVER);
    assert.ok(claim.ok);
    const subscriber = recorder();
    broadcaster.subscribe(GROUP, subscriber);

    const stream = new Stream();
    for (const event of stream.start()) claim.match.append(event);
    const observing = stream.ev("observing", { puuid: "p0" });
    claim.match.append(observing);
    mock.timers.tick(300);

    const count = subscriber.received.length;
    const sequence = subscriber.received.at(-1)!.snapshot.sequence;

    claim.match.append(observing); // duplicate
    mock.timers.tick(300);

    assert.equal(subscriber.received.length, count, "duplicate caused a push");
    assert.equal(broadcaster.snapshot(GROUP).sequence, sequence, "duplicate advanced the sequence");
    broadcaster.close();
  });

  it("keeps sequence monotonic per Match across a 26-round replay and restarts it for a new Match", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
    const registry = new MatchRegistry();
    const broadcaster = new Broadcaster(registry, options);
    const subscriber = recorder();
    broadcaster.subscribe(GROUP, subscriber);

    const first = registry.claim(GROUP, OBSERVER);
    assert.ok(first.ok);
    const one = new Stream();
    for (const event of [...one.start(), ...one.alternating(26)]) {
      first.match.append(event);
      mock.timers.tick(150);
    }
    registry.remove(first.match);
    mock.timers.tick(150);

    const second = registry.claim(GROUP, OBSERVER);
    assert.ok(second.ok);
    const two = new Stream();
    for (const event of [...two.start(), ...two.alternating(3)]) {
      second.match.append(event);
      mock.timers.tick(150);
    }
    mock.timers.tick(300);

    const snapshots = subscriber.received.map((r) => r.snapshot);
    assertSequenceRule(snapshots);
    assert.ok(snapshots.some((s) => s.matchId === first.match.matchId));
    assert.ok(snapshots.some((s) => s.matchId === second.match.matchId));
    assert.notEqual(first.match.matchId, second.match.matchId);

    // Every push is a complete snapshot, not a partial update.
    const keys = Object.keys(snapshots[0]!).sort();
    for (const snapshot of snapshots) assert.deepEqual(Object.keys(snapshot).sort(), keys);
    broadcaster.close();
  });

  it("carries no credentials, Match Secret or Observer details in any push of a 26-round replay", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
    const registry = new MatchRegistry();
    const production = {
      ...DEFAULT_PRODUCTION,
      tournament: { ...DEFAULT_PRODUCTION.tournament, logoUrl: "https://admin:hunter2@cdn.example/logo.png" },
      sponsors: [{ name: "Sponsor", logoUrl: "https://user:hunter2@cdn.example/s.png", durationMs: 5000 }],
    };
    const broadcaster = new Broadcaster(registry, { ...options, production });
    const claim = registry.claim(GROUP, OBSERVER);
    assert.ok(claim.ok);
    const subscriber = recorder();
    broadcaster.subscribe(GROUP, subscriber);

    const stream = new Stream();
    for (const event of [...stream.start(), ...stream.alternating(26)]) {
      claim.match.append(event);
      mock.timers.tick(150);
    }

    assert.ok(subscriber.received.length > 10);
    for (const { snapshot } of subscriber.received) {
      assertNoCredentials(snapshot, [claim.match.secret, "hunter2", OBSERVER.name]);
    }
    broadcaster.close();
  });
});

// ---------------------------------------------------------------------------
// End to end over real WebSockets
// ---------------------------------------------------------------------------

describe("replay: end to end over WebSockets", () => {
  const AUTH_KEY = "t3-auth-key-value";
  const registry = new MatchRegistry();
  const config: ServerConfig = {
    port: 0,
    broadcastPort: 0,
    authKey: AUTH_KEY,
    capabilities: DEFAULT_CAPABILITIES,
  };
  let ingest: WebSocketServer;
  let broadcast: WebSocketServer;

  const urlOf = (server: WebSocketServer, path = ""): string => {
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    return `ws://127.0.0.1:${address.port}${path}`;
  };

  before(async () => {
    ingest = await startIngestServer(config, registry);
    broadcast = await startBroadcastServer(config, new Broadcaster(registry, options));
  });

  after(async () => {
    for (const server of [ingest, broadcast]) {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sends an immediate snapshot, then monotonic complete pushes, with no auth key or Match Secret", async () => {
    const frontend = new WebSocket(urlOf(broadcast, "/?groupCode=t3_ws"));
    const frames: string[] = [];
    frontend.on("message", (data) => frames.push(data.toString()));
    const snapshots = (): BroadcastSnapshot[] => frames.map((f) => JSON.parse(f) as BroadcastSnapshot);

    await waitFor(() => frames.length === 1);
    assert.equal(snapshots()[0]?.match, null, "immediate idle snapshot");
    assert.equal(snapshots()[0]?.matchId, null);

    const observer = new WebSocket(urlOf(ingest));
    await once(observer, "open");
    observer.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        groupCode: "t3_ws",
        observerName: OBSERVER.name,
        clientVersion: OBSERVER.clientVersion,
        authKey: AUTH_KEY,
      }),
    );
    const [reply] = (await once(observer, "message")) as [Buffer];
    const logon = JSON.parse(reply.toString()) as { accepted: boolean; matchSecret: string };
    assert.ok(logon.accepted, "logon accepted");

    const stream = new Stream();
    const events = [...stream.start(), ...stream.alternating(26)];
    for (const event of events) observer.send(JSON.stringify(event));

    await waitFor(() => {
      const last = snapshots().at(-1)?.match;
      return last?.round.number === 26 && last.round.phase === "end";
    });

    const all = snapshots();
    const final = all.at(-1)!.match!;
    assert.deepEqual(final.teams.map((team) => team.roundsWon), [13, 13]);
    assert.equal(final.teams[0].roundHistory.length, 26);
    assert.ok(all.length < events.length, "pushes were coalesced rather than one per event");
    assertSequenceRule(all);
    for (const snapshot of all) {
      assertNoCredentials(snapshot, [AUTH_KEY, logon.matchSecret, OBSERVER.name]);
    }

    observer.close();
    frontend.close();
  });
});