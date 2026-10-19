// chrome.downloads wrapper that resolves when the file is actually on disk.

const waiters = new Map<number, { resolve: (d: chrome.downloads.DownloadItem) => void; reject: (e: Error) => void }>();

chrome.downloads.onChanged.addListener((delta) => {
  const w = waiters.get(delta.id);
  if (!w || !delta.state) return;
  if (delta.state.current === 'complete') {
    waiters.delete(delta.id);
    chrome.downloads.search({ id: delta.id }).then(([item]) => w.resolve(item));
  } else if (delta.state.current === 'interrupted') {
    waiters.delete(delta.id);
    w.reject(new Error(delta.error?.current ?? 'download interrupted'));
  }
});

export interface Saved {
  id: number;
  path: string; // absolute path chosen by Chrome
  bytes: number;
}

/** filename is relative to the user's Downloads folder; '/' makes sub-folders. */
export async function download(url: string, filename: string, timeoutMs = 10 * 60_000): Promise<Saved> {
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  if (id === undefined) throw new Error(chrome.runtime.lastError?.message ?? 'download refused');
  const item = await new Promise<chrome.downloads.DownloadItem>((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    // In case it finished before the listener was registered.
    chrome.downloads.search({ id }).then(([it]) => {
      if (it?.state === 'complete') {
        waiters.delete(id);
        resolve(it);
      } else if (it?.state === 'interrupted') {
        waiters.delete(id);
        reject(new Error(it.error ?? 'download interrupted'));
      }
    });
    setTimeout(() => {
      if (waiters.has(id)) {
        waiters.delete(id);
        reject(new Error('download timed out'));
      }
    }, timeoutMs);
  });
  return { id, path: item.filename, bytes: item.fileSize || item.bytesReceived };
}

export function dataUrl(b64: string, mime: string): string {
  return `data:${mime};base64,${b64}`;
}
