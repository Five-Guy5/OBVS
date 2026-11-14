const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAIN = require.resolve('../dist/main.js');
const SECRET = 'TEST-KEY-12345';
const valid = {
  serverUrl: 'https://example.test/ingest',
  groupCode: 'group_1',
  displayName: 'Observer',
  authKey: SECRET
};

let userData;
const credentialStore = new Map(); // stands in for the OS credential store, survives "restarts"

const fakeKeytar = {
  getPassword: async (service, account) => {
    return credentialStore.get(`${service}:${account}`) ?? null;
  },
  setPassword: async (service, account, password) => {
    credentialStore.set(`${service}:${account}`, password);
  },
  deletePassword: async (service, account) => {
    return credentialStore.delete(`${service}:${account}`);
  }
};

// Starts a fresh copy of the app's main process with electron and keytar faked.
async function launchApp() {
  const handlers = {};
  let win;
  class FakeWindow {
    constructor() {
      win = this;
      this.webContents = { setWindowOpenHandler() {}, on() {} };
    }
    setMenuBarVisibility() {}
    loadFile() { return Promise.resolve(); }
    on() {}
    static getAllWindows() { return []; }
  }
  const fakeElectron = {
    app: {
      isPackaged: false,
      getPath: () => userData,
      whenReady: () => Promise.resolve(),
      on() {},
      quit() {}
    },
    BrowserWindow: FakeWindow,
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }
  };

  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return fakeElectron;
    if (request === 'keytar') return fakeKeytar;
    return realLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[MAIN]; // fresh module state, like a real restart
    require(MAIN);
    await new Promise((resolve) => setImmediate(resolve)); // let app.whenReady().then(...) run
  } finally {
    Module._load = realLoad;
  }

  const call = (name, ...args) => handlers[name]({ sender: win.webContents }, ...args);
  return { save: (input) => call('settings:save', input), load: () => call('settings:load') };
}

function allFilesText() {
  return fs.readdirSync(userData)
    .map((name) => fs.readFileSync(path.join(userData, name), 'utf8'))
    .join('\n');
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'obvs-test-'));
  credentialStore.clear();
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

test('auth key is not written to disk in plain text', async () => {
  const app = await launchApp();
  assert.deepEqual(await app.save(valid), { ok: true });

  assert.ok(!allFilesText().includes(SECRET), 'secret found in a file on disk');
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  assert.ok(!('authKey' in saved));
  assert.equal([...credentialStore.values()][0], SECRET, 'key should be in the credential store');
});

test('settings and key survive a restart', async () => {
  const first = await launchApp();
  assert.deepEqual(await first.save(valid), { ok: true });

  const second = await launchApp(); // new process, same disk and credential store
  const loaded = await second.load();
  assert.equal(loaded.serverUrl, valid.serverUrl);
  assert.equal(loaded.groupCode, valid.groupCode);
  assert.equal(loaded.displayName, valid.displayName);
  assert.equal(loaded.hasAuthKey, true);
  assert.ok(!JSON.stringify(loaded).includes(SECRET), 'load must not return the secret');
});

test('invalid settings are rejected and nothing is saved', async () => {
  const app = await launchApp();
  const result = await app.save({ ...valid, serverUrl: '' });
  assert.equal(result.ok, false);
  assert.match(result.errors.serverUrl, /required/i);
  assert.equal(fs.existsSync(path.join(userData, 'settings.json')), false);
  assert.equal(credentialStore.size, 0);
});

test('blank auth key keeps the stored key', async () => {
  const app = await launchApp();
  await app.save(valid);
  assert.deepEqual(await app.save({ ...valid, displayName: 'Renamed', authKey: '' }), { ok: true });

  const loaded = await app.load();
  assert.equal(loaded.displayName, 'Renamed');
  assert.equal(loaded.hasAuthKey, true);
  assert.equal([...credentialStore.values()][0], SECRET);
});

test('first-time save with a blank key succeeds with no key stored', async () => {
  // README documents the auth key as optional for open-ingest servers.
  const app = await launchApp();
  assert.deepEqual(await app.save({ ...valid, authKey: '' }), { ok: true });
  assert.equal((await app.load()).hasAuthKey, false);
});