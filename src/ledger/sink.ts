/**
 * Mission Ledger — sinks + reader.
 *
 * The durable sink is append-only JSONL, fsync'd per event so an abrupt SIGKILL keeps every
 * acknowledged event. The reader tolerates ONE torn trailing line (the only artifact an
 * atomic-append + crash can produce); an unparseable INTERIOR line is real corruption and throws.
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import type { LedgerEvent } from './types.js';

export interface LedgerSink {
  append(event: LedgerEvent): void;
}

/** In-memory sink — for tests and the ephemeral ('memory') state mode. */
export class MemorySink implements LedgerSink {
  readonly events: LedgerEvent[] = [];
  append(event: LedgerEvent): void {
    this.events.push(event);
  }
}

/** Durable append-only JSONL sink. One line per event, fsync'd before returning. */
export class JsonlFileSink implements LedgerSink {
  constructor(private readonly filePath: string) {}
  append(event: LedgerEvent): void {
    const fd = openSync(this.filePath, 'a');
    try {
      writeSync(fd, `${JSON.stringify(event)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * Read a committed JSONL ledger. A blank line is skipped. A final unparseable line is treated
 * as a torn trailing write (abrupt-crash artifact) and dropped; an unparseable line with real
 * content after it is corruption and throws.
 */
export function readLedgerFile(filePath: string): LedgerEvent[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const out: LedgerEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as LedgerEvent);
    } catch (err) {
      const onlyBlanksAfter = lines.slice(i + 1).every((l) => !l.trim());
      if (onlyBlanksAfter) break; // torn trailing write — safe to drop
      throw new Error(`ledger corruption at line ${i + 1}: ${(err as Error).message}`);
    }
  }
  return out;
}
