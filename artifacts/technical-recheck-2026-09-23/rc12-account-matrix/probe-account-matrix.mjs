import { spawnSync } from 'node:child_process';

// Run from an already authenticated, named agent-browser session on the Web
// origin. The bearer token stays inside that browser; this script emits only
// HTTP statuses and nonsecret counts. Example:
// AGENT_BROWSER_SESSION=rc12-a agent-browser tab t1
// AGENT_BROWSER_SESSION=rc12-a node probe-account-matrix.mjs PROJECT REV RUN CHECK ARTIFACT
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const [projectId, revisionId, runId, checkId, artifactId] = process.argv.slice(2);
if (![projectId, revisionId, runId, checkId, artifactId].every(id => uuid.test(id ?? '')))
  throw new Error('Five exact UUID arguments are required.');
if (!process.env.AGENT_BROWSER_SESSION)
  throw new Error('Use an explicit AGENT_BROWSER_SESSION.');

const input = `
(async () => {
  if (location.origin !== 'https://pivloom-69-5-7-187.sslip.io') throw Error('WRONG_WEB_ORIGIN');
  const stored = JSON.parse(localStorage.getItem('pivloom.auth.v1') || 'null');
  if (!stored?.access_token) throw Error('NOT_AUTHENTICATED');
  const ids = ${JSON.stringify({ projectId, revisionId, runId, checkId, artifactId })};
  const paths = [
    ['own-project-list', '/api/v1/projects'],
    ['project-dialogue', '/api/v1/projects/' + ids.projectId],
    ['versions', '/api/v1/projects/' + ids.projectId + '/revisions'],
    ['source-manifest', '/api/v1/revisions/' + ids.revisionId + '/files'],
    ['source-file', '/api/v1/revisions/' + ids.revisionId + '/file?path=src%2FApp.tsx'],
    ['check', '/api/v1/revisions/' + ids.revisionId + '/check'],
    ['check-artifact', '/api/v1/checks/' + ids.checkId + '/artifacts/' + ids.artifactId],
    ['preview-metadata', '/api/v1/projects/' + ids.projectId + '/preview?revisionId=' + ids.revisionId],
    ['run', '/api/v1/runs/' + ids.runId],
  ];
  const output = [];
  for (const [name, path] of paths) {
    const response = await fetch(path, {
      headers: { Authorization: 'Bearer ' + stored.access_token },
      redirect: 'manual', cache: 'no-store',
    });
    const body = response.ok && name !== 'check-artifact' ? await response.json() : null;
    if (!body) await response.body?.cancel().catch(() => {});
    output.push({ name, status: response.status,
      ...(name === 'project-dialogue' && body ? { messageCount: body.messages?.length, currentRevisionId: body.project?.currentRevisionId } : {}),
      ...(name === 'versions' && body ? { revisionCount: body.revisions?.length } : {}),
      ...(name === 'source-manifest' && body ? { fileCount: body.files?.length, sourceHash: body.sourceHash } : {}),
      ...(name === 'source-file' && body ? { sourceLength: body.content?.length, sourceSha256: body.sha256 } : {}),
      ...(name === 'check' && body ? { verdict: body.check?.verdict } : {}),
      ...(name === 'preview-metadata' && body ? { previewState: body.preview?.state ?? null } : {}),
      ...(name === 'run' && body ? { runState: body.run?.state } : {}),
    });
  }
  return output;
})()
`;
const result = spawnSync('agent-browser', ['eval', '--stdin'], {
  input, encoding: 'utf8', env: process.env, timeout: 30_000,
});
if (result.status !== 0) throw new Error('Browser account probe failed; inspect the named session and Web origin.');
process.stdout.write(result.stdout);
