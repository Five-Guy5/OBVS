const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Session } = require('../dist/session.js');

const config = {
  serverUrl: 'https://example.test/ingest',
  groupCode: 'group_1',
  displayName: 'Observer',
  authKey: 'secret'
};

const accepted = {
  accepted: true,
  matchSecret: 'match-secret',
  capabilities: {
    gep: true,
    cv: { enabled: false, modelsLoaded: false },
    fields: {}
  }
};

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  receive(value) {
    this.emit('message', { data: JSON.stringify(value) });
  }
}

function createSession(options = {}) {
  const sockets = [];
  const changes = [];
  const session = new Session({
    clientVersion: '0.1.0',
    allowInsecure: options.allowInsecure ?? false,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onChange: (status) => changes.push(status)
  });
  session.setConfig(options.config ?? config);
  return { session, sockets, changes };
}

function goLive(session, sockets) {
  session.handleInfo({ feature: 'game_info', key: 'scene', value: 'CharacterSelectPersistentLevel' });
  const socket = sockets.at(-1);
  socket.open();
  socket.receive(accepted);
  return socket;
}

test('ignores the main menu and practice range', () => {
  const { session, sockets } = createSession();

  session.handleInfo({ feature: 'game_info', key: 'scene', value: 'MainMenu' });
  session.handleInfo({ feature: 'game_info', key: 'scene', value: 'Range' });

  assert.equal(session.status.state, 'idle');
  assert.equal(sockets.length, 0);
});

test('connects at agent select and logs on without a match secret', () => {
  const { session, sockets, changes } = createSession();

  session.handleInfo({ feature: 'game_info', key: 'scene', value: 'CharacterSelectPersistentLevel' });
  assert.equal(session.status.state, 'connecting');
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'wss://example.test/ingest');

  sockets[0].open();
  assert.deepEqual(sockets[0].sent[0], {
    protocolVersion: 1,
    groupCode: 'group_1',
    observerName: 'Observer',
    clientVersion: '0.1.0',
    authKey: 'secret'
  });

  sockets[0].receive(accepted);
  assert.equal(session.status.state, 'live');
  assert.deepEqual(changes.map((status) => status.state), ['connecting', 'live']);
});

test('relays every GEP update with its capture timestamp', () => {
  const { session, sockets } = createSession();
  const socket = goLive(session, sockets);
  const before = socket.sent.length;

  session.handleInfo({ feature: 'match_info', key: 'round_number', value: '3' });
  session.handleInfo({ feature: 'match_info', key: 'round_phase', value: 'combat' });
  session.handleEvent({ feature: 'match_info', key: 'kill_feed', value: { attacker: 'Ace' } });

  const events = socket.sent.slice(before);
  assert.ok(events.length >= 3);
  assert.ok(events.every((event) => !Number.isNaN(Date.parse(event.capturedAt))));

  const kill = events.find((event) => event.type === 'gep.raw' &&
    event.payload.key === 'kill_feed');
  assert.deepEqual(kill.payload.value, { attacker: 'Ace' });
  assert.equal(kill.payload.timestamp, kill.capturedAt);

  const round = events.find((event) => event.type === 'round');
  assert.deepEqual(round.payload, { number: 3, phase: 'combat' });
});

test('relays native-style payloads that carry data instead of value', () => {
  const { session, sockets } = createSession();
  const socket = goLive(session, sockets);
  const before = socket.sent.length;

  session.handleInfo({ feature: 'me', key: 'health', data: '100' });
  session.handleEvent({ feature: 'match_info', key: 'shop', data: 'open' });

  const events = socket.sent.slice(before).filter((event) => event.type === 'gep.raw');
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].payload, {
    feature: 'me',
    key: 'health',
    value: '100',
    timestamp: events[0].capturedAt
  });
  assert.deepEqual(events[1].payload, {
    feature: 'match_info',
    key: 'shop',
    value: 'open',
    timestamp: events[1].capturedAt
  });
});

test('stops at game_end and discards the match secret', () => {
  const { session, sockets, changes } = createSession();
  const socket = goLive(session, sockets);
  const before = socket.sent.length;

  session.handleInfo({ feature: 'match_info', key: 'round_phase', value: 'game_end' });

  assert.equal(session.status.state, 'idle');
  assert.deepEqual(changes.map((status) => status.state).slice(-2), ['stopping', 'idle']);
  assert.ok(socket.sent.slice(before).some((event) => event.type === 'match.end'));

  session.connect();
  const next = sockets.at(-1);
  next.open();
  assert.equal('matchSecret' in next.sent[0], false);
});

test('manual disconnect keeps the secret for a mid-match reconnect', () => {
  const { session, sockets } = createSession();
  goLive(session, sockets);

  session.disconnect();
  assert.equal(session.status.state, 'idle');

  session.connect();
  const next = sockets.at(-1);
  next.open();
  assert.equal(next.sent[0].matchSecret, 'match-secret');
});

test('manual disconnect suppresses the same match but not the next one', () => {
  const { session, sockets } = createSession();
  goLive(session, sockets);

  session.disconnect();
  const count = sockets.length;

  session.handleInfo({ feature: 'game_info', key: 'scene', value: 'in_game' });
  assert.equal(session.status.state, 'idle');
  assert.equal(sockets.length, count);

  session.handleInfo({ feature: 'game_info', key: 'scene', value: 'MainMenu' });
  session.handleInfo({ feature: 'game_info', key: 'scene', value: 'CharacterSelectPersistentLevel' });
  assert.equal(session.status.state, 'connecting');
  assert.equal(sockets.length, count + 1);

  const next = sockets.at(-1);
  next.open();
  assert.equal('matchSecret' in next.sent[0], false);
});

test('a rejected logon shows the reason and stays disconnected', () => {
  const { session, sockets } = createSession();

  session.handleInfo({ feature: 'game_info', key: 'scene', value: 'CharacterSelectPersistentLevel' });
  const socket = sockets[0];
  socket.open();
  socket.receive({ accepted: false, reason: 'Auth key rejected.' });

  assert.deepEqual(session.status, { state: 'idle', error: 'Auth key rejected.' });
  assert.equal(socket.readyState, 3);
});

test('a manual connect without settings stays idle with an error', () => {
  const session = new Session({
    clientVersion: '0.1.0',
    allowInsecure: false,
    createSocket: () => {
      throw new Error('should not create a socket');
    }
  });

  session.connect();

  assert.deepEqual(session.status, {
    state: 'idle',
    error: 'Save connection settings before connecting.'
  });
});

test('rejects non-TLS unless the dev flag allows a loopback host', () => {
  const secureOnly = createSession({
    config: { ...config, serverUrl: 'http://127.0.0.1:3000' }
  });
  secureOnly.session.connect();
  assert.equal(secureOnly.session.status.state, 'idle');
  assert.match(secureOnly.session.status.error, /HTTPS or WSS/);
  assert.equal(secureOnly.sockets.length, 0);

  const insecure = createSession({
    allowInsecure: true,
    config: { ...config, serverUrl: 'http://127.0.0.1:3000' }
  });
  insecure.session.connect();
  assert.equal(insecure.session.status.state, 'connecting');
  assert.equal(insecure.sockets[0].url, 'ws://127.0.0.1:3000/');
});

test('an automatic session stops when the game returns to the menu', () => {
  const { session, sockets } = createSession();
  goLive(session, sockets);

  session.handleInfo({ feature: 'game_info', key: 'scene', value: 'MainMenu' });

  assert.equal(session.status.state, 'idle');
  assert.equal(sockets[0].readyState, 3);
});

test('a manual session stays live in the menu', () => {
  const { session, sockets } = createSession();

  session.connect();
  const socket = sockets[0];
  socket.open();
  socket.receive(accepted);
  session.handleInfo({ feature: 'game_info', key: 'scene', value: 'MainMenu' });

  assert.equal(session.status.state, 'live');
  assert.equal(socket.readyState, 1);
});

test('a match_start does not connect while in the practice range', () => {
  const { session, sockets } = createSession();

  session.handleInfo({ feature: 'game_info', key: 'scene', value: 'Range' });
  session.handleEvent({ feature: 'match_info', key: 'match_start', value: null });

  assert.equal(session.status.state, 'idle');
  assert.equal(sockets.length, 0);
});

test('does not reuse a previous round after a new match', () => {
  const { session, sockets } = createSession();
  goLive(session, sockets);
  session.handleInfo({ feature: 'match_info', key: 'round_number', value: '5' });
  session.handleInfo({ feature: 'match_info', key: 'round_phase', value: 'game_end' });
  assert.equal(session.status.state, 'idle');

  session.handleInfo({ feature: 'game_info', key: 'scene', value: 'MainMenu' });
  session.handleInfo({ feature: 'game_info', key: 'scene', value: 'CharacterSelectPersistentLevel' });
  const next = sockets.at(-1);
  next.open();
  next.receive(accepted);
  const before = next.sent.length;

  session.handleInfo({ feature: 'match_info', key: 'round_number', value: '1' });
  assert.equal(next.sent.slice(before).some((event) => event.type === 'round'), false);

  session.handleInfo({ feature: 'match_info', key: 'round_phase', value: 'shopping' });
  const round = next.sent.slice(before).find((event) => event.type === 'round');
  assert.deepEqual(round.payload, { number: 1, phase: 'shopping' });
});
