
export interface PublicSettings {
  serverUrl: string;
  groupCode: string;
  displayName: string;
}

export interface SettingsInput extends PublicSettings {
  authKey: string;
}

export type FieldErrors = Partial<Record<keyof SettingsInput, string>>;
export type SaveResult =
  | { ok: true }
  | { ok: false; errors?: FieldErrors; message?: string };

/** Check untrusted data from the settings window before saving. */
export function validateSettings(input: unknown, hasSavedKey: boolean):
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

  if (!serverUrl) {
    errors.serverUrl = 'Server URL is required.';
  } else {
    try {
      const url = new URL(serverUrl);
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
          !/^(https?|wss?):\/\//i.test(serverUrl) ||
          !url.hostname || url.username || url.password || url.hash ||
          /\s/.test(serverUrl) || serverUrl.length > 2048) {
        errors.serverUrl = 'Use an HTTP(S) or WS(S) URL without credentials, spaces, or fragments.';
      }
    } catch {
      errors.serverUrl = 'Enter a valid URL, e.g. https://localhost:3000.';
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

  if (!authKey.trim() && !hasSavedKey) {
    errors.authKey = 'Auth key is required on first setup.';
  } else if (authKey.length > 1024 || /[\r\n\x00]/.test(authKey) ||
             (authKey.length > 0 && !authKey.trim())) {
    errors.authKey = 'Auth key must be a nonblank single line (max 1024 characters).';
  }

  return {
    data: { serverUrl, groupCode, displayName, authKey },
    errors
  };
}
