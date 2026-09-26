/**
 * Judging the behaviours whose result depends on appearance, without letting a model near the browser.
 *
 * The deterministic replay kernel drives the steps and captures the screenshots for these behaviours
 * exactly as it does for the script-decidable ones; this module only asks a model what the captured
 * pixels show. That separation is the whole point: the moment a model starts operating the browser,
 * one action costs one request and forty behaviours cost half an hour again, which is the cost this
 * work exists to remove.
 *
 * Every outcome is fail-closed. A behaviour is `passed` only when the answer is parseable, carries an
 * entry for it, quotes something it actually saw, and had an image to look at. Anything else —
 * unparseable output, a missing entry, an empty or restated citation, no image, no budget left — is
 * `blocked`. This matters right now rather than in theory: the configured model currently fails the
 * platform's vision probe, so a model that cannot see must produce blocked results, never confident
 * approvals.
 */
export interface VisualJudgementBehaviour {
  id: string;
  expected: string;
  images: Array<{ base64: string; mimeType: string }>;
}

export interface VisualJudgement {
  verdict: 'passed' | 'failed' | 'blocked';
  reason: string;
}

export interface VisualJudgementInput {
  behaviours: VisualJudgementBehaviour[];
  /** Injected by the caller, so this module holds no provider client and no network of its own. */
  request: (prompt: string, images: Array<{ base64: string; mimeType: string }>) => Promise<string>;
  /** Remaining share of the verification budget. Past it nothing more is asked or accepted. */
  deadlineMs: number;
  now: () => number;
}

interface JudgementEntry { id?: unknown; verdict?: unknown; citation?: unknown }

/** Asks for one line per behaviour and forbids anything but the two verdicts. */
export function visualJudgementPrompt(behaviours: VisualJudgementBehaviour[]): string {
  const lines = behaviours.map((behaviour) =>
    `- ${behaviour.id}: ${behaviour.expected}`).join('\n');
  return `You are shown screenshots captured from one application, one set per behaviour below.
For each behaviour, decide from the pixels alone whether the expectation holds.

${lines}

Answer with JSON only, no prose: {"judgements":[{"id":"B01","verdict":"passed|failed","citation":"..."}]}
"citation" must quote what you actually saw for that behaviour — a value, colour, position or text
visible in its screenshot. Do not restate the expectation. An empty, invented or restated citation
cannot count as a pass.`;
}

/**
 * A citation proves nothing if it merely repeats the expectation, which a model can produce without
 * looking at anything. Requiring at least the citation's own words is a weak but real bar: the
 * screenshot's content is not in the prompt, so a genuine observation has to come from the pixels.
 */
function citesSomething(citation: string, expected: string) {
  const trimmed = citation.trim();
  if (!trimmed) return false;
  return trimmed !== expected.trim();
}

export async function judgeVisualBehaviours(input: VisualJudgementInput): Promise<Map<string, VisualJudgement>> {
  const started = input.now();
  const results = new Map<string, VisualJudgement>();
  const blockAll = (reason: string) => {
    for (const behaviour of input.behaviours) results.set(behaviour.id, { verdict: 'blocked', reason });
    return results;
  };
  if (input.behaviours.length === 0) return results;
  // No request is sent when the budget is already gone; the caller's clock decides, not a timer here.
  if (started + input.deadlineMs <= input.now()) return blockAll('budget');
  const images = input.behaviours.flatMap((behaviour) => behaviour.images);
  let answer: string;
  try {
    answer = await input.request(visualJudgementPrompt(input.behaviours), images);
  } catch {
    return blockAll('request-failed');
  }
  // An answer that arrives after the deadline is as unusable as one never sent.
  if (started + input.deadlineMs <= input.now()) return blockAll('budget');
  let entries: JudgementEntry[];
  try {
    const parsed = JSON.parse(answer) as { judgements?: unknown };
    if (!Array.isArray(parsed.judgements)) return blockAll('unparseable');
    entries = parsed.judgements as JudgementEntry[];
  } catch {
    return blockAll('unparseable');
  }
  for (const behaviour of input.behaviours) {
    const entry = entries.find((candidate) => candidate?.id === behaviour.id);
    if (!entry) { results.set(behaviour.id, { verdict: 'blocked', reason: 'missing-entry' }); continue; }
    if (entry.verdict === 'failed') { results.set(behaviour.id, { verdict: 'failed', reason: 'reported' }); continue; }
    if (entry.verdict !== 'passed') { results.set(behaviour.id, { verdict: 'blocked', reason: 'invalid-verdict' }); continue; }
    if (behaviour.images.length === 0) { results.set(behaviour.id, { verdict: 'blocked', reason: 'no-image' }); continue; }
    const citation = typeof entry.citation === 'string' ? entry.citation : '';
    if (!citesSomething(citation, behaviour.expected)) {
      results.set(behaviour.id, { verdict: 'blocked', reason: 'uncited' });
      continue;
    }
    results.set(behaviour.id, { verdict: 'passed', reason: citation.slice(0, 200) });
  }
  return results;
}
