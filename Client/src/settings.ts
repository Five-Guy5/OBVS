
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
    data: { serverUrl, groupCode, displayName, authKey },
    errors
  };
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' ||
    hostname === '::1' || hostname === '[::1]';
}
