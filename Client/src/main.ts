
import { app, BrowserWindow, ipcMain } from 'electron';
import * as keytar from 'keytar';
import { userInfo } from 'node:os';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { validateSettings, type PublicSettings, type SaveResult } from './settings';

const SERVICE = 'io.obvs.client';
const ACCOUNT = 'server-auth-key';
// Non-TLS is a local-development escape hatch, never available in packaged builds.
const ALLOW_INSECURE_URL = !app.isPackaged && process.env.OBVS_ALLOW_INSECURE_URL === '1';
let mainWindow: BrowserWindow | null = null;
let saving = false;

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
  void win.loadFile(join(__dirname, '../index.html'));
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
}

app.whenReady().then(() => {
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
  });
  createWindow();
}).catch(console.error);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
