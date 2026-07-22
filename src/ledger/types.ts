/**
 * Mission Ledger — types.
 *
 * A LedgerEvent is a COMPLETE record of one state mutation: it carries the full
 * post-mutation entity (for an upsert) so the stream is genuinely foldable — unlike the
 * server's write-only `events.jsonl` notification log, whose payloads carry only ids and
 * scalars and therefore cannot reconstruct state. Fold order is the monotonic `seq`, never
 * wall-clock, so a burst recorded in the same millisecond still folds deterministically.
 */

export type LedgerOp = 'upsert' | 'delete';

export interface LedgerEvent {
  /** Monotonic sequence number — the authoritative fold order. Never wall-clock. */
  seq: number;
  /** ISO timestamp the event was recorded. Informational only; NOT used for ordering. */
  ts: string;
  /** The originating contract-event type (e.g. 'finding.created'). Provenance, not fold logic. */
  type: string;
  /** Which projection this event mutates (e.g. 'findingsLedger'). */
  ledger: string;
  /** upsert writes `entity` at `id`; delete removes `id`. */
  op: LedgerOp;
  /** The entity id — the projection key. */
  id: string;
  /** The full, post-mutation, already-redacted entity. Present for upsert, omitted for delete. */
  entity?: Record<string, unknown>;
}

/** ledgerName -> (id -> entity). The folded projection. */
export type LedgerState = Record<string, Record<string, Record<string, unknown>>>;
