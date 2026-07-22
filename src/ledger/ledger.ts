/**
 * Mission Ledger — the recorder.
 *
 * Assigns each event a monotonic `seq`, mirrors it in memory (for an in-process fold) and, when
 * a durable sink is supplied, to disk. The recorder is the ONLY minter of `seq`, so fold order is
 * causal and independent of wall-clock. It records; it does not decide WHAT to record — the caller
 * (the server's contract-event choke point) supplies complete, already-redacted entities.
 */

import { stateHash } from './canonical.js';
import { foldLedger } from './fold.js';
import { MemorySink } from './sink.js';
import type { LedgerSink } from './sink.js';
import type { LedgerEvent, LedgerOp, LedgerState } from './types.js';

export interface RecordInput {
  type: string;
  ledger: string;
  op: LedgerOp;
  id: string;
  /** Full, ALREADY-REDACTED entity for an upsert. Ignored for a delete. */
  entity?: Record<string, unknown>;
}

export class MissionLedger {
  private seq = 0;
  private readonly mem = new MemorySink();
  private readonly sink: LedgerSink;
  private readonly clock: () => number;

  /**
   * @param sink durable sink (omit for a pure in-memory ledger).
   * @param clock injectable for tests.
   * @param startSeq first seq to mint. After a resume, seed this to (last on-disk seq + 1) so
   *   appended events never collide with recovered ones and the whole file stays monotonic.
   */
  constructor(sink?: LedgerSink, clock: () => number = Date.now, startSeq = 0) {
    this.sink = sink ?? this.mem;
    this.clock = clock;
    this.seq = startSeq;
  }

  record(input: RecordInput): LedgerEvent {
    const event: LedgerEvent = {
      seq: this.seq++,
      ts: new Date(this.clock()).toISOString(),
      type: input.type,
      ledger: input.ledger,
      op: input.op,
      id: input.id,
      ...(input.op === 'upsert' ? { entity: input.entity ?? {} } : {}),
    };
    this.mem.append(event);
    if (this.sink !== this.mem) this.sink.append(event);
    return event;
  }

  /** Events recorded this process, in record order. */
  events(): LedgerEvent[] {
    return [...this.mem.events];
  }

  /** The folded projection of everything recorded this process. */
  fold(): LedgerState {
    return foldLedger(this.mem.events);
  }

  /** Stable hash of the folded projection. */
  stateHash(): string {
    return stateHash(this.fold());
  }
}
