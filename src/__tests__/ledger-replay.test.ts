/**
 * Mission Ledger — replay-equivalence on a COMMITTED golden.
 *
 * The golden (bench/replay/golden.ledger.jsonl + golden.state.sha256) was produced by
 * scripts/ledger-e2e.mjs driving the REAL server, then proving fold(ledger)==state.json live.
 * This test re-folds that committed log with the production reducer and asserts the state hash
 * still matches — a fold-logic regression, or a corrupted golden, fails the build. It is the
 * engine's own re-derivable check: the same stance as verify-claims (fold committed data, no LLM).
 *
 * Regenerating the golden (only on an intended, reviewed change): `tsx scripts/ledger-e2e.mjs
 * --emit-golden`, which rewrites both files together so they stay consistent.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldLedger, stateHash, readLedgerFile } from '../ledger/index.js';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const GOLDEN_LEDGER = join(REPO, 'bench', 'replay', 'golden.ledger.jsonl');
const GOLDEN_HASH = join(REPO, 'bench', 'replay', 'golden.state.sha256');

describe('ledger replay — committed golden re-derives its state hash', () => {
  const events = readLedgerFile(GOLDEN_LEDGER);
  const committedHash = readFileSync(GOLDEN_HASH, 'utf8').trim();

  it('the golden is a non-trivial, monotonic-seq log', () => {
    expect(events.length).toBeGreaterThanOrEqual(8);
    expect(events.map((e) => e.seq)).toEqual([...events].map((_, i) => i));
  });

  it('folds to the committed state hash', () => {
    expect(stateHash(foldLedger(events))).toBe(committedHash);
  });

  it('is idempotent — re-folding is bit-identical', () => {
    expect(stateHash(foldLedger(events))).toBe(stateHash(foldLedger(events)));
  });

  it('crash-resume: folding any prefix then the remainder yields the whole-log hash', () => {
    const whole = stateHash(foldLedger(events));
    // At every "kill" point, the ledger on disk is a prefix; resume = fold prefix ++ tail.
    for (let cut = 1; cut < events.length; cut++) {
      const resumed = stateHash(foldLedger([...events.slice(0, cut), ...events.slice(cut)]));
      expect(resumed).toBe(whole);
    }
  });
});
