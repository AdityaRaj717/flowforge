import { lazy, Suspense, useEffect, useState } from 'react';
import { call, usePanelState, useQueues } from './api';
import { useAction } from './components/ui';
import { QueueView } from './views/QueueView';
import { ImportView } from './views/ImportView';
import { LibraryView } from './views/LibraryView';
import { StoryboardView } from './views/StoryboardView';
import { ActivityView } from './views/ActivityView';
import { SettingsView } from './views/SettingsView';

const WorkflowView = lazy(() => import('./views/WorkflowView'));

export type Tab = 'queue' | 'import' | 'library' | 'story' | 'workflow' | 'activity' | 'settings';
const TABS: [Tab, string][] = [
  ['queue', 'Queue'],
  ['import', 'Import'],
  ['library', 'Library'],
  ['story', 'Storyboard'],
  ['workflow', 'Workflow'],
  ['activity', 'Activity'],
  ['settings', 'Settings'],
];

const PAGE_LABEL: Record<string, [string, string]> = {
  ready: ['ok', 'Flow ready'],
  busy: ['busy', 'Flow working'],
  loading: ['warn', 'Flow loading'],
  signed_out: ['bad', 'Sign in to Flow'],
  captcha: ['bad', 'Flow needs verification'],
  unusual_activity: ['bad', 'Flow flagged activity'],
  not_flow: ['warn', 'Open a Flow project'],
  ui_unknown: ['bad', 'Flow UI not recognised'],
};

function readTab(): Tab {
  try {
    return (localStorage.getItem('ff.tab') as Tab) || 'queue';
  } catch {
    return 'queue';
  }
}

export function App() {
  const [tab, setTabState] = useState<Tab>(readTab);
  const [ps, refresh] = usePanelState();
  const [queues] = useQueues();
  const [queueId, setQueueId] = useState<string | undefined>();
  const act = useAction();

  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      localStorage.setItem('ff.tab', t);
    } catch {
      /* private mode */
    }
  };

  useEffect(() => {
    if (!queueId && queues.length) setQueueId(queues[0].id);
    if (queueId && !queues.some((q) => q.id === queueId)) setQueueId(queues[0]?.id);
  }, [queues, queueId]);

  const workers = ps?.engine.workers ?? [];
  const w = workers.find((x) => x.page === 'busy') ?? workers.find((x) => x.page === 'ready') ?? workers[0];
  const [tone, label] = w ? PAGE_LABEL[w.page] ?? ['warn', w.page] : ['', 'No Flow tab'];
  const isFullTab = location.search.includes('full');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          FlowForge
        </div>
        <span className="chip">{ps?.license.limits.label ?? '…'}</span>
        <span className="spacer" />
        <button className="worker-pill" onClick={() => act(() => call({ t: 'openFlow' }))} title={w ? `${workers.length} Flow tab(s) connected${w.visible ? '' : ' (hidden: Chrome may slow it down)'}` : 'Open Google Flow'}>
          <span className={`dot ${tone}`} />
          {label}
          {workers.length > 1 && <span className="mono">×{workers.length}</span>}
          {w && !w.visible && <span title="Tab is in the background">◐</span>}
        </button>
        {!isFullTab && (
          <button className="icon-btn" title="Open in a full tab (more room for workflows)" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html?full=1') })}>
            ⤢
          </button>
        )}
      </header>
      <nav className="tabs" role="tablist">
        {TABS.map(([id, name]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
            {name}
          </button>
        ))}
      </nav>
      <main className={`view ${tab === 'workflow' ? 'flush' : ''}`}>
        {tab === 'queue' && <QueueView ps={ps} queues={queues} queueId={queueId} setQueueId={setQueueId} goImport={() => setTab('import')} />}
        {tab === 'import' && <ImportView ps={ps} queues={queues} queueId={queueId} onDone={(id) => (setQueueId(id), setTab('queue'))} />}
        {tab === 'library' && <LibraryView />}
        {tab === 'story' && <StoryboardView ps={ps} onRun={(id) => (setQueueId(id), setTab('queue'))} />}
        {tab === 'workflow' && (
          <Suspense fallback={<div className="view muted">Loading canvas…</div>}>
            <WorkflowView ps={ps} queueId={queueId} onRun={(id) => (setQueueId(id), setTab('queue'))} />
          </Suspense>
        )}
        {tab === 'activity' && <ActivityView />}
        {tab === 'settings' && <SettingsView ps={ps} refresh={refresh} queues={queues} queueId={queueId} />}
      </main>
    </div>
  );
}
