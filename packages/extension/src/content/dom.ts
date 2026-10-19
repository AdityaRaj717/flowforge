import type { SelectorPack, Strategy, TargetId } from '../shared/pack';

// DOM helpers for driving Flow like a person would: find a visible control, click it, type.
// Everything is resolved through the selector pack, so a Flow redesign is a data update.

export const OVERLAY_ID = 'flowforge-overlay';

/** All elements under root, descending into open shadow roots. */
export function allElements(root: ParentNode = document): Element[] {
  const out: Element[] = [];
  const walk = (r: ParentNode) => {
    r.querySelectorAll('*').forEach((el) => {
      out.push(el);
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) walk(sr);
    });
  };
  walk(root);
  return out;
}

function deepQuery(css: string): Element[] {
  const hits: Element[] = [...document.querySelectorAll(css)];
  // Shadow roots are rare in Flow, so only walk them when the light DOM found nothing.
  if (hits.length) return hits;
  for (const el of allElements()) {
    const sr = (el as HTMLElement).shadowRoot;
    if (sr) hits.push(...sr.querySelectorAll(css));
  }
  return hits;
}

export function inOverlay(el: Element): boolean {
  return !!el.closest(`#${OVERLAY_ID}`);
}

export function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return false;
  if (inOverlay(el)) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || (cs.opacity !== '' && Number(cs.opacity) === 0)) return false;
  return true;
}

export function isEnabled(el: Element): boolean {
  return !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
}

const CLICKABLE = 'button, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="radio"], a, [tabindex]';

function textOf(el: Element): string {
  return ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function re(src: string): RegExp {
  try {
    return new RegExp(src, 'i');
  } catch {
    return new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

export function matchStrategy(s: Strategy): Element[] {
  if ('css' in s) {
    let els = deepQuery(s.css);
    if (s.text) {
      const r = re(s.text);
      els = els.filter((e) => r.test(textOf(e)));
    }
    return els;
  }
  if ('ariaLabel' in s) {
    const r = re(s.ariaLabel);
    return deepQuery('[aria-label]').filter((e) => r.test(e.getAttribute('aria-label') ?? ''));
  }
  if ('placeholder' in s) {
    const r = re(s.placeholder);
    return deepQuery('[placeholder], [aria-placeholder], [data-placeholder]').filter((e) =>
      r.test(e.getAttribute('placeholder') ?? e.getAttribute('aria-placeholder') ?? e.getAttribute('data-placeholder') ?? ''),
    );
  }
  if ('role' in s) {
    const els = deepQuery(`[role="${s.role}"]${s.role === 'button' ? ', button' : ''}${s.role === 'textbox' ? ', textarea, [contenteditable="true"]' : ''}`);
    if (!s.name) return els;
    const r = re(s.name);
    return els.filter((e) => r.test(e.getAttribute('aria-label') ?? textOf(e)));
  }
  if ('text' in s) {
    const r = re(s.text);
    const els = deepQuery(s.tag ?? CLICKABLE);
    // Prefer the innermost clickable whose own text matches.
    return els.filter((e) => r.test(textOf(e)) || r.test(e.getAttribute('aria-label') ?? ''));
  }
  return [];
}

export interface Found {
  el: HTMLElement;
  via: string;
}

export function strategiesFor(id: TargetId, pack: SelectorPack, taught: Partial<Record<TargetId, Strategy[]>>): Strategy[] {
  return [...(taught[id] ?? []), ...(pack.targets[id]?.strategies ?? [])];
}

export function describeStrategy(s: Strategy): string {
  return JSON.stringify(s);
}

/** First visible (or, for file inputs, present) element matching a target. */
export function find(id: TargetId, pack: SelectorPack, taught: Partial<Record<TargetId, Strategy[]>>, opts: { visible?: boolean; within?: Element } = {}): Found | null {
  const needVisible = opts.visible ?? id !== 'fileInput';
  for (const s of strategiesFor(id, pack, taught)) {
    const els = matchStrategy(s).filter((e) => !inOverlay(e) && (!needVisible || isVisible(e)) && (!opts.within || opts.within.contains(e)));
    if (els.length) {
      // For buttons, the last match is usually the one in the active composer (dialogs render last).
      const el = (id === 'composer' ? pickComposer(els) : els[els.length - 1]) as HTMLElement;
      return { el, via: describeStrategy(s) };
    }
  }
  return null;
}

function pickComposer(els: Element[]): Element {
  // The real prompt box is the biggest visible editable area.
  return els
    .map((e) => ({ e, a: e.getBoundingClientRect().width * Math.max(20, e.getBoundingClientRect().height) }))
    .sort((a, b) => b.a - a.a)[0].e;
}

export async function clickEl(el: HTMLElement): Promise<void> {
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse' }));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.focus?.();
  el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse' }));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
  await new Promise((r) => setTimeout(r, 60));
}

/** Replace the content of a textarea/input/contenteditable in a way frameworks notice. */
export async function setText(el: HTMLElement, text: string): Promise<void> {
  el.focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  // contenteditable: select everything, then insert. execCommand is deprecated but it is still the
  // one path every rich-text editor (ProseMirror, Lexical, Quill) treats as real typing.
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);
  const ok = document.execCommand('insertText', false, text);
  if (!ok || normalize(el.innerText) !== normalize(text)) {
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    if (normalize(el.innerText) !== normalize(text)) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }
}

export function readText(el: HTMLElement): string {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.innerText;
}

export function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ---------- waiting that survives background-tab timer throttling ----------

type Waker = () => void;
const wakers = new Set<Waker>();
let observer: MutationObserver | null = null;

/** Called by the worker when the service worker sends a tick, so waits keep moving in hidden tabs. */
export function wakeAll(): void {
  wakers.forEach((w) => w());
}

function ensureObserver() {
  if (observer) return;
  observer = new MutationObserver(() => wakeAll());
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
}

/** Resolves on the next DOM change, tick, or after ms, whichever is first. */
export function nap(ms: number): Promise<void> {
  ensureObserver();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      wakers.delete(w);
      clearTimeout(t);
      resolve();
    };
    const w: Waker = finish;
    wakers.add(w);
    const t = setTimeout(finish, ms);
  });
}

export function sleepReal(ms: number): Promise<void> {
  // Sleeps at least ms of wall time, but wakes for ticks so throttled timers don't stretch it.
  const end = Date.now() + ms;
  const loop = async (): Promise<void> => {
    const left = end - Date.now();
    if (left <= 0) return;
    await nap(Math.min(left, 1000));
    return loop();
  };
  return loop();
}

export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs: number, isCancelled?: () => boolean): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (isCancelled?.()) return null;
    const v = fn();
    if (v) return v;
    await nap(Math.min(500, Math.max(50, end - Date.now())));
  }
  const v = fn();
  return v || null;
}

/** Collects text added to the page after start(), excluding our overlay. */
export class NewTextRecorder {
  private buf: string[] = [];
  private mo: MutationObserver | null = null;
  private size = 0;

  start() {
    this.stop();
    this.buf = [];
    this.size = 0;
    this.mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') {
          const p = m.target.parentElement;
          if (p && !inOverlay(p)) this.push(m.target.textContent ?? '');
        }
        m.addedNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE) {
            if (n.parentElement && !inOverlay(n.parentElement)) this.push(n.textContent ?? '');
          } else if (n instanceof HTMLElement && !inOverlay(n)) this.push(n.innerText ?? n.textContent ?? '');
        });
      }
    });
    this.mo.observe(document.body, { subtree: true, childList: true, characterData: true });
  }

  private push(t: string) {
    const s = t.trim();
    if (!s || this.size > 200_000) return;
    this.buf.push(s);
    this.size += s.length;
  }

  text(): string {
    return this.buf.join('\n');
  }

  stop() {
    this.mo?.disconnect();
    this.mo = null;
  }
}
