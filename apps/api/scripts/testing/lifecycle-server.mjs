// Isolated E13/E14 launcher. Production server.ts never imports this file.
// All responses replace Provider HTTP only; Pi, PostgreSQL and OpenSandbox stay real.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { createApp } from '../../dist/app.js';

const databaseName = new URL(process.env.DATABASE_URL).pathname.slice(1);
if (process.env.NODE_ENV !== 'test' || !/^pivloom_e2e_test_[a-z0-9_]+$/.test(databaseName))
  throw Error('Lifecycle launcher requires an explicitly isolated E2E database');
if (!process.env.LIFECYCLE_PROFILE || !process.env.LIFECYCLE_GATE)
  throw Error('Private scenario and gate paths are required');
const profileSchema = z.strictObject({
  ownerId: z.uuid(), projectId: z.uuid(), createdAfter: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  scenario: z.enum(['SLOW_COORDINATOR', 'SLOW_BUILDER', 'SLOW_REVIEWER', 'LONG_REMOTE_COMMAND', 'BASELINE_ACCEPT', 'MODEL_ERROR_ONCE']),
});
const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const environment = await pool.query('SELECT environment_id FROM nano.environment_identity WHERE id=true');
if (environment.rows[0]?.environment_id !== process.env.PIVLOOM_ENVIRONMENT_ID)
  throw Error('Isolated database identity mismatch');
let lockedRunId;
let failedRunId;
let retryRunId;
let builderTurns = 0;
const plan = {
  schemaVersion: 1, goal: '可操作的中文计数器', changeSummary: '初始为零，点击加一显示一',
  assumptions: [], outOfScope: [],
  behaviors: [{ id: 'B01', title: '点击加一', precondition: '初始数字为零',
    action: '点击加一按钮', expected: '数字显示一', required: true }],
};
function response(tool, args) {
  const delta = tool
    ? { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }
    : { role: 'assistant', content: '已完成当前工作。' };
  const chunk = { id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: 'lifecycle-fixture',
    choices: [{ index: 0, delta, finish_reason: null }] };
  const final = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
}
async function stalled(signal, role, runId) {
  await writeFile(process.env.LIFECYCLE_GATE, JSON.stringify({ role, runId, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  console.info(JSON.stringify({ event: 'LIFECYCLE_GATE', role, runId }));
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Fixture safety timeout')), 180_000);
    const stop = () => { clearTimeout(timer); reject(new DOMException('Fixture Provider was aborted', 'AbortError')); };
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
}
const modelFetch = async (_url, init) => {
  const profile = profileSchema.parse(JSON.parse(await readFile(process.env.LIFECYCLE_PROFILE, 'utf8')));
  if (Date.parse(profile.expiresAt) <= Date.now()) throw Error('Lifecycle profile expired');
  const rows = await pool.query(`SELECT id,retry_of FROM nano.runs WHERE owner_id=$1 AND project_id=$2
    AND created_at >= $3 ORDER BY created_at DESC LIMIT 1`, [profile.ownerId, profile.projectId, profile.createdAfter]);
  const runId = rows.rows[0]?.id;
  if (!runId) throw Error('Lifecycle fixture run scope mismatch');
  if (profile.scenario === 'MODEL_ERROR_ONCE') {
    if (!failedRunId) failedRunId = runId;
    else if (runId !== failedRunId && !retryRunId) {
      if (rows.rows[0].retry_of !== failedRunId) throw Error('Lifecycle fixture requires a linked retry');
      retryRunId = runId;
    } else if (runId !== failedRunId && runId !== retryRunId) throw Error('Lifecycle fixture accepts only one linked retry');
    if (runId === failedRunId) return new Response(JSON.stringify({ error: { message: 'Fixture invalid credential', type: 'invalid_api_key' } }),
      { status: 401, headers: { 'content-type': 'application/json' } });
  } else {
    if (lockedRunId && lockedRunId !== runId) throw Error('Lifecycle fixture run scope mismatch');
    lockedRunId = runId;
  }
  const request = JSON.parse(String(init?.body));
  const names = (request.tools ?? []).map((tool) => tool.function?.name);
  if (names.includes('submit_plan')) {
    if (profile.scenario === 'SLOW_COORDINATOR') return stalled(init?.signal, 'coordinator', runId);
    return response('submit_plan', { plan });
  }
  if (names.includes('write')) {
    if (profile.scenario === 'SLOW_BUILDER') return stalled(init?.signal, 'builder', runId);
    if (profile.scenario === 'LONG_REMOTE_COMMAND') {
      const source = 'const {spawn}=require("node:child_process");spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log("LIFECYCLE_REMOTE_READY");setInterval(()=>console.log("LIFECYCLE_REMOTE_TICK"),250);';
      return response('bash', { command: `node -e '${source.replaceAll("'", "'\\''")}'` });
    }
    if (++builderTurns === 1) return response('write', { path: 'src/App.tsx', content: 'import {useState} from "react"; export default function App(){const [n,setN]=useState(0);return <main><p>{n}</p><button onClick={()=>setN(n+1)}>加一</button></main>}' });
    return response();
  }
  if (names.includes('browser_open')) {
    if (profile.scenario === 'SLOW_REVIEWER') return stalled(init?.signal, 'reviewer', runId);
    if (profile.scenario !== 'BASELINE_ACCEPT' && profile.scenario !== 'MODEL_ERROR_ONCE') throw Error('Reviewer fixture is outside its scenario');
    const calls = request.messages.flatMap((message) => message.tool_calls ?? []).map((call) => call.function.name);
    const last = request.messages.filter((message) => message.role === 'tool').at(-1);
    const observed = last ? JSON.parse(last.content) : null;
    if (!calls.includes('browser_open')) return response('browser_open', { path: '/' });
    if (!calls.includes('browser_click')) {
      const target = Object.entries(observed?.refs ?? {}).find(([, value]) => value?.role === 'button' && value?.name === '加一')?.[0];
      if (!target) throw Error('Fixture cannot find its real counter button');
      return response('browser_click', { behaviorId: 'B01', observationId: observed.observationId, ref: target });
    }
    return response('record_behavior', { behaviorId: 'B01', verdict: 'passed', expected: plan.behaviors[0].expected,
      actual: '点击加一后实际页面数字显示一', observationEventIds: [observed.id], screenshotIds: [], reproSteps: ['点击加一'] });
  }
  throw Error('Unexpected Provider tool declaration in lifecycle fixture');
};
const app = createApp({ env: process.env, logger: false,
  previewListen: { host: '127.0.0.1', port: Number(process.env.PREVIEW_PORT) },
  generationBoundaries: { modelFetch },
});
await app.ready();
await app.recoverStaleRuns();
await app.listen({ host: '127.0.0.1', port: Number(process.env.API_PORT) });
console.info('Isolated lifecycle E2E API ready');
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => void app.close().then(() => pool.end()).then(() => process.exit(0)));
