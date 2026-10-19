import type { Strategy } from '../shared/pack';
import type { UiMapReport } from '../shared/messages';
import { allElements, isVisible, matchStrategy, OVERLAY_ID } from './dom';

// "Teach" mode: the user clicks the real control once and we store a robust description of it.
// This is what keeps a paying user working on the day Flow moves a button, before a pack update.

function overlay(): HTMLDivElement {
  let o = document.getElementById(OVERLAY_ID) as HTMLDivElement | null;
  if (!o) {
    o = document.createElement('div');
    o.id = OVERLAY_ID;
    o.style.cssText =
      'position:fixed;z-index:2147483647;left:50%;top:14px;transform:translateX(-50%);font:13px/1.4 system-ui,sans-serif;' +
      'background:#16130f;color:#f4efe6;border:1px solid #e0a345;border-radius:10px;padding:8px 12px;box-shadow:0 6px 24px #0006;pointer-events:none;max-width:70vw';
    document.documentElement.appendChild(o);
  }
  return o;
}

export function showBadge(text: string | null): void {
  if (!text) {
    document.getElementById(OVERLAY_ID)?.remove();
    return;
  }
  overlay().textContent = text;
}

function uniqueAttrStrategy(el: Element): Strategy | null {
  const aria = el.getAttribute('aria-label');
  if (aria) {
    const src = `^${aria.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    if (matchStrategy({ ariaLabel: src }).length <= 2) return { ariaLabel: src };
  }
  for (const attr of ['data-testid', 'data-test-id', 'name', 'id']) {
    const v = el.getAttribute(attr);
    if (v && !/\d{4,}|[a-f0-9]{8,}/i.test(v)) {
      const css = attr === 'id' ? `#${CSS.escape(v)}` : `[${attr}="${CSS.escape(v)}"]`;
      if (document.querySelectorAll(css).length === 1) return { css };
    }
  }
  const ph = el.getAttribute('placeholder');
  if (ph) return { placeholder: `^${ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` };
  if (el.getAttribute('contenteditable') === 'true') return { css: `${el.tagName.toLowerCase()}[contenteditable="true"]` };
  const text = (el as HTMLElement).innerText?.trim();
  if (text && text.length < 40) {
    const src = `^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    return { text: src, tag: el.tagName.toLowerCase() === 'button' ? 'button' : undefined };
  }
  return null;
}

function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && parts.length < 5 && cur !== document.body) {
    let p = cur.tagName.toLowerCase();
    const cls = [...cur.classList].filter((c) => !/\d|_|-[a-z0-9]{5,}$/.test(c)).slice(0, 2);
    if (cls.length) p += `.${cls.map((c) => CSS.escape(c)).join('.')}`;
    parts.unshift(p);
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

/** Waits for one click on the page, swallows it, and returns a strategy for the clicked control. */
export function teach(label: string): Promise<{ strategy: Strategy | null; preview?: string }> {
  showBadge(`FlowForge: click the "${label}" in Flow (Esc to cancel)`);
  return new Promise((resolve) => {
    const hover = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      t.style.outline = '2px solid #e0a345';
      t.addEventListener('mouseleave', () => (t.style.outline = ''), { once: true });
    };
    const done = (r: { strategy: Strategy | null; preview?: string }) => {
      document.removeEventListener('mousedown', onClick, true);
      // Swallow the click that follows the captured mousedown so Flow doesn't act on it.
      setTimeout(() => document.removeEventListener('click', swallow, true), 400);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mouseover', hover, true);
      showBadge(null);
      resolve(r);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done({ strategy: null });
    };
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      let el = e.target as Element;
      const clickable = el.closest('button, [role="button"], [contenteditable="true"], textarea, input, [role="menuitem"], [role="option"], [aria-label]');
      if (clickable) el = clickable;
      (el as HTMLElement).style.outline = '';
      const strategy = uniqueAttrStrategy(el) ?? { css: cssPath(el) };
      done({ strategy, preview: `${el.tagName.toLowerCase()} ${el.getAttribute('aria-label') ?? (el as HTMLElement).innerText?.slice(0, 40) ?? ''}`.trim() });
    };
    // Captured on mousedown: Flow's prompt box (ProseMirror) never receives a `click` event.
    const swallow = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('mousedown', onClick, true);
    document.addEventListener('click', swallow, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mouseover', hover, true);
  });
}

/** Inventory of the page's controls and media; exported from Diagnostics to update packs quickly. */
export function scanUi(): UiMapReport {
  const controls: UiMapReport['controls'] = [];
  for (const el of allElements()) {
    if (!el.matches('button, [role], input, textarea, [contenteditable="true"], select, a[aria-label]')) continue;
    if (el.closest(`#${OVERLAY_ID}`)) continue;
    controls.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') ?? undefined,
      ariaLabel: el.getAttribute('aria-label') ?? undefined,
      text: (el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim().slice(0, 60) || undefined,
      placeholder: el.getAttribute('placeholder') ?? undefined,
      testId: el.getAttribute('data-testid') ?? el.getAttribute('data-test-id') ?? undefined,
      visible: isVisible(el),
    });
    if (controls.length > 600) break;
  }
  const media: UiMapReport['media'] = [];
  document.querySelectorAll('img, video').forEach((m) => {
    const src = (m as HTMLImageElement).currentSrc || (m as HTMLImageElement).src || '';
    const r = m.getBoundingClientRect();
    // Only the host and path shape: signed query strings are never part of a report.
    media.push({ tag: m.tagName.toLowerCase(), src: src.split('?')[0].slice(0, 120), w: Math.round(r.width), h: Math.round(r.height) });
  });
  return { url: location.origin + location.pathname, at: Date.now(), controls, media: media.slice(0, 200) };
}
