/**
 * Mission Ledger — a foldable, append-only event log for the mission/evidence engine.
 *
 * The engine's authoritative state re-derives from a committed event log the same way every
 * benchmark headline re-derives from committed JSON: fold the log, hash the projection, compare.
 * This barrel is the module's public surface; the server wires it at the contract-event choke
 * point, and `verify-claims` folds a committed golden to prove replay-equivalence with no LLM.
 *
 * Honest scope: this re-derives a RECORDED run — it does not claim that re-running the live
 * agents reproduces it (agent/tool output is nondeterministic and captured once, as data).
 */

export * from './types.js';
export * from './canonical.js';
export * from './fold.js';
export * from './sink.js';
export * from './ledger.js';
