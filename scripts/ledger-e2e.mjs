#!/usr/bin/env node
/**
 * ledger-e2e — the replay-equivalence gate, end to end against the REAL server.
 *
 * Boots src/server.ts with a temp state dir, drives a scripted sequence of CRUD mutations over
 * the covered ledgers (evidence, findings, retests, hypotheses, work-orders, mission-drafts,
 * approvals), triggers a graceful shutdown to flush state.json, then proves the load-bearing
 * property: fold(ledger.jsonl) === the snapshot the engine actually persisted, for every covered
 * ledger. A failed POST just means that entity was never created — fold==snapshot still holds.
 *
 *   node scripts/ledger-e2e.mjs                # assert only (CI/local gate before push)
 *   node scripts/ledger-e2e.mjs --emit-golden  # also (re)write bench/replay goldens from this run
 *
 * Run via tsx (imports the TS ledger module directly): `tsx scripts/ledger-e2e.mjs`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldLedger, stateHash, readLedgerFile } from '../src/ledger/index.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const EMIT_GOLDEN = process.argv.includes('--emit-golden');
const COVERED = [
  'approvalRequests', 'evidenceLedger', 'findingsLedger', 'retestLedger', 'hypothesisLedger',
  'workOrderLedger', 'missionDrafts', 'improvementProposals', 'memoryProposals', 'memoryCapsule',
  'watchCycleLedger',
];
const PORT = 30000 + Math.floor(Math.random() * 5000);
const BASE = `http://127.0.0.1:${PORT}`;
const stateDir = mkdtempSync(join(tmpdir(), 't3mp3st-ledger-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[ledger-e2e]', ...a);

const server = spawn(join(REPO, 'node_modules', '.bin', 'tsx'), ['src/server.ts'], {
  cwd: REPO,
  env: { ...process.env, T3MP3ST_STATE_DIR: stateDir, T3MP3ST_PORT: String(PORT), T3MP3ST_HOST: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'pipe'], // stdout→/dev/null so its banner can't fill the pipe and deadlock
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d.toString(); });

function fail(msg) {
  log('FAIL:', msg);
  try { server.kill('SIGKILL'); } catch { /* already gone */ }
  process.exit(1);
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

async function waitReady(timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (server.exitCode !== null) return false; // died at startup
    try { await fetch(`${BASE}/api/health`); return true; } catch { await sleep(300); }
  }
  return false;
}

if (!(await waitReady())) fail(`server did not become ready on ${PORT}\n--- stderr ---\n${serverErr}`);
log('server up on', PORT, '· state dir', stateDir);

// ── scripted mutations (order matters for the cross-entity captures) ──────────
await req('POST', '/api/evidence', { type: 'note', title: 'recon note', summary: 'verbose error page observed' });

const f1 = await req('POST', '/api/findings', { title: 'reflected xss in search', severity: 'high', claim: 'user input reflected unencoded', impact: 'session theft' });
const findingId = f1.data?.id;
if (findingId) {
  await req('PATCH', `/api/findings/${findingId}`, { status: 'validated' });
  const rt = await req('POST', `/api/findings/${findingId}/retest`, { method: 'replay the payload', acceptanceCriteria: ['no reflection in response'] });
  const retestId = rt.data?.id;
  if (retestId) await req('PATCH', `/api/retests/${retestId}`, { status: 'passed', resultSummary: 'no longer reflects' });
}

const h1 = await req('POST', '/api/hypotheses', { claim: 'idor on /api/orders', rationale: 'sequential ids', target: '127.0.0.1', family: 'web_api' });
const hypothesisId = h1.data?.id;
if (hypothesisId) {
  await req('PATCH', `/api/hypotheses/${hypothesisId}`, { status: 'testing' });
  const wo = await req('POST', '/api/work-orders', { hypothesisId, kind: 'prove', title: 'enumerate order ids' });
  const workOrderId = wo.data?.id;
  if (workOrderId) await req('PATCH', `/api/work-orders/${workOrderId}`, { status: 'running' });
}

const d1 = await req('POST', '/api/mission-drafts', { title: 'engagement alpha', objective: 'test the staging api', scope: ['staging.example.test'] });
const draftId = d1.data?.id;
if (draftId) await req('PATCH', `/api/mission-drafts/${draftId}`, { objective: 'test the staging api thoroughly' });

const ap = await req('POST', '/api/approvals/request', { action: 'network_request', target: '127.0.0.1', reason: 'authorized recon' });
const approvalId = ap.data?.id;
if (approvalId) await req('POST', `/api/approvals/${approvalId}/approve`, {});

// ── graceful shutdown → flushes the debounced state.json snapshot ─────────────
await sleep(600); // let the async appendStateEvent settle (ledger.jsonl is already fsync'd per event)
await new Promise((resolve) => {
  server.once('exit', resolve);
  server.kill('SIGTERM');
  setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 10000);
});
await sleep(200);

// ── the assertion: fold(ledger) === snapshot, per covered ledger ──────────────
const statePath = join(stateDir, 'state.json');
const ledgerPath = join(stateDir, 'ledger.jsonl');
if (!existsSync(statePath)) fail(`state.json not written (${statePath})\n${serverErr}`);
if (!existsSync(ledgerPath)) fail(`ledger.jsonl not written (${ledgerPath})\n${serverErr}`);

const snap = JSON.parse(readFileSync(statePath, 'utf8'));
const snapProjection = {};
for (const name of COVERED) {
  const arr = Array.isArray(snap[name]) ? snap[name] : [];
  if (!arr.length) continue;
  const m = {};
  for (const e of arr) m[e.id] = e;
  snapProjection[name] = m;
}

const events = readLedgerFile(ledgerPath);
const folded = foldLedger(events);
const foldHash = stateHash(folded);
const snapHash = stateHash(snapProjection);

log(`events=${events.length} · ledgers=[${Object.keys(folded).sort().join(', ')}]`);
log('fold hash', foldHash);
log('snap hash', snapHash);

if (foldHash !== snapHash) {
  for (const name of new Set([...Object.keys(folded), ...Object.keys(snapProjection)])) {
    if (stateHash(folded[name] || {}) !== stateHash(snapProjection[name] || {})) {
      log(`  DIVERGE ${name}: fold has ${Object.keys(folded[name] || {}).length}, snapshot has ${Object.keys(snapProjection[name] || {}).length}`);
    }
  }
  fail('fold(ledger.jsonl) != snapshot(state.json)');
}
if (stateHash(foldLedger(events)) !== foldHash) fail('fold is not idempotent');
if (events.length < 8) fail(`only ${events.length} events recorded — scenario under-exercised the ledger`);

log(`PASS · fold(ledger.jsonl) === snapshot(state.json) across ${Object.keys(folded).length} ledgers, ${events.length} events`);

if (EMIT_GOLDEN) {
  const outDir = join(REPO, 'bench', 'replay');
  mkdirSync(outDir, { recursive: true });
  copyFileSync(ledgerPath, join(outDir, 'golden.ledger.jsonl'));
  writeFileSync(join(outDir, 'golden.state.sha256'), `${foldHash}\n`);
  writeFileSync(join(outDir, 'golden.projection.json'), `${JSON.stringify(folded, null, 2)}\n`);
  log('golden written → bench/replay/ (state hash', `${foldHash})`);
}
process.exit(0);
