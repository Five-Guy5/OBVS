import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IngestEvent } from '@obvs/protocol';

/** The Client's durable session state: the resume secret and unsent event log. */
export interface StoredOutbox {
  matchSecret: string | null;
  events: IngestEvent[];
}

/**
 * Persistence seam for Session. Implementations may buffer writes; the event
 * array is read synchronously when serialized, so callers need not copy it.
 */
export interface OutboxStore {
  load(): Promise<StoredOutbox | null>;
  save(state: StoredOutbox): void;
  clear(): void;
}

/** JSON-file outbox with atomic writes and coalesced saves. */
export function createFileOutbox(filePath: () => string): OutboxStore & {
  flush(): Promise<void>;
} {
  let latest: StoredOutbox | null = null;
  let version = 0;
  let writtenVersion = 0;
  let running = false;
  let chain: Promise<void> = Promise.resolve();

  function schedule(): void {
    if (running) return;
    running = true;
    chain = chain
      .then(async () => {
        try {
          while (writtenVersion !== version) {
            const target = version;
            const snapshot = latest;
            if (snapshot === null) await removeFile(filePath());
            else await writeAtomic(filePath(), snapshot);
            writtenVersion = target;
          }
        } finally {
          running = false;
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[outbox] could not save session state: ${message}`);
      });
  }

  return {
    async load(): Promise<StoredOutbox | null> {
      let text: string;
      try {
        text = await readFile(filePath(), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }

      try {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== 'object') return null;
        const record = value as Record<string, unknown>;
        const secret = record.matchSecret;
        if (secret !== null && secret !== undefined && typeof secret !== 'string') return null;
        if (!Array.isArray(record.events)) return null;
        return {
          matchSecret: typeof secret === 'string' ? secret : null,
          events: record.events.filter(isIngestEvent),
        };
      } catch {
        return null;
      }
    },

    save(state: StoredOutbox): void {
      latest = { matchSecret: state.matchSecret, events: state.events };
      version += 1;
      schedule();
    },

    clear(): void {
      latest = null;
      version += 1;
      schedule();
    },

    flush(): Promise<void> {
      return chain;
    },
  };
}

async function writeAtomic(file: string, state: StoredOutbox): Promise<void> {
  // Serialize now, while the caller's event array is stable.
  const text = JSON.stringify(state);
  const temp = `${file}.${process.pid}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  try {
    // The file carries the Match Secret, so keep it owner-only.
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true });
}

function isIngestEvent(value: unknown): value is IngestEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.protocolVersion === 'number' &&
    typeof event.eventId === 'string' &&
    event.eventId.length > 0 &&
    typeof event.type === 'string' &&
    typeof event.capturedAt === 'string' &&
    !Number.isNaN(Date.parse(event.capturedAt)) &&
    typeof event.payload === 'object' &&
    event.payload !== null
  );
}
