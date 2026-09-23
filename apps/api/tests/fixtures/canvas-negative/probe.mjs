import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(process.argv[2] ?? join(fixtureDir, 'evidence'));
const browserBin = process.env.AGENT_BROWSER_BIN ?? 'agent-browser';
const html = await readFile(join(fixtureDir, 'index.html'));
await mkdir(outputDir, { recursive: true });
const server = createServer((req, res) => {
  if (req.url?.startsWith('/favicon.ico')) { res.writeHead(204).end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
});
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const port = server.address().port;
const sessions = [];
const command = async (session, args, input) => {
  const child = spawn(browserBin, ['--session', session, '--json', ...args]);
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  const status = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error(`agent-browser ${args[0]} timed out`)); }, 30_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolveExit(code); });
  });
  if (status !== 0) throw Error(`agent-browser ${args[0]} failed: ${stderr || stdout}`);
  try { return JSON.parse(stdout); } catch { return stdout.trim(); }
};
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const cases = [
  { mode: 'blank', keys: ['ArrowRight', 'ArrowDown', 'Space'] },
  { mode: 'menu', keys: ['ArrowRight', 'ArrowDown', 'Space'] },
  { mode: 'disconnected', keys: ['ArrowRight', 'ArrowDown', 'Space'] },
  { mode: 'fake-score', keys: ['ArrowRight', 'ArrowDown'] },
  { mode: 'no-collision', keys: Array(8).fill('ArrowRight') },
];
const records = [];
try {
  const version = spawnSync(browserBin, ['--version'], { encoding: 'utf8' }).stdout.trim();
  for (const scenario of cases) {
    const session = `pivloom-neg-${process.pid}-${scenario.mode}`;
    sessions.push(session);
    await command(session, ['open', `http://127.0.0.1:${port}/?mode=${scenario.mode}`]);
    const snapshot = await command(session, ['snapshot', '-i']);
    const initialPage = join(outputDir, `${scenario.mode}-page-initial.png`);
    await command(session, ['screenshot', initialPage]);
    const click = await command(session, ['click', '@e2']);
    const beforeHud = await command(session, ['get', 'text', '#hud']);
    const beforeCanvas = join(outputDir, `${scenario.mode}-canvas-before.png`);
    await command(session, ['screenshot', 'canvas', beforeCanvas]);
    const batchCommands = scenario.keys.flatMap(key => [['press', key], ['wait', '100']]);
    const batch = await command(session, ['batch', '--bail'], JSON.stringify(batchCommands));
    const afterHud = await command(session, ['get', 'text', '#hud']);
    const afterCanvas = join(outputDir, `${scenario.mode}-canvas-after.png`);
    const afterPage = join(outputDir, `${scenario.mode}-page-after.png`);
    await command(session, ['screenshot', 'canvas', afterCanvas]);
    await command(session, ['screenshot', afterPage]);
    records.push({mode:scenario.mode,session,version,keys:scenario.keys,
      snapshot,click,batch,beforeHud,afterHud,
      canvasBeforeSha256:await sha256(beforeCanvas),canvasAfterSha256:await sha256(afterCanvas),
      pageInitialSha256:await sha256(initialPage),pageAfterSha256:await sha256(afterPage),
      console:await command(session,['console']),pageErrors:await command(session,['errors'])});
  }
  await writeFile(join(outputDir,'manifest.json'), JSON.stringify({source:'isolated static Canvas fixture',browserVersion:version,
    capturedAt:new Date().toISOString(),cases:records},null,2)+'\n');
  process.stdout.write(JSON.stringify(records.map(({mode,version,keys,beforeHud,afterHud,canvasBeforeSha256,canvasAfterSha256,pageErrors,batch})=>({
    mode,version,keys,beforeHud,afterHud,canvasChanged:canvasBeforeSha256!==canvasAfterSha256,
    keyResults:Array.isArray(batch)?batch.map(result=>result.success):batch,pageErrors,
  })),null,2)+'\n');
} finally {
  for (const session of sessions) {
    try { await command(session, ['close']); } catch { /* A closed fixture session needs no retry. */ }
  }
  await new Promise(resolveClose => server.close(resolveClose));
}
