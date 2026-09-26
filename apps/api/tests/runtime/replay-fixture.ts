import { createHash, randomUUID } from 'node:crypto';
import type { BrowserAction, BrowserObservation } from '../../src/runtime/browser.js';
import type { ReviewBrowser } from '../../src/runtime/reviewer.js';

/**
 * The scripted-replay tests need a browser that behaves like the real CLI does
 * for a form page: each observation mints fresh refs, and the visible text only
 * changes after a real action. Anything looser would let a stale-ref or
 * assertion bug pass unnoticed.
 */
export interface FormState {
  text?: string;
  tree?: string;
  refs?: Record<string, { role?: string; name?: string }>;
}
export interface FormFixtureOptions {
  /** State after the first open, and for every later observation until a step is listed. */
  initial?: FormState;
  /** State keyed by the number of real actions taken. Exact per action count: no implicit mutation. */
  after?: Record<number, FormState>;
  logs?: Record<string, unknown>;
  /** Make every observation report truncation, which must be a stale ref for a control step. */
  truncated?: boolean;
  /** Add an extra control that collides with an existing role+name, making resolution ambiguous. */
  duplicateControl?: { role: string; name: string };
}
export interface FormFixture {
  browser: ReviewBrowser;
  /** Every observation this fake handed out, in order. */
  observations: BrowserObservation[];
  actions: BrowserAction[];
  calls: { open: number; observe: number; act: number; resize: number; screenshot: number; logs: number; close: number };
  state: { actions: number };
}
export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0KAAAAABJRU5ErkJggg==';
export const PNG_SHA256 = createHash('sha256').update(Buffer.from(PNG_BASE64, 'base64')).digest('hex');
const DEFAULT_STATE: Required<FormState> = { text: '空书单', tree: 'textbox 书名 [ref=e1]\nbutton 添加 [ref=e2]',
  refs: { e1: { role: 'textbox', name: '书名' }, e2: { role: 'button', name: '添加' } } };
export function formFixture(sessionId: string, options: FormFixtureOptions = {}): FormFixture {
  const calls = { open: 0, observe: 0, act: 0, resize: 0, screenshot: 0, logs: 0, close: 0 };
  const observations: BrowserObservation[] = [];
  const actions: BrowserAction[] = [];
  const state = { actions: 0 };
  const mint = () => {
    const current: FormState = { ...DEFAULT_STATE, ...options.initial, ...options.after?.[state.actions] };
    const refs = { ...current.refs };
    if (options.duplicateControl) refs.e3 = { ...options.duplicateControl };
    const value: BrowserObservation = { id: randomUUID(), sessionId, url: 'http://127.0.0.1:4173/',
      tree: current.tree ?? '', text: current.text ?? '', truncated: options.truncated ?? false, refs };
    observations.push(value);
    return value;
  };
  const browser: ReviewBrowser = {
    sessionId,
    open: async () => { calls.open++; return mint(); },
    observe: async () => { calls.observe++; return mint(); },
    resize: async (width, height) => { calls.resize++; return { ...mint(), text: `[viewport] width=${width} height=${height} scrollWidth=${width}` }; },
    act: async (action) => { calls.act++; actions.push(action); state.actions++; return mint(); },
    logs: async () => { calls.logs++; return options.logs ?? { errors: [] }; },
    screenshot: async () => { calls.screenshot++; return { base64: PNG_BASE64, mimeType: 'image/png', sha256: PNG_SHA256 }; },
    close: async () => { calls.close++; return { confirmed: true }; },
  };
  return { browser, observations, actions, calls, state };
}
