const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFileOutbox } = require('../dist/outbox.js');

function event(eventId) {
  return {
    protocolVersion: 1,
    eventId,
    type: 'scene',
    capturedAt: new Date().toISOString(),
    payload: { scene: 'in_game' }
  };
}

async function withTempDir(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obvs-outbox-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('persists and reloads the ordered outbox and match secret', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'outbox.json');
    const store = createFileOutbox(() => file);

    store.save({
      serverUrl: 'https://example.test/ingest',
      groupCode: 'group_1',
      matchSecret: 'secret-1',
      events: [event('a'), event('b')]
    });
    await store.flush();

    const loaded = await createFileOutbox(() => file).load();
    assert.equal(loaded.serverUrl, 'https://example.test/ingest');
    assert.equal(loaded.groupCode, 'group_1');
    assert.equal(loaded.matchSecret, 'secret-1');
    assert.deepEqual(loaded.events.map((entry) => entry.eventId), ['a', 'b']);

    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, 0o600, 'outbox must stay owner-only');

    store.clear();
    await store.flush();
    assert.equal(await createFileOutbox(() => file).load(), null);
  });
});

test('ignores a corrupt outbox instead of failing startup', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'outbox.json');
    await fs.writeFile(file, '{not json');

    assert.equal(await createFileOutbox(() => file).load(), null);
  });
});

test('drops malformed stored events', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'outbox.json');
    await fs.writeFile(file, JSON.stringify({
      serverUrl: 'https://example.test/ingest',
      groupCode: 'group_1',
      matchSecret: 'secret-1',
      events: [event('a'), { eventId: 'missing-fields' }]
    }));

    const loaded = await createFileOutbox(() => file).load();
    assert.deepEqual(loaded.events.map((entry) => entry.eventId), ['a']);
  });
});
