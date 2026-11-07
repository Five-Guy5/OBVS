import { DEFAULT_IDLE_TIMEOUT_MS } from "./config.js";
import { Match, type ObserverInfo } from "./match.js";

export type ClaimResult =
  | { ok: true; match: Match }
  | { ok: false; reason: string };

/** Holds at most one Match, and so one Observer, per group code. */
export class MatchRegistry {
  readonly #matches = new Map<string, Match>();

  get(groupCode: string): Match | undefined {
    return this.#matches.get(groupCode);
  }

  /** Create the group's Match, or reject while another Observer holds it. */
  claim(groupCode: string, observer: ObserverInfo): ClaimResult {
    if (this.#matches.has(groupCode)) {
      return { ok: false, reason: "Another Observer is already logged on for this group code." };
    }

    const match = new Match(groupCode, observer);
    this.#matches.set(groupCode, match);

    return { ok: true, match };
  }

  /** Remove only the given Match, so a stale caller cannot drop a newer one. */
  remove(match: Match): boolean {
    if (this.#matches.get(match.groupCode) !== match) {
      return false;
    }

    return this.#matches.delete(match.groupCode);
  }

  /** Drop disconnected Matches that have been inactive past the timeout (S.4). */
  sweep(timeoutMs = DEFAULT_IDLE_TIMEOUT_MS, now = Date.now()): number {
    let removed = 0;

    for (const [groupCode, match] of this.#matches) {
      if (match.isIdle(now, timeoutMs)) {
        this.#matches.delete(groupCode);
        removed += 1;
      }
    }

    return removed;
  }
}
