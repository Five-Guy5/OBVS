const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('renderer bundle is a classic browser script', () => {
  const renderer = fs.readFileSync(
    path.join(__dirname, '..', 'dist', 'renderer.js'),
    'utf8'
  );

  assert.ok(
    !renderer.includes('Object.defineProperty(exports'),
    'renderer.js must not be compiled as a CommonJS module'
  );
  assert.ok(
    !renderer.includes('require('),
    'renderer.js must not call require() in the renderer process'
  );
});
