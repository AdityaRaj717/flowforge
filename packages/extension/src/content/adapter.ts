import type { ErrorCode, Job } from '@flowforge/core';
import { MODE_OUTPUT } from '@flowforge/core';
import type { SelectorPack, Strategy, TargetId } from '../shared/pack';
import type { CollectedOutput, RefPayload, RunSettings } from '../shared/messages';
import { b64ToBlob } from '../shared/db';
import { clickEl, find, trustedClick, isEnabled, isVisible, matchStrategy, nap, NewTextRecorder, normalize, readText, setText, sleepReal, strategiesFor, waitFor } from './dom';
import { checkSignals, detectPageState, isBusy } from './detect';
import { candidateReady, collect, listMedia, revealVideoThumbs, snapshotKeys } from './media';
import { applyAgentSettings, composerArea, dismissBenignDialogs, uploadViaPicker } from './flowui';

export class JobFailure extends Error {
  constructor(public code: ErrorCode, message: string, public submitted: boolean, public providerMessage?: string) {
    super(message);
  }
}

export interface RunContext {
  job: Job;
  settings: RunSettings;
  refs: RefPayload[];
  pack: SelectorPack;
  taught: Partial<Record<TargetId, Strategy[]>>;
  progress: (state: 'preparing' | 'submitting' | 'generating' | 'verifying', note?: string) => void;
  cancelled: () => boolean;
}

export interface RunResult {
  outputs: CollectedOutput[];
  observed: Job['observed'];
  notes: string[];
}

const PAGE_FAIL: Partial<Record<string, ErrorCode>> = {
  captcha: 'CAPTCHA',
  unusual_activity: 'UNUSUAL_ACTIVITY',
  signed_out: 'SIGNED_OUT',
  not_flow: 'FLOW_TAB_MISSING',
  ui_unknown: 'UI_CHANGED',
};

export async function runJob(ctx: RunContext): Promise<RunResult> {
  const { job, settings, pack, taught } = ctx;
  const notes: string[] = [];
  const want = MODE_OUTPUT[job.mode];
  let submitted = false;
  const checkCancel = () => {
    if (ctx.cancelled()) throw new JobFailure('CANCELLED', 'Cancelled.', submitted);
  };

  // ---- preflight ----
  ctx.progress('preparing', 'checking the Flow tab');
  if (await dismissBenignDialogs(pack, taught)) notes.push("closed Flow's what's-new dialog");
  if (pack.signals.consent.patterns.some((p) => new RegExp(p, 'i').test(document.body.innerText.slice(0, 40_000)))) {
    throw new JobFailure('NEEDS_CONSENT', 'Flow is showing an agreement that only you can accept.', false);
  }
  const state = await waitFor(() => {
    const s = detectPageState(pack, taught);
    return s === 'loading' || s === 'busy' ? null : s;
  }, 30_000, ctx.cancelled);
  checkCancel();
  if (!state) throw new JobFailure('TIMEOUT', 'Flow stayed busy or loading for 30s before the job could start.', false);
  const pageFail = PAGE_FAIL[state];
  if (pageFail) throw new JobFailure(pageFail, `Flow tab is not ready (${state.replace('_', ' ')}).`, false);

  if (settings.freshSession) {
    const ns = find('newSession', pack, taught);
    if (ns && isEnabled(ns.el)) {
      await clickEl(ns.el);
      await sleepReal(900);
    }
  }

  // ---- options ----
  const applied = await applyOptions(ctx, notes);
  checkCancel();

  // ---- references ----
  if (ctx.refs.length) {
    ctx.progress('preparing', `attaching ${ctx.refs.length} reference image(s)`);
    await attachRefs(ctx);
    notes.push(`attached ${ctx.refs.length} reference(s)`);
  }
  checkCancel();

  // ---- prompt ----
  const text = composeText(job, ctx.refs, pack, settings, applied);
  const composer = find('composer', pack, taught);
  if (!composer) throw new JobFailure('UI_ELEMENT_MISSING', 'Prompt box not found.', false);
  await setText(composer.el, text);
  await nap(250);
  if (normalize(readText(composer.el)).length < Math.min(10, normalize(text).length)) {
    throw new JobFailure('UI_CHANGED', 'Typed the prompt but the prompt box did not keep it.', false);
  }

  // ---- submit ----
  ctx.progress('submitting');
  const before = snapshotKeys(pack);
  const recorder = new NewTextRecorder();
  const submit = await waitFor(() => {
    const s = find('submit', pack, taught);
    return s && isEnabled(s.el) ? s : null;
  }, 20_000, ctx.cancelled);
  checkCancel();
  if (!submit) throw new JobFailure('UI_ELEMENT_MISSING', 'Generate button not found or stayed disabled (references still uploading?).', false);
  // Approve buttons already on the page (earlier chat turns) are never clicked; only new ones.
  const staleApprove = new Set(strategiesFor('approve', pack, taught).flatMap((s) => matchStrategy(s)));
  recorder.start();
  const how = await submitAndConfirm(submit.el, composer.el, text, ctx);
  if (!how) {
    recorder.stop();
    throw new JobFailure('UI_CHANGED', 'Clicked Generate but Flow did not start. Re-teach the "Generate / send button" (click the arrow button itself) and try again.', false);
  }
  if (how !== 'trusted') notes.push(`submitted via ${how}`);
  submitted = true;
  ctx.progress('generating', 'submitted');

  try {
    const outputs = await waitForOutputs(ctx, before, recorder, text, () => submitted, staleApprove, submit.el);
    ctx.progress('verifying', `${outputs.length} output(s) found`);
    const collected: CollectedOutput[] = [];
    for (const c of outputs) {
      collected.push(await collect(c, settings.extractLastFrame && c.kind === 'video'));
    }
    const kinds = new Set(collected.map((c) => c.kind));
    if (!kinds.has(want)) notes.push(`expected ${want} output, page produced ${[...kinds].join('/')}`);
    return { outputs: collected, observed: { outputs: collected.length }, notes };
  } finally {
    recorder.stop();
  }
}

async function waitForOutputs(ctx: RunContext, before: Set<string>, rec: NewTextRecorder, typed: string, submitted: () => boolean, staleApprove: Set<Element>, submitEl: Element) {
  const { pack, taught, settings, job } = ctx;
  const want = MODE_OUTPUT[job.mode];
  const expected = job.options.outputs ?? 1;
  const deadline = Date.now() + settings.timeoutSec * 1000;
  let approvals = 0;
  let stableSince = 0;
  let lastCount = -1;
  let sawBusy = false;
  let idleSince = 0; // when Flow last stopped looking busy
  const startedAt = Date.now();

  while (Date.now() < deadline) {
    if (ctx.cancelled()) {
      const stop = find('stop', pack, taught);
      if (stop) await trustedClick(stop.el);
      throw new JobFailure('CANCELLED', 'Cancelled while generating.', submitted());
    }
    await nap(1000);

    const sig = checkSignals(pack, rec.text(), [typed, job.prompt]);
    if (sig) throw new JobFailure(sig.code, sig.message, true, sig.message);

    if (settings.autoApprove && approvals < 4) {
      const submitNow = find('submit', pack, taught)?.el;
      const composer = composerArea(pack, taught);
      // Every match, not just the first: an older, unanswered approval earlier in the chat must not hide this one.
      const ap = strategiesFor('approve', pack, taught)
        .flatMap((s) => matchStrategy(s))
        .find((el) => isVisible(el) && !composer?.contains(el) && !staleApprove.has(el) && el !== submitEl && el !== submitNow && !el.contains(submitEl));
      if (ap && isEnabled(ap) && Date.now() - startedAt > 1500) {
        staleApprove.add(ap);
        await trustedClick(ap as HTMLElement);
        approvals++;
        ctx.progress('generating', 'approved the agent plan');
        stableSince = 0;
        continue;
      }
    }

    const busy = isBusy(pack, taught);
    if (busy) {
      sawBusy = true;
      idleSince = 0;
    } else if (!idleSince) idleSince = Date.now();
    if (want === 'video') revealVideoThumbs(before);
    const all = listMedia(pack);
    let fresh = all.filter((m) => !before.has(m.key));
    const item = pack.media.newestFirstItem;
    if (item) {
      // The first grid tile that existed before submit; anything new is above it, re-rendered old tiles below.
      const anchor = all.find((m) => before.has(m.key) && m.el.closest(item))?.el.closest(item);
      fresh = fresh.filter((m) => {
        const tile = m.el.closest(item);
        if (!tile) return !all.some((o) => o !== m && o.src === m.src); // chat copy of a grid tile
        return !anchor || !!(anchor.compareDocumentPosition(tile) & Node.DOCUMENT_POSITION_PRECEDING);
      });
    }
    const ready = fresh.filter(candidateReady);
    const wanted = ready.filter((m) => m.kind === want);
    // A video job only finishes on a video: Flow re-renders older image tiles as new ones land.
    const count = want === 'video' ? wanted.length : wanted.length || ready.length;
    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
      if (count) ctx.progress('generating', `${count} output(s) so far`);
    }
    // Short of the expected count, give late tiles longer (they lag in background tabs).
    const settleMs = count < expected ? Math.max(15_000, settings.settleSec * 3000) : settings.settleSec * 1000;
    const settled = Date.now() - stableSince >= settleMs;
    if (!busy && count > 0 && (count >= expected || settled)) {
      return wanted.length ? wanted : ready;
    }
    // Not busy, nothing new, and long enough that the agent clearly answered with text instead.
    // Measured from when Flow went idle: tiles render a moment after the Stop button disappears,
    // so timing from the last count change would fail every generation longer than the window.
    // Flow can accept a video and park it ("scheduled ... waiting in the queue due to high demand"):
    // keep waiting until the timeout instead of resubmitting, which would charge credits twice.
    const parked = /scheduled|waiting in the queue|high demand|check back/i.test(rec.text());
    if (!busy && sawBusy && !parked && count === 0 && Date.now() - idleSince > Math.max(25_000, settings.settleSec * 4000)) {
      const tail = rec.text().split('\n').filter((l) => !normalize(typed).includes(normalize(l))).slice(-3).join(' ').slice(0, 300);
      throw new JobFailure('NO_OUTPUT', 'Flow finished without producing media.', true, tail || undefined);
    }
  }
  throw new JobFailure('TIMEOUT', `No finished output after ${settings.timeoutSec}s.`, true);
}

// ---------- options ----------

interface Applied {
  aspect: boolean;
  count: boolean;
  model: boolean;
}

async function chooseFromMenu(menuId: TargetId, words: string[], ctx: RunContext): Promise<boolean> {
  const menu = find(menuId, ctx.pack, ctx.taught);
  if (!menu) return false;
  await clickEl(menu.el);
  await nap(400);
  const rx = words.map((w) => new RegExp(`^\\s*${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
  const opt = await waitFor(() => {
    const els = matchStrategy({ css: '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="radio"], li, button' })
      .filter((e) => isVisible(e) && e !== menu.el && rx.some((r) => r.test((e as HTMLElement).innerText ?? '')));
    return els[0] as HTMLElement | undefined;
  }, 2500);
  if (!opt) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }
  await clickEl(opt);
  await nap(300);
  return true;
}

async function applyOptions(ctx: RunContext, notes: string[]): Promise<Applied> {
  const applied: Applied = { aspect: false, count: false, model: false };
  const { job, settings, pack } = ctx;
  if (settings.optionStrategy === 'none' || settings.optionStrategy === 'instruction') return applied;
  const o = job.options;
  const kind = MODE_OUTPUT[job.mode];
  const panel = o.aspect || o.outputs || o.model ? await applyAgentSettings(kind, { aspect: o.aspect, count: o.outputs, model: o.model }, pack, ctx.taught) : null;
  if (panel) {
    applied.aspect = panel.aspect;
    applied.count = panel.count;
    applied.model = panel.model;
    if (panel.missing.length) notes.push(`Flow has no ${panel.missing.join(', ')} for ${kind}s`);
    if (panel.missing.length && settings.optionStrategy === 'ui') throw new JobFailure('UNSUPPORTED_OPTION', `Flow does not offer ${panel.missing.join(', ')} for ${kind}s.`, false);
    if (panel.changed) notes.push(`set Flow's ${kind} defaults: ${[o.aspect, o.outputs && `x${o.outputs}`, o.model].filter(Boolean).join(', ')}`);
    return applied;
  }
  if (o.aspect) applied.aspect = await chooseFromMenu('aspectMenu', pack.optionText.aspect[o.aspect] ?? [o.aspect], ctx);
  if (o.outputs) applied.count = await chooseFromMenu('countMenu', pack.optionText.count[String(o.outputs)] ?? [String(o.outputs)], ctx);
  if (o.model) applied.model = await chooseFromMenu('modelMenu', [o.model], ctx);
  const missing = (Object.keys(applied) as (keyof Applied)[]).filter((k) => !applied[k] && (k === 'aspect' ? o.aspect : k === 'count' ? o.outputs : o.model));
  if (missing.length && settings.optionStrategy === 'ui') {
    throw new JobFailure('UNSUPPORTED_OPTION', `Could not set ${missing.join(', ')} in Flow's controls.`, false);
  }
  if (Object.values(applied).some(Boolean)) notes.push(`set in Flow UI: ${Object.entries(applied).filter(([, v]) => v).map(([k]) => k).join(', ')}`);
  return applied;
}

// ---------- prompt text ----------

const REF_PHRASE: Record<string, string> = {
  start: 'as the first frame',
  end: 'as the last frame',
  ingredient: 'as an ingredient/reference',
  character: 'as the character reference',
  style: 'as the style reference',
  source: 'as the image to edit',
};

export function composeText(job: Job, refs: RefPayload[], pack: SelectorPack, settings: RunSettings, applied: Applied): string {
  const prompt = job.options.negativePrompt ? `${job.prompt}\n\nAvoid: ${job.options.negativePrompt}` : job.prompt;
  if (settings.optionStrategy === 'none' || settings.optionStrategy === 'ui') return prompt;
  const o = job.options;
  const kind = MODE_OUTPUT[job.mode] === 'image' ? 'image' : 'video';
  const count = o.outputs ?? 1;
  const needs = (!applied.aspect && o.aspect) || (!applied.count && o.outputs && o.outputs > 1) || (!applied.model && o.model) || o.durationSec || refs.length;
  if (!needs && settings.optionStrategy === 'auto') return prompt;
  let text = pack.instruction.template
    .replace('{count}', applied.count ? 'the' : String(count))
    .replace('{kind}', `${kind}${count > 1 && !applied.count ? 's' : ''}`)
    .replace('{aspectPhrase}', !applied.aspect && o.aspect ? `in ${o.aspect} aspect ratio` : '')
    .replace('{modelPhrase}', !applied.model && o.model ? ` with ${o.model}` : '')
    .replace('{durationPhrase}', o.durationSec && kind === 'video' ? `, ${o.durationSec} seconds long` : '')
    .replace('{prompt}', prompt);
  if (refs.length) {
    const lines = refs.map((r, i) => `attached image ${i + 1} ${REF_PHRASE[r.role] ?? ''}`.trim());
    text = text.replace(/\. Use this prompt exactly:/, `. Use ${lines.join('; ')}. Use this prompt exactly:`);
  }
  return text.replace(/ {2,}/g, ' ').replace(/ \./g, '.');
}

// ---------- references ----------

async function attachRefs(ctx: RunContext): Promise<void> {
  const { pack, taught } = ctx;
  const files = ctx.refs.map((r, i) => new File([b64ToBlob(r.dataB64, r.mime)], r.name || `ref_${i + 1}.png`, { type: r.mime }));
  let input = find('fileInput', pack, taught, { visible: false });
  const area = composerArea(pack, taught);
  const chipsBefore = area?.querySelectorAll('img').length ?? 0;
  if (!input) {
    const r = await uploadViaPicker(files, pack, taught, ctx.cancelled);
    if (r === 'consent') throw new JobFailure('NEEDS_CONSENT', 'Flow asked you to confirm you have the rights to the uploaded images.', false);
    if (r === 'ok') {
      // Uploaded through Flow's own picker; wait for the attachment chips in the prompt box.
      const ok = await waitFor(() => (composerArea(pack, taught)?.querySelectorAll('img').length ?? 0) >= chipsBefore + 1, 30_000, ctx.cancelled);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (!ok) throw new JobFailure('UI_ELEMENT_MISSING', 'Uploaded the references, but they did not show up in the prompt box. Teach the "Add image" control or attach them by hand.', false);
      await sleepReal(1200);
      return;
    }
    input = find('fileInput', pack, taught, { visible: false });
  }
  const before = document.querySelectorAll('img').length;
  if (input && input.el instanceof HTMLInputElement) {
    const dt = new DataTransfer();
    const multi = input.el.multiple;
    for (const f of multi ? files : files.slice(0, 1)) dt.items.add(f);
    input.el.files = dt.files;
    input.el.dispatchEvent(new Event('input', { bubbles: true }));
    input.el.dispatchEvent(new Event('change', { bubbles: true }));
    // Inputs that take one file at a time get the rest one by one.
    if (!multi) {
      for (const f of files.slice(1)) {
        await nap(1200);
        const again = find('fileInput', pack, taught, { visible: false });
        if (!(again?.el instanceof HTMLInputElement)) break;
        const d2 = new DataTransfer();
        d2.items.add(f);
        again.el.files = d2.files;
        again.el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  } else {
    // Last resort: drop the files on the prompt box, as a person dragging them in would.
    const composer = find('composer', pack, taught);
    if (!composer) throw new JobFailure('UI_ELEMENT_MISSING', 'No way to attach references (no file input, attach button or prompt box).', false);
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    for (const type of ['dragenter', 'dragover', 'drop']) {
      composer.el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
  }
  // Wait until previews show up (new images on the page), so submit doesn't race the upload.
  const ok = await waitFor(() => document.querySelectorAll('img').length >= before + Math.min(1, files.length), 15_000, ctx.cancelled);
  if (!ok) throw new JobFailure('UI_ELEMENT_MISSING', 'Reference images did not appear in Flow after attaching.', false);
  await sleepReal(1200);
}

/**
 * Flow ignores script-made clicks and key presses on Generate (it checks isTrusted), so the
 * submit goes through the background's trusted click. Confirms Flow actually started; falls back
 * to a plain DOM click (mock pages, or the debugger could not attach). Returns how it went
 * through, or null when nothing worked.
 */
async function submitAndConfirm(btn: HTMLElement, composer: HTMLElement, text: string, ctx: RunContext): Promise<'trusted' | 'click' | null> {
  const { pack, taught } = ctx;
  const want = normalize(text).length;
  const started = () => {
    if (isBusy(pack, taught)) return true;
    const box = find('composer', pack, taught)?.el ?? composer;
    // Flow clears the prompt box once it accepts the prompt.
    return normalize(readText(box)).length < Math.min(10, want);
  };
  const tryIt = async (fire: () => Promise<unknown>) => {
    await fire();
    return !!(await waitFor(() => started() || null, 4000, ctx.cancelled));
  };
  const target = (btn.closest('button, [role="button"]') as HTMLElement | null) ?? btn;
  let trustedErr = '';
  if (
    await tryIt(async () => {
      const r = await trustedClick(target);
      if (!r.ok) trustedErr = r.error ?? 'failed';
    })
  )
    return trustedErr ? 'click' : 'trusted';
  if (await tryIt(() => clickEl(target))) return 'click';
  if (trustedErr) throw new JobFailure('UI_CHANGED', `Could not press Generate: ${trustedErr}`, false);
  return null;
}
