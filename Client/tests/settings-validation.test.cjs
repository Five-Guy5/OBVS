const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_HOTKEYS,
  normalizeHotkeys,
  validateSettings
} = require('../dist/settings.js');

const valid = {
  serverUrl: 'https://example.test/ingest',
  groupCode: 'group_1',
  displayName: 'Observer',
  authKey: 'secret'
};

function errorsFor(patch = {}) {
  return validateSettings({ ...valid, ...patch }).errors;
}

for (const field of ['serverUrl', 'groupCode', 'displayName']) {
  for (const value of ['', '   ']) {
    test(`${field} = ${JSON.stringify(value)} errors on ${field} only`, () => {
      const errors = errorsFor({ [field]: value });
      assert.deepEqual(Object.keys(errors), [field]);
      assert.match(errors[field], /required/i);
    });
  }
}

test('multiple empty fields each get their own error', () => {
  const errors = errorsFor({ serverUrl: '', groupCode: '', displayName: '' });
  assert.deepEqual(Object.keys(errors).sort(), ['displayName', 'groupCode', 'serverUrl']);
});

test('an error on one field does not blame the others', () => {
  const errors = errorsFor({ groupCode: 'bad.code' });
  assert.deepEqual(Object.keys(errors), ['groupCode']);
});

test('non-string field values are rejected per field', () => {
  const result = validateSettings({ ...valid, serverUrl: 123, authKey: null });
  assert.equal(result.data, null);
  assert.match(result.errors.serverUrl, /must be text/);
  assert.match(result.errors.authKey, /must be text/);
});

test('invalid input is never reported as clean', () => {
  const result = validateSettings({ ...valid, serverUrl: '' });
  assert.notDeepEqual(result.errors, {});
});

test('hotkeys default when omitted and accept accelerator text', () => {
  assert.deepEqual(validateSettings(valid).data.hotkeys, DEFAULT_HOTKEYS);

  const custom = { ...DEFAULT_HOTKEYS, techPause: 'Control+Alt+T' };
  const result = validateSettings({ ...valid, hotkeys: custom });
  assert.deepEqual(result.errors, {});
  assert.equal(result.data.hotkeys.techPause, 'Control+Alt+T');
});

test('rejects malformed and duplicate hotkeys', () => {
  const malformed = validateSettings({
    ...valid,
    hotkeys: { ...DEFAULT_HOTKEYS, techPause: 'Control Shift 1' }
  });
  assert.match(malformed.errors.hotkeys, /accelerator/i);

  const duplicate = validateSettings({
    ...valid,
    hotkeys: { ...DEFAULT_HOTKEYS, timeoutLeft: DEFAULT_HOTKEYS.techPause }
  });
  assert.match(duplicate.errors.hotkeys, /different/i);
});

test('normalizeHotkeys falls back to defaults for unusable entries', () => {
  const normalized = normalizeHotkeys({
    techPause: 'Control+Alt+T',
    timeoutLeft: 'bad key',
    timeoutRight: 'control+alt+t',
    spikePlanted: 42
  });

  assert.equal(normalized.techPause, 'Control+Alt+T');
  assert.equal(normalized.timeoutLeft, DEFAULT_HOTKEYS.timeoutLeft);
  assert.equal(normalized.timeoutRight, DEFAULT_HOTKEYS.timeoutRight);
  assert.equal(normalized.spikePlanted, DEFAULT_HOTKEYS.spikePlanted);
});