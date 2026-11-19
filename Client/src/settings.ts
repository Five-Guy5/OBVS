export const HOTKEY_ACTIONS = [
  'techPause',
  'timeoutLeft',
  'timeoutRight',
  'spikePlanted',
] as const;

export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number];
export type HotkeyBindings = Record<HotkeyAction, string>;

export const DEFAULT_HOTKEYS: HotkeyBindings = {
  techPause: 'Control+Shift+1',
  timeoutLeft: 'Control+Shift+2',
  timeoutRight: 'Control+Shift+3',
  spikePlanted: 'Control+Shift+4',
};

export interface PublicSettings {
  serverUrl: string;
  groupCode: string;
  displayName: string;
  hotkeys: HotkeyBindings;
}

export interface SettingsInput extends PublicSettings {
  authKey: string;
}

export type FieldErrors = Partial<Record<keyof SettingsInput, string>>;
export type SaveResult =
  | { ok: true }
  | { ok: false; errors?: FieldErrors; message?: string };

/** Check untrusted data from the settings window before saving. */
export function validateSettings(input: unknown, allowInsecure = false):
  { data: SettingsInput | null; errors: FieldErrors } {
  if (!input || typeof input !== 'object') {
    return { data: null, errors: { serverUrl: 'Invalid settings data.' } };
  }

  const values = input as Record<string, unknown>;
  const errors: FieldErrors = {};
  const fields = ['serverUrl', 'groupCode', 'displayName', 'authKey'] as const;

  for (const field of fields) {
    if (typeof values[field] !== 'string') {
      errors[field] = `${field} must be text.`;
    }
  }
  if (Object.keys(errors).length) return { data: null, errors };

  const serverUrl = (values.serverUrl as string).trim();
  const groupCode = (values.groupCode as string).trim();
  const displayName = (values.displayName as string).trim();
  const authKey = values.authKey as string; // Don't alter opaque secrets.
  const hotkeys = validateHotkeys(values.hotkeys, errors);

  if (!serverUrl) {
    errors.serverUrl = 'Server URL is required.';
  } else {
    try {
      const url = new URL(serverUrl);
      const secure = url.protocol === 'https:' || url.protocol === 'wss:';
      const insecure = url.protocol === 'http:' || url.protocol === 'ws:';
      // Non-TLS is a local-development escape hatch; packaged builds never enable it.
      const allowedInsecure = allowInsecure && insecure && isLoopbackHost(url.hostname);
      if (!secure && !allowedInsecure) {
        errors.serverUrl = insecure
          ? 'Use HTTPS or WSS. Non-TLS is only allowed for localhost in development.'
          : 'Use an HTTPS or WSS URL.';
      } else if (
        !/^(https?|wss?):\/\//i.test(serverUrl) ||
        !url.hostname || url.username || url.password || url.hash || url.search ||
        /\s/.test(serverUrl) || serverUrl.length > 2048
      ) {
        errors.serverUrl = 'Use an HTTPS or WSS URL without credentials, query, or fragments.';
      }
    } catch {
      errors.serverUrl = 'Enter a valid HTTPS or WSS URL, e.g. https://localhost:3000.';
    }
  }

  // Group-code characters are a provisional assumption until the server defines them.
  if (!groupCode) {
    errors.groupCode = 'Group code is required.';
  } else if (!/^[A-Za-z0-9_-]{1,64}$/.test(groupCode)) {
    errors.groupCode = 'Use 1–64 letters, digits, hyphens, or underscores.';
  }

  if (!displayName) {
    errors.displayName = 'Display name is required.';
  } else if (displayName.length > 64 || /[\x00-\x1f\x7f]/.test(displayName)) {
    errors.displayName = 'Use up to 64 characters without control characters.';
  }

  if (authKey.length > 1024 || /[\r\n\x00]/.test(authKey) ||
      (authKey.length > 0 && !authKey.trim())) {
    errors.authKey = 'Auth key must be a nonblank single line (max 1024 characters).';
  }

  return {
    data: { serverUrl, groupCode, displayName, authKey, hotkeys },
    errors
  };
}

/** Merge saved hotkeys with defaults, ignoring anything unusable. */
export function normalizeHotkeys(value: unknown): HotkeyBindings {
  const result: HotkeyBindings = { ...DEFAULT_HOTKEYS };
  if (!value || typeof value !== 'object') return result;

  const record = value as Record<string, unknown>;
  const seen = new Set<string>();

  for (const action of HOTKEY_ACTIONS) {
    const raw = record[action];
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    const key = text.toLowerCase();
    if (!isHotkeyText(text) || seen.has(key)) continue;
    seen.add(key);
    result[action] = text;
  }

  // A fallback can collide with a kept custom binding; prefer a usable default set.
  const values = HOTKEY_ACTIONS.map((action) => result[action].toLowerCase());
  return new Set(values).size === values.length ? result : { ...DEFAULT_HOTKEYS };
}

export function isHotkeyText(value: string): boolean {
  return value.length > 0 &&
    value.length <= 64 &&
    !/[\s\x00-\x1f\x7f]/.test(value) &&
    /^(?:[A-Za-z0-9]+\+)*[A-Za-z0-9]+$/.test(value);
}

function validateHotkeys(value: unknown, errors: FieldErrors): HotkeyBindings {
  if (value === undefined) return { ...DEFAULT_HOTKEYS };
  if (!value || typeof value !== 'object') {
    errors.hotkeys = 'Hotkey bindings are invalid.';
    return { ...DEFAULT_HOTKEYS };
  }

  const record = value as Record<string, unknown>;
  const result: HotkeyBindings = { ...DEFAULT_HOTKEYS };
  const seen = new Set<string>();
  let reason: string | null = null;

  for (const action of HOTKEY_ACTIONS) {
    const raw = record[action];
    if (typeof raw !== 'string') {
      reason ??= 'Each hotkey must be text.';
      continue;
    }
    const text = raw.trim();
    if (!isHotkeyText(text)) {
      reason ??= 'Use an accelerator like Control+Shift+1.';
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      reason ??= 'Each hotkey must be different.';
      continue;
    }
    seen.add(key);
    result[action] = text;
  }

  if (reason !== null) errors.hotkeys = reason;
  return result;
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' ||
    hostname === '::1' || hostname === '[::1]';
}
