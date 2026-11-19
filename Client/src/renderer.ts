// This file is loaded as a classic browser script, not a CommonJS module, so
// it cannot import even type-only symbols. Keep these in sync with session.ts
// and settings.ts.
type SessionState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'stopping';
interface SessionStatus {
  state: SessionState;
  error: string | null;
  warning: string | null;
}

type Field = 'serverUrl' | 'groupCode' | 'displayName' | 'authKey';
type HotkeyAction = 'techPause' | 'timeoutLeft' | 'timeoutRight' | 'spikePlanted';
type HotkeyBindings = Record<HotkeyAction, string>;
type SettingsInput = Record<Field, string> & { hotkeys: HotkeyBindings };
type FieldErrors = Partial<Record<Field | 'hotkeys', string>>;

interface Window {
  obvs: {
    loadSettings(): Promise<Omit<SettingsInput, 'authKey'> & {
      hasAuthKey: boolean;
      warning?: string;
    }>;
    saveSettings(values: SettingsInput): Promise<
      { ok: true } | { ok: false; errors?: FieldErrors; message?: string }
    >;
    clearAuthKey(): Promise<void>;
    getSessionStatus(): Promise<SessionStatus>;
    connect(): Promise<SessionStatus>;
    disconnect(): Promise<SessionStatus>;
    onSessionStatus(callback: (status: SessionStatus) => void): void;
  };
}

const form = document.querySelector<HTMLFormElement>('#settings-form')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const clearKeyButton = document.querySelector<HTMLButtonElement>('#clear-auth-key')!;
const statusMessage = document.querySelector<HTMLElement>('#status')!;
const hint = document.querySelector<HTMLElement>('#key-hint')!;
const connectButton = document.querySelector<HTMLButtonElement>('#connect')!;
const disconnectButton = document.querySelector<HTMLButtonElement>('#disconnect')!;
const sessionIcon = document.querySelector<HTMLElement>('#session-icon')!;
const sessionStatus = document.querySelector<HTMLElement>('#session-status')!;
const sessionWarning = document.querySelector<HTMLElement>('#session-warning')!;
const hotkeysError = document.querySelector<HTMLElement>('#hotkeys-error')!;

const SESSION_DISPLAY: Record<SessionState, { text: string; icon: string }> = {
  idle: { text: 'Idle', icon: '○' },
  connecting: { text: 'Connecting…', icon: '◌' },
  live: { text: 'Live', icon: '●' },
  reconnecting: { text: 'Reconnecting…', icon: '◌' },
  stopping: { text: 'Stopping…', icon: '■' }
};

function renderSessionStatus(status: SessionStatus): void {
  const display = SESSION_DISPLAY[status.state];
  sessionIcon.textContent = status.error ? '⚠' : display.icon;
  sessionStatus.textContent = status.error
    ? `${display.text} — ${status.error}`
    : display.text;
  sessionWarning.textContent = status.warning ?? '';
  connectButton.disabled = status.state !== 'idle';
  disconnectButton.disabled = status.state === 'idle' || status.state === 'stopping';
}
const fields: Record<Field, HTMLInputElement> = {
  serverUrl: document.querySelector<HTMLInputElement>('#serverUrl')!,
  groupCode: document.querySelector<HTMLInputElement>('#groupCode')!,
  displayName: document.querySelector<HTMLInputElement>('#displayName')!,
  authKey: document.querySelector<HTMLInputElement>('#authKey')!
};
const hotkeyFields: Record<HotkeyAction, HTMLInputElement> = {
  techPause: document.querySelector<HTMLInputElement>('#hotkey-techPause')!,
  timeoutLeft: document.querySelector<HTMLInputElement>('#hotkey-timeoutLeft')!,
  timeoutRight: document.querySelector<HTMLInputElement>('#hotkey-timeoutRight')!,
  spikePlanted: document.querySelector<HTMLInputElement>('#hotkey-spikePlanted')!
};
const HOTKEY_ACTIONS = Object.keys(hotkeyFields) as HotkeyAction[];
let hasAuthKey = false;

function showErrors(errors: FieldErrors = {}): void {
  for (const name of Object.keys(fields) as Field[]) {
    document.getElementById(`${name}-error`)!.textContent = errors[name] ?? '';
    fields[name].setAttribute('aria-invalid', String(Boolean(errors[name])));
  }
  hotkeysError.textContent = errors.hotkeys ?? '';
  for (const action of HOTKEY_ACTIONS) {
    hotkeyFields[action].setAttribute(
      'aria-invalid',
      String(Boolean(errors.hotkeys)),
    );
  }
  const first = (Object.keys(fields) as Field[]).find((name) => errors[name]);
  if (first) fields[first].focus();
  else if (errors.hotkeys) hotkeyFields.techPause.focus();
}

function updateHint(): void {
  hint.textContent = hasAuthKey
    ? 'Auth key saved securely. Leave blank to keep it, or enter a replacement.'
    : 'Auth key is optional. Leave blank if the server has no auth key.';
  clearKeyButton.hidden = !hasAuthKey;
}

async function initialize(): Promise<void> {
  saveButton.disabled = true;
  window.obvs.onSessionStatus(renderSessionStatus);
  void window.obvs.getSessionStatus().then(renderSessionStatus).catch(() => {
    statusMessage.textContent = 'Could not load the session status.';
  });
  try {
    const saved = await window.obvs.loadSettings();
    fields.serverUrl.value = saved.serverUrl;
    fields.groupCode.value = saved.groupCode;
    fields.displayName.value = saved.displayName;
    for (const action of HOTKEY_ACTIONS) {
      hotkeyFields[action].value = saved.hotkeys?.[action] ?? '';
    }
    hasAuthKey = saved.hasAuthKey;
    updateHint();
    if (saved.warning) statusMessage.textContent = saved.warning;
  } catch {
    statusMessage.textContent = 'Could not load settings. Check OS credential access, then enter values and save.';
  } finally {
    saveButton.disabled = false;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showErrors();
  statusMessage.textContent = '';
  saveButton.disabled = true;
  clearKeyButton.disabled = true;
  const values: SettingsInput = {
    serverUrl: fields.serverUrl.value,
    groupCode: fields.groupCode.value,
    displayName: fields.displayName.value,
    authKey: fields.authKey.value,
    hotkeys: {
      techPause: hotkeyFields.techPause.value.trim(),
      timeoutLeft: hotkeyFields.timeoutLeft.value.trim(),
      timeoutRight: hotkeyFields.timeoutRight.value.trim(),
      spikePlanted: hotkeyFields.spikePlanted.value.trim()
    }
  };
  try {
    const result = await window.obvs.saveSettings(values);
    if (!result.ok) {
      showErrors(result.errors);
      statusMessage.textContent = result.message ?? 'Fix the highlighted fields.';
      return;
    }
    fields.serverUrl.value = values.serverUrl.trim();
    fields.groupCode.value = values.groupCode.trim();
    fields.displayName.value = values.displayName.trim();
    for (const action of HOTKEY_ACTIONS) {
      hotkeyFields[action].value = values.hotkeys[action];
    }
    hasAuthKey = values.authKey.length > 0 || hasAuthKey;
    fields.authKey.value = '';
    updateHint();
    statusMessage.textContent = 'Settings saved.';
  } catch {
    statusMessage.textContent = 'Could not save settings.';
  } finally {
    saveButton.disabled = false;
    clearKeyButton.disabled = false;
  }
});

clearKeyButton.addEventListener('click', async () => {
  clearKeyButton.disabled = true;
  saveButton.disabled = true;
  statusMessage.textContent = '';
  try {
    await window.obvs.clearAuthKey();
    hasAuthKey = false;
    fields.authKey.value = '';
    updateHint();
    statusMessage.textContent = 'Saved auth key removed.';
  } catch {
    statusMessage.textContent = 'Could not remove the saved auth key.';
  } finally {
    clearKeyButton.disabled = false;
    saveButton.disabled = false;
  }
});

async function runSessionAction(
  action: () => Promise<SessionStatus>,
  button: HTMLButtonElement
): Promise<void> {
  button.disabled = true;
  statusMessage.textContent = '';
  try {
    renderSessionStatus(await action());
  } catch {
    statusMessage.textContent = 'Could not change the session state.';
    try {
      renderSessionStatus(await window.obvs.getSessionStatus());
    } catch {
      button.disabled = false;
    }
  }
}

connectButton.addEventListener('click', () => {
  void runSessionAction(() => window.obvs.connect(), connectButton);
});

disconnectButton.addEventListener('click', () => {
  void runSessionAction(() => window.obvs.disconnect(), disconnectButton);
});

void initialize();
