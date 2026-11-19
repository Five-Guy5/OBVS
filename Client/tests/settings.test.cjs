const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateSettings } = require('../dist/settings.js');

const valid = {
  serverUrl: 'https://example.test/ingest',
  groupCode: 'group_1',
  displayName: 'Observer',
  authKey: 'secret'
};

function errorsFor(patch = {}, allowInsecure = false) {
  return validateSettings({ ...valid, ...patch }, allowInsecure).errors;
}

function assertNoErrors(errors) {
  assert.deepEqual(errors, {});
}

test('accepts HTTPS and WSS URLs', () => {
  assertNoErrors(errorsFor());
  assertNoErrors(errorsFor({ serverUrl: 'wss://example.test/ingest' }));
});

test('rejects HTTP and WS by default', () => {
  assert.match(errorsFor({ serverUrl: 'http://localhost:3000' }).serverUrl, /HTTPS or WSS/);
  assert.match(errorsFor({ serverUrl: 'ws://localhost:3000' }).serverUrl, /HTTPS or WSS/);
});

test('allows non-TLS only for loopback with the dev flag', () => {
  assertNoErrors(errorsFor({ serverUrl: 'http://localhost:3000' }, true));
  assertNoErrors(errorsFor({ serverUrl: 'http://127.0.0.1:3000' }, true));
  assertNoErrors(errorsFor({ serverUrl: 'ws://[::1]:3000' }, true));
  assert.match(
    errorsFor({ serverUrl: 'http://example.test' }, true).serverUrl,
    /localhost in development/
  );
});

test('rejects credentials, query strings, and fragments', () => {
  assert.match(
    errorsFor({ serverUrl: 'https://user:pass@example.test' }).serverUrl,
    /credentials/
  );
  assert.match(
    errorsFor({ serverUrl: 'https://example.test/?authKey=secret' }).serverUrl,
    /query/
  );
  assert.match(
    errorsFor({ serverUrl: 'https://example.test/#fragment' }).serverUrl,
    /fragments/
  );
});

test('accepts a blank auth key', () => {
  assertNoErrors(errorsFor({ authKey: '' }));
});

test('rejects malformed auth keys', () => {
  assert.match(errorsFor({ authKey: '   ' }).authKey, /nonblank/);
  assert.match(errorsFor({ authKey: 'a\nb' }).authKey, /single line/);
  assert.match(errorsFor({ authKey: 'a'.repeat(1025) }).authKey, /max 1024/);
});

test('rejects malformed group codes and display names', () => {
  assert.match(errorsFor({ groupCode: 'bad.code' }).groupCode, /letters, digits/);
  assert.match(errorsFor({ displayName: 'bad\u0001name' }).displayName, /control/);
});

test('rejects non-object input', () => {
  const result = validateSettings(null);
  assert.equal(result.data, null);
  assert.ok(result.errors.serverUrl);
});
