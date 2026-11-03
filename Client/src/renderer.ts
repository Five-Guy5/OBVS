
type Field = 'serverUrl' | 'groupCode' | 'displayName' | 'authKey';
type SettingsInput = Record<Field, string>;
type FieldErrors = Partial<Record<Field, string>>;

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
  };
}

const form = document.querySelector<HTMLFormElement>('#settings-form')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const clearKeyButton = document.querySelector<HTMLButtonElement>('#clear-auth-key')!;
const statusMessage = document.querySelector<HTMLElement>('#status')!;
const hint = document.querySelector<HTMLElement>('#key-hint')!;
const fields: Record<Field, HTMLInputElement> = {
  serverUrl: document.querySelector<HTMLInputElement>('#serverUrl')!,
  groupCode: document.querySelector<HTMLInputElement>('#groupCode')!,
  displayName: document.querySelector<HTMLInputElement>('#displayName')!,
  authKey: document.querySelector<HTMLInputElement>('#authKey')!
};
let hasAuthKey = false;

function showErrors(errors: FieldErrors = {}): void {
  for (const name of Object.keys(fields) as Field[]) {
    document.getElementById(`${name}-error`)!.textContent = errors[name] ?? '';
    fields[name].setAttribute('aria-invalid', String(Boolean(errors[name])));
  }
  const first = (Object.keys(fields) as Field[]).find((name) => errors[name]);
  if (first) fields[first].focus();
}

function updateHint(): void {
  hint.textContent = hasAuthKey
    ? 'Auth key saved securely. Leave blank to keep it, or enter a replacement.'
    : 'Auth key is optional. Leave blank if the server has no auth key.';
  clearKeyButton.hidden = !hasAuthKey;
}

async function initialize(): Promise<void> {
  saveButton.disabled = true;
  try {
    const saved = await window.obvs.loadSettings();
    fields.serverUrl.value = saved.serverUrl;
    fields.groupCode.value = saved.groupCode;
    fields.displayName.value = saved.displayName;
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
    authKey: fields.authKey.value
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

void initialize();
