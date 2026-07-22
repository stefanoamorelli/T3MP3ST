/**
 * Mission Ledger — the pure fold.
 *
 * `foldLedger` is a PURE deterministic function of the event list: same events (in any
 * array order) → same projection. It is the load-bearing property behind replay-equivalence
 * (`fold(committed log) === recorded state`) and crash-resume (fold any prefix, then continue).
 */

import type { LedgerEvent, LedgerState } from './types.js';

/**
 * Fold an event list into a projection. Events are ordered by `seq` (a copy is sorted, so the
 * caller's array order cannot change the result); last upsert wins per (ledger, id); a delete
 * removes the id. An emptied ledger bucket is dropped so an all-deleted ledger hashes identically
 * to one that was never touched.
 */
export function foldLedger(events: readonly LedgerEvent[]): LedgerState {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const state: LedgerState = {};
  for (const ev of ordered) {
    const bucket = (state[ev.ledger] ??= {});
    if (ev.op === 'delete') {
      delete bucket[ev.id];
    } else {
      // structuredClone so the folded state shares no reference with the event payloads —
      // a caller mutating the result can never reach back into the log.
      bucket[ev.id] = structuredClone(ev.entity ?? {}) as Record<string, unknown>;
    }
    if (Object.keys(bucket).length === 0) delete state[ev.ledger];
  }
  return state;
}
