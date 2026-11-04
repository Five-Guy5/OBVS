
import { app, BrowserWindow, ipcMain } from 'electron';
import * as keytar from 'keytar';
import { userInfo } from 'node:os';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Session,
  type SessionConfig,
  type SessionStatus,
  type SocketLike,
} from './session';
import { validateSettings, type PublicSettings, type SaveResult } from './settings';

const SERVICE = 'io.obvs.client';
const ACCOUNT = 'server-auth-key';
// Non-TLS is a local-development escape hatch, never available in packaged builds.
const ALLOW_INSECURE_URL = !app.isPackaged && process.env.OBVS_ALLOW_INSECURE_URL === '1';
const VALORANT_GAME_ID = 21610;
const GEP_FEATURES = ['match_info', 'me', 'game_info', 'kill', 'death'];
let mainWindow: BrowserWindow | null = null;
let session: Session | null = null;
let saving = false;
let gepAttached = false;

interface GepInfo {
  feature: string;
  key: string;
  value: unknown;
}

interface GepLaunchEvent {
  enable(): void;
}

interface GepApi {
  on(event: 'game-detected', listener: (event: GepLaunchEvent, gameId: number) => void): void;
  on(event: 'new-info-update',
    listener: (event: unknown, gameId: number, data: GepInfo) => void): void;
  on(event: 'new-game-event',
    listener: (event: unknown, gameId: number, data: GepInfo) => void): void;
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
  return { serverUrl: s.serverUrl, groupCode: s.groupCode, displayName: s.displayName };
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
    hasAuthKey, // Never send the stored secret back to the UI.
    warning
  };
}

async function loadConnectionConfig(): Promise<SessionConfig | null> {
  const stored = await readSettings();
  if (!stored) return null;
  const authKey = (await keytar.getPassword(SERVICE, ACCOUNT)) ?? '';
  return { ...stored, authKey };
}

async function refreshSessionConfig(): Promise<void> {
  if (!session) return;
  try {
    session.setConfig(await loadConnectionConfig());
  } catch {
    session.setConfig(null);
  }
}

function publishStatus(status: SessionStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('session:status', status);
  }
}

function setupGep(): void {
  const packages = app.overwolf?.packages;
  if (!packages) {
    console.warn('[gep] Overwolf package manager is unavailable.');
    return;
  }
  packages.on('ready', (_event, name) => {
    if (name === 'gep') attachGep();
  });
  attachGep();
}

function attachGep(): void {
  if (gepAttached) return;
  const gep = (app.overwolf.packages as unknown as { gep?: GepApi }).gep;
  if (!gep) return;
  gepAttached = true;

  gep.on('game-detected', (event, gameId) => {
    if (gameId !== VALORANT_GAME_ID) return;
    event.enable();
    gep.setRequiredFeatures(gameId, GEP_FEATURES).catch((error: unknown) => {
      console.error(`[gep] could not set required features: ${String(error)}`);
    });
  });
  gep.on('new-info-update', (_event, gameId, data) => {
    if (gameId !== VALORANT_GAME_ID) return;
    session?.handleInfo(data.feature, data.key, data.value);
  });
  gep.on('new-game-event', (_event, gameId, data) => {
    if (gameId !== VALORANT_GAME_ID) return;
    session?.handleEvent(data.feature, data.key, data.value);
  });
  gep.on('error', (_event, gameId, error) => {
    console.error(`[gep] game ${gameId}: ${error}`);
  });
}

async function saveSettings(input: unknown): Promise<SaveResult> {
  if (saving) return { ok: false, message: 'Already saving settings.' };
  saving = true;
  try {
    const { data, errors } = validateSettings(input, ALLOW_INSECURE_URL);
    if (!data || Object.keys(errors).length) return { ok: false, errors };

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
        displayName: data.displayName
      };
      await writeFile(tempFile, JSON.stringify(publicSettings, null, 2), {
        encoding: 'utf8', mode: 0o600
      });
      await rename(tempFile, file);
      await refreshSessionConfig();
      return { ok: true };
    } catch {
      if (keyWasUpdated) {
        try {
          if (oldKey === null) await keytar.deletePassword(SERVICE, ACCOUNT);
          else await keytar.setPassword(SERVICE, ACCOUNT, oldKey);
        } catch {
          return { ok: false, message: 'Save failed and credential rollback failed. Inspect OS credentials.' };
        }
      }
      return { ok: false, message: 'Could not save settings to disk or credential store.' };
    } finally {
      await rm(tempFile, { force: true }).catch(() => undefined);
    }
  } catch {
    return { ok: false, message: 'Could not access the OS credential store.' };
  } finally {
    saving = false;
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 560,
    height: 560,
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
    win.webContents.send('session:status', session?.status ?? { state: 'idle', error: null });
  });
  void win.loadFile(join(__dirname, '../index.html'));
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
}

app.whenReady().then(async () => {
  session = new Session({
    clientVersion: app.getVersion(),
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    onChange: publishStatus
  });
  await refreshSessionConfig();

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
    return session!.status;
  });
  ipcMain.handle('session:connect', (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized window.');
    session!.connect();
    return session!.status;
  });
  ipcMain.handle('session:disconnect', (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized window.');
    session!.disconnect();
    return session!.status;
  });

  createWindow();
  setupGep();
}).catch(console.error);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
