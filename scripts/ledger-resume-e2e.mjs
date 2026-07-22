#!/usr/bin/env node
/**
 * ledger-resume-e2e — proves ABRUPT-crash recovery from the fsync'd ledger.
 *
 * state.json is debounced (≤1s) and only flushed on a graceful shutdown, so a SIGKILL can lose the
 * last window. ledger.jsonl is fsync'd per event, so it survives. This test:
 *   1. boots server A, drives mutations, then SIGKILLs it fast (before the snapshot debounce fires),
 *   2. asserts the snapshot did NOT capture those mutations (recovery cannot come from state.json),
 *   3. boots server B on the SAME state dir — resumeFromLedger folds ledger.jsonl into live state,
 *   4. asserts the entities are back, served by the API, recovered from the ledger alone.
 *
 * Run via tsx: `tsx scripts/ledger-resume-e2e.mjs` (npm run test:ledger-resume-e2e).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const stateDir = mkdtempSync(join(tmpdir(), 't3mp3st-ledger-resume-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[ledger-resume-e2e]', ...a);
let current = null;

function boot(port) {
  const srv = spawn(join(REPO, 'node_modules', '.bin', 'tsx'), ['src/server.ts'], {
    cwd: REPO,
    env: { ...process.env, T3MP3ST_STATE_DIR: stateDir, T3MP3ST_PORT: String(port), T3MP3ST_HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr.on('data', () => {});
  current = srv;
  return srv;
}
function fail(msg) {
  log('FAIL:', msg);
  try { current?.kill('SIGKILL'); } catch { /* gone */ }
  process.exit(1);
}
async function req(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}
async function waitReady(srv, base, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (srv.exitCode !== null) return false;
    try { await fetch(`${base}/api/health`); return true; } catch { await sleep(300); }
  }
  return false;
}

// ── phase 1: server A, drive mutations, abrupt kill ──────────────────────────
const portA = 30000 + Math.floor(Math.random() * 3000);
const baseA = `http://127.0.0.1:${portA}`;
const srvA = boot(portA);
if (!(await waitReady(srvA, baseA))) fail(`server A not ready on ${portA}`);
log('server A up on', portA, '· state dir', stateDir);

const ev = await req(baseA, 'POST', '/api/evidence', { type: 'note', title: 'crash-recovery evidence', summary: 'must survive SIGKILL' });
const f1 = await req(baseA, 'POST', '/api/findings', { title: 'finding that must survive an abrupt crash', severity: 'critical', claim: 'durable via the fsync ledger' });
const h1 = await req(baseA, 'POST', '/api/hypotheses', { claim: 'ledger outlives the snapshot', rationale: 'per-event fsync vs 1s debounce', target: '127.0.0.1', family: 'web_api' });
const evidenceId = ev.data?.id, findingId = f1.data?.id, hypothesisId = h1.data?.id;
if (!evidenceId || !findingId || !hypothesisId) fail(`mutations did not create entities (${evidenceId}, ${findingId}, ${hypothesisId})`);
log('created', findingId, evidenceId, hypothesisId);

// SIGKILL immediately — no graceful flush, and faster than the 1s snapshot debounce.
srvA.kill('SIGKILL');
await sleep(400);

const statePath = join(stateDir, 'state.json');
const ledgerPath = join(stateDir, 'ledger.jsonl');
const snapshotHasFinding = existsSync(statePath) && readFileSync(statePath, 'utf8').includes(findingId);
if (snapshotHasFinding) fail('snapshot already captured the finding — kill was too slow to prove ledger-only recovery; re-run');
if (!existsSync(ledgerPath)) fail('ledger.jsonl was not written before the crash');
const ledgerHasFinding = readFileSync(ledgerPath, 'utf8').includes(findingId);
if (!ledgerHasFinding) fail('ledger.jsonl did not durably capture the finding');
log(`after SIGKILL: snapshot ${existsSync(statePath) ? 'stale (no finding)' : 'absent'}, ledger has the finding ✓`);

// ── phase 2: server B on the same dir — must recover from the ledger ─────────
const portB = 33000 + Math.floor(Math.random() * 3000);
const baseB = `http://127.0.0.1:${portB}`;
const srvB = boot(portB);
if (!(await waitReady(srvB, baseB))) fail(`server B not ready on ${portB}`);
log('server B up on', portB, '(same state dir)');

const findings = await req(baseB, 'GET', `/api/findings`);
const evidence = await req(baseB, 'GET', `/api/evidence`);
const hypotheses = await req(baseB, 'GET', `/api/hypotheses`);
const hasId = (resp, key, id) => Array.isArray(resp.data?.[key]) && resp.data[key].some((x) => x.id === id);

const okF = hasId(findings, 'findings', findingId);
const okE = hasId(evidence, 'evidence', evidenceId);
const okH = hasId(hypotheses, 'hypotheses', hypothesisId);

try { srvB.kill('SIGTERM'); } catch { /* gone */ }
await sleep(300);
try { srvB.kill('SIGKILL'); } catch { /* gone */ }

if (!okF) fail(`finding ${findingId} NOT recovered after restart`);
if (!okE) fail(`evidence ${evidenceId} NOT recovered after restart`);
if (!okH) fail(`hypothesis ${hypothesisId} NOT recovered after restart`);

log(`PASS · abrupt SIGKILL, no snapshot — server B recovered finding+evidence+hypothesis from the ledger`);
process.exit(0);
