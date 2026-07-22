/**
 * Mission Ledger — deterministic canonicalization + state hash.
 *
 * Two logically-equal states must serialize to the SAME string regardless of the order
 * their keys were inserted, so the SHA-256 over that string is a stable state fingerprint.
 * Object keys are emitted sorted at every depth; arrays keep their order (order is meaningful).
 */

import { createHash } from 'node:crypto';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

/** Stable JSON: keys sorted at every depth. `undefined`/functions are dropped by JSON, as usual. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** SHA-256 (hex) over the canonical serialization. Stable across key/insertion order. */
export function stateHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}
