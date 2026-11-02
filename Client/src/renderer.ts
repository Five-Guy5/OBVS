
type Field = 'serverUrl' | 'groupCode' | 'displayName' | 'authKey';
type SettingsInput = Record<Field, string>;
type FieldErrors = Partial<Record<Field, string>>;

interface Window {
  obvs: {
    loadSettings(): Promise<Omit<SettingsInput, 'authKey'> & { hasAuthKey: boolean }>;
    saveSettings(values: SettingsInput): Promise<
      { ok: true } | { ok: false; errors?: FieldErrors; message?: string }
    >;
  };
}

const form = document.querySelector<HTMLFormElement>('#settings-form')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
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
    : 'Auth key required on first setup (stored in the OS credential store).';
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
    saveButton.disabled = false;
  } catch {
    statusMessage.textContent = 'Could not load settings. Check OS credential access.';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showErrors();
  statusMessage.textContent = '';
  saveButton.disabled = true;
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
    hasAuthKey = true;
    fields.authKey.value = '';
    updateHint();
    statusMessage.textContent = 'Settings saved.';
  } catch {
    statusMessage.textContent = 'Could not save settings.';
  } finally {
    saveButton.disabled = false;
  }
});

void initialize();
