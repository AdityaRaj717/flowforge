// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { newJob, newQueue } from '@flowforge/core';
import { DEFAULT_PACK } from '../src/shared/pack';
import { checkSignals } from '../src/content/detect';
import { composeText } from '../src/content/adapter';
import { find } from '../src/content/dom';
import type { RunSettings } from '../src/shared/messages';

const settings: RunSettings = { freshSession: true, autoApprove: true, optionStrategy: 'auto', timeoutSec: 60, extractLastFrame: false, settleSec: 2 };

describe('refusal detection', () => {
  it('ignores our own prompt echoed back by the chat', () => {
    const prompt = 'A poster about content policy and safety guidelines';
    expect(checkSignals(DEFAULT_PACK, prompt, [prompt])).toBeNull();
  });
  it('spots a refusal, a rate limit and an unusual-activity notice', () => {
    expect(checkSignals(DEFAULT_PACK, "I can't create that because it might violate our policies.", [])?.code).toBe('POLICY_VIOLATION');
    expect(checkSignals(DEFAULT_PACK, 'Too many requests. Please try again later.', [])?.code).toBe('RATE_LIMIT');
    expect(checkSignals(DEFAULT_PACK, 'We noticed unusual activity on your account.', [])?.code).toBe('UNUSUAL_ACTIVITY');
  });
});

describe('request wording', () => {
  const q = newQueue('t', 'text-to-image');
  it('sends the bare prompt when Flow controls took the settings', () => {
    const j = newJob(q, { prompt: 'a fox', options: { aspect: '9:16', outputs: 3 } }, 1);
    expect(composeText(j, [], DEFAULT_PACK, settings, { aspect: true, count: true, model: true })).toBe('a fox');
  });
  it('states missing settings and reference roles in words', () => {
    const j = newJob(q, { prompt: 'she walks', mode: 'frames-to-video', options: { aspect: '9:16', outputs: 1 } }, 1);
    const t = composeText(j, [{ role: 'start', name: 's.png', mime: 'image/png', dataB64: '' }], DEFAULT_PACK, settings, { aspect: false, count: false, model: false });
    expect(t).toMatch(/Generate 1 video in 9:16 aspect ratio/);
    expect(t).toMatch(/attached image 1 as the first frame/);
    expect(t).toMatch(/she walks$/);
  });
});

describe('live Flow selectors', () => {
  it('finds the controls seen on flow.google.com', () => {
    document.body.innerHTML = `
      <button aria-label="Settings"><span>settings_2</span></button>
      <div role="textbox" contenteditable="true" aria-label="What do you want to create?"></div>
      <button aria-label="Add ingredients to the prompt box">add</button>
      <button aria-label="Settings">tune</button>
      <button aria-label="Start generation">arrow_forward</button>`;
    // jsdom has no layout; make every element "visible" for the finder.
    Element.prototype.getBoundingClientRect = () => ({ width: 40, height: 20, top: 0, left: 0, right: 40, bottom: 20, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const t = {};
    expect(find('composer', DEFAULT_PACK, t)?.el.getAttribute('aria-label')).toBe('What do you want to create?');
    expect(find('submit', DEFAULT_PACK, t)?.el.getAttribute('aria-label')).toBe('Start generation');
    expect(find('attach', DEFAULT_PACK, t)?.el.getAttribute('aria-label')).toBe('Add ingredients to the prompt box');
    expect(find('settings', DEFAULT_PACK, t)?.el.textContent).toBe('tune');
  });
});
