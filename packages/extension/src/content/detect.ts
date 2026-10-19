import type { ErrorCode } from '@flowforge/core';
import type { SelectorPack, Strategy, TargetId } from '../shared/pack';
import type { PageState } from '../shared/messages';
import { find, isVisible, normalize } from './dom';

function anyMatch(patterns: string[], text: string): string | null {
  for (const p of patterns) {
    let r: RegExp;
    try {
      r = new RegExp(p, 'im');
    } catch {
      continue;
    }
    const m = r.exec(text);
    if (m) {
      // Return the sentence around the hit; it becomes the "provider message" shown to the user.
      const i = m.index;
      const start = Math.max(0, text.lastIndexOf('\n', i) + 1);
      const end = text.indexOf('\n', i + m[0].length);
      return text.slice(start, end < 0 ? undefined : end).trim().slice(0, 300);
    }
  }
  return null;
}

/** A reCAPTCHA challenge is a large visible bframe; the invisible badge does not count. */
export function captchaVisible(): boolean {
  return [...document.querySelectorAll('iframe')].some((f) => {
    const src = f.getAttribute('src') ?? '';
    if (!/recaptcha\/(api2|enterprise)\/bframe|hcaptcha|challenges\.cloudflare/.test(src)) return false;
    const r = f.getBoundingClientRect();
    return r.width > 150 && r.height > 150 && isVisible(f);
  });
}

function pageText(): string {
  // innerText of a big app is expensive; the visible part is what matters.
  return (document.body?.innerText ?? document.body?.textContent ?? '').slice(0, 60_000);
}

export function detectPageState(pack: SelectorPack, taught: Partial<Record<TargetId, Strategy[]>>): PageState {
  if (document.readyState === 'loading') return 'loading';
  if (captchaVisible()) return 'captcha';
  const text = pageText();
  if (anyMatch(pack.signals.unusualActivity.patterns, text)) return 'unusual_activity';
  const composer = find('composer', pack, taught);
  if (!composer) {
    if (anyMatch(pack.signals.signedOut.patterns, text)) return 'signed_out';
    if (/\/about\b/.test(location.pathname) || !text.trim()) return 'not_flow';
    return 'ui_unknown';
  }
  if (isBusy(pack, taught)) return 'busy';
  return 'ready';
}

export function isBusy(pack: SelectorPack, taught: Partial<Record<TargetId, Strategy[]>>): boolean {
  if (find('stop', pack, taught)) return true;
  const submit = find('submit', pack, taught);
  // A missing or disabled submit with text already in the box usually means "working".
  return !submit ? false : submit.el.getAttribute('aria-busy') === 'true';
}

export interface SignalHit {
  code: ErrorCode;
  message: string;
}

/**
 * Checks for problems that appeared after submitting. `exclude` is the text we typed: the chat
 * echoes it back, and a prompt that mentions "policy" must not look like a refusal.
 */
export function checkSignals(pack: SelectorPack, newText: string, exclude: string[]): SignalHit | null {
  if (captchaVisible()) return { code: 'CAPTCHA', message: 'Verification challenge shown.' };
  const ex = exclude.map(normalize).filter((s) => s.length > 8);
  const lines = newText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !ex.some((e) => e.includes(normalize(l)) || normalize(l).includes(e)));
  const fresh = lines.join('\n');
  const page = pageText();
  const order: [keyof SelectorPack['signals'], ErrorCode][] = [
    ['unusualActivity', 'UNUSUAL_ACTIVITY'],
    ['captcha', 'CAPTCHA'],
    ['credits', 'CREDITS_EXHAUSTED'],
    ['rateLimit', 'RATE_LIMIT'],
    ['queueFull', 'QUEUE_FULL'],
    ['policy', 'POLICY_VIOLATION'],
    ['failed', 'GENERATION_FAILED'],
  ];
  for (const [key, code] of order) {
    const sig = pack.signals[key];
    // Page-wide notices (unusual activity, captcha text) may also arrive as new chat text.
    const hit = anyMatch(sig.patterns, sig.scope === 'page' && key !== 'policy' ? `${page}\n${fresh}` : fresh);
    if (hit) return { code, message: hit };
  }
  return null;
}
