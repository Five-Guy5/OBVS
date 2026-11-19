import { DEFAULT_IDLE_TIMEOUT_MS } from "./config.js";
import { Match, type ObserverInfo } from "./match.js";

export type ClaimResult =
  | { ok: true; match: Match }
  | { ok: false; reason: string };

export type ChangeListener = (groupCode: string) => void;

/** Holds at most one Match, and so one Observer, per group code. */
export class MatchRegistry {
  readonly #matches = new Map<string, Match>();
  readonly #listeners = new Set<ChangeListener>();

  get(groupCode: string): Match | undefined {
    return this.#matches.get(groupCode);
  }

  /** Hear about Match creation, appended events, and removal; returns an unsubscribe. */
  onChange(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Create the group's Match, or reject while another Observer holds it. */
  claim(groupCode: string, observer: ObserverInfo): ClaimResult {
    if (this.#matches.has(groupCode)) {
      return { ok: false, reason: "Another Observer is already logged on for this group code." };
    }

    const match = new Match(groupCode, observer, () => this.#notify(groupCode));
    this.#matches.set(groupCode, match);
    this.#notify(groupCode);

    return { ok: true, match };
  }

  /** Remove only the given Match, so a stale caller cannot drop a newer one. */
  remove(match: Match): boolean {
    if (this.#matches.get(match.groupCode) !== match) {
      return false;
    }

    this.#matches.delete(match.groupCode);
    this.#notify(match.groupCode);

    return true;
  }

  /** Drop disconnected Matches that have been inactive past the timeout (S.4). */
  sweep(timeoutMs = DEFAULT_IDLE_TIMEOUT_MS, now = Date.now()): number {
    let removed = 0;

    for (const [groupCode, match] of this.#matches) {
      if (match.isIdle(now, timeoutMs)) {
        this.#matches.delete(groupCode);
        this.#notify(groupCode);
        removed += 1;
      }
    }

    return removed;
  }

  #notify(groupCode: string): void {
    for (const listener of this.#listeners) {
      listener(groupCode);
    }
  }
}
