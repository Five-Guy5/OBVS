const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateSettings } = require('../dist/settings.js');

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