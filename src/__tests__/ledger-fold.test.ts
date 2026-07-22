/**
 * Mission Ledger core — pins the load-bearing invariants of the foldable event log:
 *  - fold is a PURE function of the events: array order in cannot change the projection out
 *  - fold is idempotent: folding twice is bit-identical (same object, same hash)
 *  - last upsert wins per (ledger, id); a delete removes; an emptied ledger vanishes
 *  - stateHash is stable across key/insertion order (the whole point of canonicalization)
 *  - readLedgerFile tolerates a torn trailing line but rejects interior corruption
 *
 * These are the properties replay-equivalence and crash-resume rest on, proven with zero I/O.
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import {
  MissionLedger,
  foldLedger,
  stateHash,
  canonicalize,
  readLedgerFile,
  type LedgerEvent,
} from '../ledger/index.js';

const ev = (over: Partial<LedgerEvent>): LedgerEvent => ({
  seq: 0,
  ts: '2026-01-01T00:00:00.000Z',
  type: 'finding.created',
  ledger: 'findingsLedger',
  op: 'upsert',
  id: 'f1',
  entity: { id: 'f1', title: 'x' },
  ...over,
});

describe('foldLedger — pure, order-independent, deterministic', () => {
  it('folds shuffled input to the identical projection (order by seq, not array order)', () => {
    const events = [
      ev({ seq: 0, id: 'f1', entity: { id: 'f1', v: 'a' } }),
      ev({ seq: 1, id: 'f2', entity: { id: 'f2', v: 'b' } }),
      ev({ seq: 2, id: 'f1', op: 'upsert', entity: { id: 'f1', v: 'a2' } }),
    ];
    const forward = foldLedger(events);
    const shuffled = foldLedger([events[2], events[0], events[1]]);
    expect(shuffled).toEqual(forward);
    expect(stateHash(shuffled)).toBe(stateHash(forward));
    // last upsert wins
    expect(forward.findingsLedger.f1).toEqual({ id: 'f1', v: 'a2' });
    expect(forward.findingsLedger.f2).toEqual({ id: 'f2', v: 'b' });
  });

  it('is idempotent — double fold is deep-equal and hash-identical', () => {
    const events = [ev({ seq: 0 }), ev({ seq: 1, id: 'f2', entity: { id: 'f2' } })];
    const once = foldLedger(events);
    const twice = foldLedger(events);
    expect(twice).toEqual(once);
    expect(stateHash(twice)).toBe(stateHash(once));
  });

  it('delete removes the id; an emptied ledger bucket disappears (hashes like never-touched)', () => {
    const withDelete = foldLedger([
      ev({ seq: 0, id: 'f1', entity: { id: 'f1' } }),
      ev({ seq: 1, id: 'f1', op: 'delete', entity: undefined }),
    ]);
    expect(withDelete.findingsLedger).toBeUndefined();
    expect(stateHash(withDelete)).toBe(stateHash({}));
  });

  it('folded state shares no reference with the events (mutating the result is safe)', () => {
    const events = [ev({ seq: 0, id: 'f1', entity: { id: 'f1', nested: { a: 1 } } })];
    const state = foldLedger(events);
    (state.findingsLedger.f1 as { nested: { a: number } }).nested.a = 999;
    expect((events[0].entity as { nested: { a: number } }).nested.a).toBe(1);
  });
});

describe('canonicalize / stateHash — stable across key order', () => {
  it('two objects differing only in key insertion order hash identically', () => {
    const a = { b: 1, a: { y: 2, x: 3 }, c: [3, 2, 1] };
    const b = { c: [3, 2, 1], a: { x: 3, y: 2 }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(stateHash(a)).toBe(stateHash(b));
  });

  it('array order IS significant (order carries meaning)', () => {
    expect(stateHash({ xs: [1, 2, 3] })).not.toBe(stateHash({ xs: [3, 2, 1] }));
  });
});

describe('MissionLedger — mints monotonic seq, folds what it records', () => {
  it('assigns increasing seq and folds to the recorded state', () => {
    const clock = (() => { let t = 1_700_000_000_000; return () => (t += 1000); })();
    const ledger = new MissionLedger(undefined, clock);
    ledger.record({ type: 'finding.created', ledger: 'findingsLedger', op: 'upsert', id: 'f1', entity: { id: 'f1', s: 'open' } });
    ledger.record({ type: 'finding.updated', ledger: 'findingsLedger', op: 'upsert', id: 'f1', entity: { id: 'f1', s: 'validated' } });
    ledger.record({ type: 'evidence.created', ledger: 'evidenceLedger', op: 'upsert', id: 'e1', entity: { id: 'e1' } });
    const seqs = ledger.events().map((e) => e.seq);
    expect(seqs).toEqual([0, 1, 2]);
    const state = ledger.fold();
    expect(state.findingsLedger.f1).toEqual({ id: 'f1', s: 'validated' }); // last write wins
    expect(state.evidenceLedger.e1).toEqual({ id: 'e1' });
    expect(ledger.stateHash()).toBe(stateHash(state));
  });
});

describe('readLedgerFile — torn-write tolerance', () => {
  it('drops a torn trailing line but keeps every whole event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
    const file = join(dir, 'ledger.jsonl');
    const good = `${JSON.stringify(ev({ seq: 0 }))}\n${JSON.stringify(ev({ seq: 1, id: 'f2', entity: { id: 'f2' } }))}\n`;
    writeFileSync(file, `${good}{"seq":2,"type":"finding.created","ledg`); // half-written last line
    const events = readLedgerFile(file);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('throws on interior corruption (a bad line with real content after it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
    const file = join(dir, 'ledger.jsonl');
    writeFileSync(file, `{"seq":0} broken\n${JSON.stringify(ev({ seq: 1 }))}\n`);
    expect(() => readLedgerFile(file)).toThrow(/corruption/);
  });
});
