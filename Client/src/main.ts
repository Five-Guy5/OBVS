import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import type { ManualAction } from '@obvs/protocol';
import * as keytar from 'keytar';
import { userInfo } from 'node:os';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileOutbox } from './outbox';
import {
  Session,
  type GepUpdate,
  type SessionConfig,
  type SessionStatus,
  type SocketLike,
} from './session';
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  normalizeHotkeys,
  validateSettings,
  type HotkeyAction,
  type HotkeyBindings,
  type PublicSettings,
  type SaveResult,
} from './settings';

const SERVICE = 'io.obvs.client';
const ACCOUNT = 'server-auth-key';
// Non-TLS is a local-development escape hatch, never available in packaged builds.
const ALLOW_INSECURE_URL = !app.isPackaged && process.env.OBVS_ALLOW_INSECURE_URL === '1';
const VALORANT_GAME_ID = 21640; // kGepSupportedGameIds.VALORANT
const GEP_FEATURES = ['match_info', 'me', 'game_info', 'kill', 'death'];
const TOAST_WIDTH = 360;
const TOAST_HEIGHT = 64;
const TOAST_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; background: #111; color: #fff; font: 14px system-ui, sans-serif; }
#toast { padding: 20px 24px; text-align: center; }
</style></head><body><div id="toast"></div></body></html>`;

const MANUAL_ACTIONS: Record<
  HotkeyAction,
  { action: ManualAction; sent: string; queued: string }
> = {
  techPause: {
    action: 'tech_pause_toggle',
    sent: 'Tech pause toggled',
    queued: 'Tech pause queued'
  },
  timeoutLeft: { action: 'timeout_left', sent: 'Left timeout sent', queued: 'Left timeout queued' },
  timeoutRight: {
    action: 'timeout_right',
    sent: 'Right timeout sent',
    queued: 'Right timeout queued'
  },
  spikePlanted: {
    action: 'spike_planted',
    sent: 'Spike planted sent',
    queued: 'Spike planted queued'
  },
};

let mainWindow: BrowserWindow | null = null;
let toastWindow: BrowserWindow | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let currentHotkeys: HotkeyBindings = { ...DEFAULT_HOTKEYS };
let hotkeyWarning: string | undefined;
let lastWarning: string | null = null;
let saving = false;
let gepListening = false;
let gepAttached = false;
let sessionRestored = false;
const pendingGep: Array<{ kind: 'info' | 'event'; update: GepUpdate }> = [];

const outbox = createFileOutbox(() => join(app.getPath('userData'), 'outbox.json'));

const session = new Session({
  clientVersion: app.getVersion(),
  allowInsecure: ALLOW_INSECURE_URL,
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  onChange: publishStatus,
  outbox,
});

// Register before app readiness so Valorant is detected if it is already running.
setupGep();

interface GepLaunchEvent {
  enable(): void;
}

interface GepApi {
  on(event: 'game-detected', listener: (event: GepLaunchEvent, gameId: number) => void): void;
  on(event: 'new-info-update',
    listener: (event: unknown, gameId: number, data: GepUpdate) => void): void;
  on(event: 'new-game-event',
    listener: (event: unknown, gameId: number, data: GepUpdate) => void): void;
  on(event: 'error', listener: (event: unknown, gameId: number, error: string) => void): void;
  setRequiredFeatures(gameId: number, features: string[] | undefined): Promise<void>;
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json');
}

async function readSettings(): Promise<PublicSettings | null> {
  let text: string;
  try {
    text = await readFile(settingsFile(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object') throw new Error('Invalid settings file.');
  const s = data as Record<string, unknown>;
  if (typeof s.serverUrl !== 'string' ||
      typeof s.groupCode !== 'string' ||
      typeof s.displayName !== 'string') {
    throw new Error('Invalid settings file.');
  }
  return {
    serverUrl: s.serverUrl,
    groupCode: s.groupCode,
    displayName: s.displayName,
    hotkeys: normalizeHotkeys(s.hotkeys),
  };
}

async function loadSettings() {
  let stored: PublicSettings | null = null;
  let warning: string | undefined;
  try {
    stored = await readSettings();
  } catch {
    warning = 'The saved settings file could not be read. Enter values and save to replace it.';
  }
  const hasAuthKey = (await keytar.getPassword(SERVICE, ACCOUNT)) !== null;
  let defaultName = 'Observer';
  try { defaultName = userInfo().username.slice(0, 64) || 'Observer'; } catch { /* fallback */ }
  return {
    serverUrl: stored?.serverUrl ?? '',
    groupCode: stored?.groupCode ?? '',
    displayName: stored?.displayName ?? defaultName,
    hotkeys: stored?.hotkeys ?? { ...DEFAULT_HOTKEYS },
    hasAuthKey, // Never send the stored secret back to the UI.
    warning: [warning, hotkeyWarning].filter(Boolean).join(' ') || undefined
  };
}

async function refreshSessionConfig(): Promise<PublicSettings | null> {
  try {
    const stored = await readSettings();
    if (!stored) {
      session.setConfig(null);
      return null;
    }
    const authKey = (await keytar.getPassword(SERVICE, ACCOUNT)) ?? '';
    const config: SessionConfig = {
      serverUrl: stored.serverUrl,
      groupCode: stored.groupCode,
      displayName: stored.displayName,
      authKey,
    };
    session.setConfig(config);
    return stored;
  } catch {
    session.setConfig(null);
    return null;
  }
}

function publishStatus(status: SessionStatus): void {
  // The settings window may be behind the game; surface buffer warnings as a toast.
  if (status.warning && status.warning !== lastWarning) showToast(status.warning);
  lastWarning = status.warning;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('session:status', status);
  }
}

function createToastWindow(): void {
  const win = new BrowserWindow({
    width: TOAST_WIDTH,
    height: TOAST_HEIGHT,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    backgroundColor: '#111111',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  toastWindow = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(TOAST_HTML)}`);
  win.on('closed', () => { if (toastWindow === win) toastWindow = null; });
}

/** Show confirmation immediately; the pre-created window keeps this under 250 ms. */
function showToast(message: string): void {
  const win = toastWindow;
  if (!win || win.isDestroyed()) return;

  const { workArea } = screen.getPrimaryDisplay();
  win.setPosition(
    workArea.x + workArea.width - TOAST_WIDTH - 24,
    workArea.y + workArea.height - TOAST_HEIGHT - 24,
  );

  const apply = () => {
    void win.webContents.executeJavaScript(
      `document.getElementById('toast').textContent = ${JSON.stringify(message)};`,
    ).catch(() => undefined);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', apply);
  else apply();
  win.showInactive();

  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    if (!win.isDestroyed()) win.hide();
  }, 2_000);
}

function triggerManual(hotkey: HotkeyAction): void {
  const entry = MANUAL_ACTIONS[hotkey];
  const result = session.emitManual(entry.action);
  if (result === 'none') showToast('No active match');
  else showToast(result === 'sent' ? entry.sent : entry.queued);
}

/** Register every binding, restoring the previous set if any registration fails. */
function applyHotkeys(bindings: HotkeyBindings): string | null {
  const previous = currentHotkeys;
  const error = registerHotkeys(bindings);
  if (error === null) {
    currentHotkeys = { ...bindings };
    return null;
  }
  registerHotkeys(previous);
  return error;
}

function registerHotkeys(bindings: HotkeyBindings): string | null {
  globalShortcut.unregisterAll();
  for (const action of HOTKEY_ACTIONS) {
    try {
      if (!globalShortcut.register(bindings[action], () => triggerManual(action))) {
        globalShortcut.unregisterAll();
        return `Could not register ${bindings[action]}; another app may be using it.`;
      }
    } catch {
      globalShortcut.unregisterAll();
      return `"${bindings[action]}" is not a valid hotkey.`;
    }
  }
  return null;
}

function setupGep(): void {
  if (gepListening) return;
  const packages = app.overwolf?.packages;
  if (!packages) return;
  gepListening = true;
  packages.on('ready', (_event, name) => {
    if (name === 'gep') attachGep();
  });
  attachGep();
}

/** Hold GEP updates until the stored Match Secret and outbox are restored. */
function deliverGep(kind: 'info' | 'event', update: GepUpdate): void {
  if (!sessionRestored) {
    if (pendingGep.length < 1_000) pendingGep.push({ kind, update });
    return;
  }
  if (kind === 'info') session.handleInfo(update);
  else session.handleEvent(update);
}

function attachGep(): void {
  if (gepAttached) return;
  const gep = (app.overwolf.packages as unknown as { gep?: GepApi }).gep;
  if (!gep) return;
  gepAttached = true;

  gep.on('game-detected', (event, gameId) => {
    if (gameId !== VALORANT_GAME_ID) return;
    event.enable();
    console.log(`[gep] Valorant detected (${gameId}); requesting features.`);
    gep.setRequiredFeatures(gameId, GEP_FEATURES).catch((error: unknown) => {
      console.error(`[gep] could not set required features: ${String(error)}`);
    });
  });
  gep.on('new-info-update', (_event, gameId, data) => {
    if (gameId !== VALORANT_GAME_ID) return;
    deliverGep('info', data);
  });
  gep.on('new-game-event', (_event, gameId, data) => {
    if (gameId !== VALORANT_GAME_ID) return;
    deliverGep('event', data);
  });
  gep.on('error', (_event, gameId, error) => {
    console.error(`[gep] game ${gameId}: ${error}`);
  });
}

async function saveSettings(input: unknown): Promise<SaveResult> {
  if (saving) return { ok: false, message: 'Already saving settings.' };
  saving = true;
  const previousHotkeys = { ...currentHotkeys };
  let hotkeysChanged = false;
  try {
    const { data, errors } = validateSettings(input, ALLOW_INSECURE_URL);
    if (!data || Object.keys(errors).length) return { ok: false, errors };

    const hotkeyError = applyHotkeys(data.hotkeys);
    if (hotkeyError !== null) return { ok: false, message: hotkeyError };
    hotkeysChanged = true;

    // A blank key means "no key" or "keep the stored key"; only read the
    // credential store when the key is actually being replaced.
    const replacingKey = data.authKey.length > 0;
    const oldKey = replacingKey ? await keytar.getPassword(SERVICE, ACCOUNT) : null;

    const directory = app.getPath('userData');
    const file = settingsFile();
    const tempFile = `${file}.${process.pid}.tmp`;
    let keyWasUpdated = false;

    try {
      if (replacingKey) {
        await keytar.setPassword(SERVICE, ACCOUNT, data.authKey);
        keyWasUpdated = true;
      }
      await mkdir(directory, { recursive: true });
      const publicSettings: PublicSettings = {
        serverUrl: data.serverUrl,
        groupCode: data.groupCode,
        displayName: data.displayName,
        hotkeys: data.hotkeys
      };
      await writeFile(tempFile, JSON.stringify(publicSettings, null, 2), {
        encoding: 'utf8', mode: 0o600
      });
      await rename(tempFile, file);
      await refreshSessionConfig();
      hotkeyWarning = undefined;
      return { ok: true };
    } catch {
      if (keyWasUpdated) {
        try {
          if (oldKey === null) await keytar.deletePassword(SERVICE, ACCOUNT);
          else await keytar.setPassword(SERVICE, ACCOUNT, oldKey);
        } catch {
          applyHotkeys(previousHotkeys);
          return { ok: false, message: 'Save failed and credential rollback failed. Inspect OS credentials.' };
        }
      }
      applyHotkeys(previousHotkeys);
      return { ok: false, message: 'Could not save settings to disk or credential store.' };
    } finally {
      await rm(tempFile, { force: true }).catch(() => undefined);
    }
  } catch {
    if (hotkeysChanged) applyHotkeys(previousHotkeys);
    return { ok: false, message: 'Could not access the OS credential store.' };
  } finally {
    saving = false;
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 560,
    height: 720,
    title: 'OBVS Client Settings',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow = win;
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('session:status', session.status);
  });
  void win.loadFile(join(__dirname, '../index.html'));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    // The hidden toast window would otherwise keep the app alive after the
    // settings window closes.
    if (process.platform !== 'darwin' && toastWindow && !toastWindow.isDestroyed()) {
      toastWindow.destroy();
    }
  });
}

app.whenReady().then(async () => {
  // Retry if the Overwolf package manager was not exposed at module load.
  setupGep();
  if (!gepListening) console.warn('[gep] Overwolf package manager is unavailable.');

  createToastWindow();
  const settings = await refreshSessionConfig();
  const hotkeyError = applyHotkeys(settings?.hotkeys ?? DEFAULT_HOTKEYS);
  if (hotkeyError !== null) {
    hotkeyWarning = `Saved hotkeys could not be registered; defaults are active. ${hotkeyError}`;
    console.error(`[hotkeys] ${hotkeyError}`);
  }

  try {
    const stored = await outbox.load();
    if (session.restore(stored)) session.resume();
  } catch (error) {
    console.error(`[outbox] could not load stored session: ${String(error)}`);
  } finally {
    sessionRestored = true;
    for (const { kind, update } of pendingGep.splice(0)) {
      if (kind === 'info') session.handleInfo(update);
      else session.handleEvent(update);
    }
  }

  ipcMain.handle('settings:load', (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized window.');
    return loadSettings();
  });
  ipcMain.handle('settings:save', (event, input: unknown) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized window.');
    return saveSettings(input);
  });
  ipcMain.handle('settings:clear-auth-key', async (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized window.');
    if (saving) throw new Error('A settings save is in progress.');
    await keytar.deletePassword(SERVICE, ACCOUNT);
    await refreshSessionConfig();
  });
  ipcMain.handle('session:status', (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized window.');
    return session.status;
  });
  ipcMain.handle('session:connect', (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized window.');
    session.connect();
    return session.status;
  });
  ipcMain.handle('session:disconnect', (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized window.');
    session.disconnect();
    return session.status;
  });

  createWindow();
}).catch(console.error);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
app.on('activate', () => {
  if (!mainWindow) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void outbox.flush().finally(() => app.quit());
  }
});
