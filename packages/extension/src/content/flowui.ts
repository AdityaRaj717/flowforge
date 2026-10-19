import type { AspectRatio, MediaKind } from '@flowforge/core';
import type { SelectorPack, Strategy, TargetId } from '../shared/pack';
import { allElements, clickEl, find, isVisible, matchStrategy, nap, sleepReal, waitFor } from './dom';

// Drivers for specific parts of the live Flow UI (verified against flow.google.com, Oct 2026):
// the Agent settings panel and the ingredients picker's "Upload media" flow.

type Taught = Partial<Record<TargetId, Strategy[]>>;

function rx(src: string) {
  return new RegExp(src, 'i');
}

const norm = (s: string) => s.normalize('NFKD').replace(/[^\p{L}\p{N}.]+/gu, ' ').trim().toLowerCase();

function panelOpen(pack: SelectorPack): HTMLElement | null {
  const h = allElements().find((e) => /^H\d$/.test(e.tagName) || e.getAttribute('role') === 'heading' ? rx(pack.agentSettings.heading).test((e as HTMLElement).innerText?.trim() ?? '') && isVisible(e) : false);
  if (!h) return null;
  let box: HTMLElement | null = h as HTMLElement;
  for (let i = 0; i < 8 && box?.parentElement; i++) {
    box = box.parentElement;
    if (box.querySelector('[role="radiogroup"], flow-toggles') && /save/i.test(box.innerText)) return box;
  }
  return null;
}

function group(panel: HTMLElement, pack: SelectorPack, kind: MediaKind, what: string): HTMLElement | null {
  const label = pack.agentSettings.group.replace('{Kind}', kind === 'image' ? 'Image' : 'Video').replace('{what}', what);
  return [...panel.querySelectorAll<HTMLElement>('[aria-label]')].find((e) => e.getAttribute('aria-label')?.toLowerCase() === label.toLowerCase()) ?? null;
}

function radioIn(g: HTMLElement, text: string): HTMLElement | null {
  const want = text.toLowerCase();
  return [...g.querySelectorAll<HTMLElement>('[role="radio"], button')].find((b) => (b.innerText ?? '').toLowerCase().split(/\s+/).includes(want)) ?? null;
}

export interface AgentSettingsWant {
  aspect?: AspectRatio;
  count?: number;
  model?: string;
}

export interface AgentSettingsResult {
  aspect: boolean;
  count: boolean;
  model: boolean;
  missing: string[];
  changed: boolean;
}

const cache: Partial<Record<MediaKind, { at: number; want: string }>> = {};

/**
 * Sets the per-kind defaults in Flow's Agent settings (aspect, outputs, model) and saves.
 * Returns null when this Flow UI has no such panel (older UI or the mock page).
 */
export async function applyAgentSettings(kind: MediaKind, want: AgentSettingsWant, pack: SelectorPack, taught: Taught): Promise<AgentSettingsResult | null> {
  const key = JSON.stringify(want);
  const hit = cache[kind];
  if (hit && hit.want === key && Date.now() - hit.at < 10 * 60_000) return { aspect: !!want.aspect, count: !!want.count, model: !!want.model, missing: [], changed: false };

  let panel = panelOpen(pack);
  if (!panel) {
    const btn = find('settings', pack, taught);
    if (!btn) return null;
    await clickEl(btn.el);
    panel = await waitFor(() => panelOpen(pack), 4000);
    if (!panel) return null;
  }
  const res: AgentSettingsResult = { aspect: false, count: false, model: false, missing: [], changed: false };

  const pick = async (what: string, text: string, flag: 'aspect' | 'count') => {
    const g = group(panel!, pack, kind, what);
    const r = g && radioIn(g, text);
    if (!r) {
      res.missing.push(`${what} ${text}`);
      return;
    }
    if (r.getAttribute('aria-checked') !== 'true' && r.getAttribute('aria-pressed') !== 'true') {
      await clickEl(r);
      res.changed = true;
    }
    res[flag] = true;
  };
  if (want.aspect) await pick('aspect ratio', want.aspect, 'aspect');
  if (want.count) await pick('output count', pack.agentSettings.countText.replace('{n}', String(want.count)), 'count');

  if (want.model) {
    const g = group(panel, pack, kind, 'model');
    if (!g) res.missing.push('model picker');
    else if (norm(g.innerText).includes(norm(want.model))) res.model = true;
    else {
      await clickEl(g);
      const opt = await waitFor(() => matchStrategy({ css: '[role="menuitem"], [role="option"]' }).find((e) => isVisible(e) && norm((e as HTMLElement).innerText).includes(norm(want.model!))) as HTMLElement | undefined, 3000);
      if (opt) {
        await clickEl(opt);
        res.model = true;
        res.changed = true;
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        res.missing.push(`model "${want.model}"`);
      }
      await nap(300);
    }
  }

  // Save when something changed, otherwise leave without touching the user's settings.
  const save = [...panel.querySelectorAll<HTMLElement>('button')].find((b) => rx(pack.agentSettings.save).test(b.innerText.trim()));
  if (res.changed && save) await clickEl(save);
  else {
    const back = [...panel.querySelectorAll<HTMLElement>('button[aria-label]')].find((b) => rx(pack.agentSettings.back).test(b.getAttribute('aria-label') ?? ''));
    if (back) await clickEl(back);
  }
  await waitFor(() => !panelOpen(pack), 3000);
  if (!res.missing.length) cache[kind] = { at: Date.now(), want: key };
  return res;
}

export function forgetAgentSettingsCache() {
  delete cache.image;
  delete cache.video;
}

/** Closes "what's new" dialogs that sit on top of the composer. Never touches agreements. */
export async function dismissBenignDialogs(pack: SelectorPack, taught: Taught): Promise<number> {
  let n = 0;
  for (let i = 0; i < 3; i++) {
    const b = find('dismissDialog', pack, taught);
    if (!b) break;
    const box = b.el.closest('.cdk-overlay-pane, [role="dialog"]') as HTMLElement | null;
    const text = box?.innerText ?? '';
    // Only changelog-style dialogs. Anything mentioning rights, terms or agreeing is left for the person.
    if (!/changelog|introducing|what.s new/i.test(text) || /agree|terms|rights|consent|policy/i.test(text)) break;
    await clickEl(b.el);
    n++;
    await sleepReal(700);
  }
  return n;
}

/**
 * Hands files to Flow's "Upload media" file input without opening the OS file dialog.
 * A tiny MAIN-world hook (picker-hook.js) catches the input when we arm it.
 */
export async function uploadViaPicker(files: File[], pack: SelectorPack, taught: Taught, cancelled: () => boolean): Promise<'ok' | 'no-picker' | 'consent'> {
  const attach = find('attach', pack, taught);
  if (!attach) return 'no-picker';
  const root = document.documentElement;
  await clickEl(attach.el);
  const upload = await waitFor(() => find('uploadMedia', pack, taught), 3000, cancelled);
  if (!upload) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'no-picker';
  }
  root.dataset.ffPicker = 'armed';
  await clickEl(upload.el);
  const input = await waitFor(() => document.querySelector<HTMLInputElement>('input[type="file"][data-ff-picked="1"]'), 3000, cancelled);
  delete root.dataset.ffPicker;
  if (!input) return 'no-picker';
  input.removeAttribute('data-ff-picked');
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));
  input.files = dt.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // Flow may ask the person to confirm upload rights; that is theirs to accept.
  const consent = await waitFor(() => pack.signals.consent.patterns.some((p) => rx(p).test(document.body.innerText.slice(0, 40_000))), 2500, cancelled);
  if (consent) return 'consent';
  // Live Flow (2026-10-19): an upload lands in the picker's "Recent" list; it still has to be selected
  // and added with "Add to prompt" before it shows as a chip in the prompt box.
  const addBtn = () => [...document.querySelectorAll<HTMLElement>('.detail-add-to-prompt-btn, button')].find((b) => isVisible(b) && /^\s*add to prompt\s*$/i.test(b.innerText));
  if (!(await waitFor(addBtn, 3000, cancelled))) return 'ok'; // older UI: the upload attaches directly
  for (const f of files) {
    const item = await waitFor(
      () => [...document.querySelectorAll<HTMLElement>('[role="option"].asset-item, [role="option"]')].find((e) => isVisible(e) && e.innerText.trim().split('\n')[0] === f.name),
      30_000,
      cancelled,
    );
    if (!item) break;
    await clickEl(item);
    const add = await waitFor(addBtn, 3000, cancelled);
    if (add) await clickEl(add);
    await sleepReal(800);
    if (f !== files[files.length - 1]) {
      await clickEl(attach.el);
      await sleepReal(800);
    }
  }
  return 'ok';
}

/** The element that holds the prompt box and its buttons (used to spot attachment chips). */
export function composerArea(pack: SelectorPack, taught: Taught): HTMLElement | null {
  const c = find('composer', pack, taught)?.el;
  const s = find('submit', pack, taught)?.el;
  if (!c) return null;
  let box: HTMLElement | null = c;
  while (box && s && !box.contains(s)) box = box.parentElement;
  return box ?? c.parentElement;
}
