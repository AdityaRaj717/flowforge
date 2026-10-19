// Flow ignores script-made (isTrusted=false) clicks and key presses on its Generate button, so
// the content script asks for the click here and it goes through the DevTools protocol as real
// input. Chrome shows its "is debugging this browser" bar while attached; we detach when idle.

export interface TrustedClickRequest {
  ffTrusted: 'click';
  x: number;
  y: number;
}

const attached = new Map<number, ReturnType<typeof setTimeout>>();
const IDLE_MS = 20_000;

async function ensureAttached(tabId: number) {
  const t = attached.get(tabId);
  if (t) clearTimeout(t);
  else {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      // Already attached by us after a worker restart is fine; anything else is a real failure.
      if (!/already attached/i.test((e as Error).message)) throw e;
    }
  }
  attached.set(
    tabId,
    setTimeout(() => {
      attached.delete(tabId);
      chrome.debugger.detach({ tabId }).catch(() => undefined);
    }, IDLE_MS),
  );
}

chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId == null) return;
  const t = attached.get(src.tabId);
  if (t) clearTimeout(t);
  attached.delete(src.tabId);
});

async function click(tabId: number, x: number, y: number) {
  await ensureAttached(tabId);
  const send = (type: string, extra: Record<string, unknown> = {}) =>
    chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  await send('mouseMoved', { button: 'none', clickCount: 0 });
  await send('mousePressed');
  await send('mouseReleased');
}

export function startTrustedInput() {
  chrome.runtime.onMessage.addListener((msg: TrustedClickRequest, sender, sendResponse) => {
    if (!msg || msg.ffTrusted !== 'click' || sender.tab?.id == null || sender.frameId !== 0) return false;
    click(sender.tab.id, msg.x, msg.y).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: (e as Error).message }),
    );
    return true;
  });
}
