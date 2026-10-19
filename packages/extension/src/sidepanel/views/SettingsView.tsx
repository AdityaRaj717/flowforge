import { useState } from 'react';
import type { Queue, QueueSettings } from '@flowforge/core';
import { DISCLAIMER, PLANS } from '@flowforge/core';
import { DEFAULT_PACK, type TargetId } from '../../shared/pack';
import { saveSettings, type Settings } from '../../shared/settings';
import type { UiMapReport } from '../../shared/messages';
import { call, downloadJson, type PanelState } from '../api';
import { useAction } from '../components/ui';

interface Props {
  ps: PanelState | null;
  refresh: () => void;
  queues: Queue[];
  queueId?: string;
}

export function SettingsView({ ps, refresh, queues, queueId }: Props) {
  if (!ps) return <div className="muted">Loading…</div>;
  return (
    <div className="stack">
      <Plan ps={ps} refresh={refresh} />
      <QueueSettingsCard ps={ps} q={queues.find((q) => q.id === queueId)} />
      <FlowBehaviour ps={ps} refresh={refresh} />
      <Calibration ps={ps} refresh={refresh} />
      <Agent ps={ps} refresh={refresh} />
      <div className="small faint">{DISCLAIMER} FlowForge {ps.version} · adapter {ps.adapterVersion} · selector pack {ps.packVersion}</div>
    </div>
  );
}

function Plan({ ps, refresh }: { ps: PanelState; refresh: () => void }) {
  const act = useAction();
  const [key, setKey] = useState('');
  const l = ps.license;
  const row = (label: string, free: string, pro: string) => (
    <tr><td>{label}</td><td className="muted">{free}</td><td>{pro}</td></tr>
  );
  const fmt = (n: number | null, unit = '') => (n === null ? 'Unlimited' : `${n}${unit}`);
  return (
    <div className="card stack">
      <div className="row">
        <h3 className="grow">Plan</h3>
        <span className={`chip ${l.plan === 'free' ? '' : 'ok'}`}>{l.limits.label}</span>
      </div>
      {l.sub && <div className="small muted">Licensed to {l.sub}{l.exp ? ` · renews/expires ${new Date(l.exp * 1000).toLocaleDateString()}` : ' · no expiry'}</div>}
      {l.reason && <div className="note bad small">{l.reason}</div>}
      <table className="small">
        <thead><tr><th /><th>Free</th><th>Pro</th></tr></thead>
        <tbody>
          {row('FlowForge jobs per day', fmt(PLANS.free.jobsPerDay), fmt(PLANS.pro.jobsPerDay))}
          {row('Parallel Flow tabs', String(PLANS.free.maxConcurrency), String(PLANS.pro.maxConcurrency))}
          {row('Workflow nodes', fmt(PLANS.free.workflowNodes), fmt(PLANS.pro.workflowNodes))}
          {row('Storyboard scenes', fmt(PLANS.free.storyboardScenes), fmt(PLANS.pro.storyboardScenes))}
          {row('Prompt variations per row', String(PLANS.free.promptExpansions), String(PLANS.pro.promptExpansions))}
          {row('Local API, MCP, CLI', '—', '✓')}
          {row('FFmpeg merge & post-processing', '—', '✓')}
          {row('Several queues at once', '—', '✓')}
        </tbody>
      </table>
      <div className="small faint">These limits are FlowForge's. Generation credits, model access and Google's own rate limits come from your Google account and are not changed by any plan.</div>
      <div className="row">
        <input type="password" className="grow" placeholder="Paste license key (FF1.…)" value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn sm primary" disabled={!key.trim()} onClick={() => act(async () => { await call({ t: 'setLicense', key }); setKey(''); refresh(); }, 'License saved')}>Activate</button>
        {l.plan !== 'free' && <button className="btn sm ghost" onClick={() => act(async () => { await call({ t: 'setLicense', key: '' }); refresh(); })}>Remove</button>}
      </div>
    </div>
  );
}

function QueueSettingsCard({ ps, q }: { ps: PanelState; q?: Queue }) {
  const act = useAction();
  if (!q) return null;
  const s = q.settings;
  const set = (patch: Partial<QueueSettings>) => act(() => call({ t: 'updateQueue', queueId: q.id, patch: { settings: patch } }));
  const num = (label: string, k: keyof QueueSettings, min: number, max: number, hint?: string) => (
    <label className="field" title={hint}>
      <span>{label}</span>
      <input type="number" min={min} max={max} defaultValue={s[k] as number} onBlur={(e) => set({ [k]: Math.min(max, Math.max(min, Number(e.target.value) || min)) } as Partial<QueueSettings>)} />
    </label>
  );
  return (
    <div className="card stack">
      <h3>Queue “{q.name}”</h3>
      <div className="grid2">
        <label className="field">
          <span>Parallel Flow tabs (max {ps.license.limits.maxConcurrency})</span>
          <select defaultValue={s.concurrency} onChange={(e) => set({ concurrency: Number(e.target.value) })}>
            {Array.from({ length: ps.license.limits.maxConcurrency }, (_, i) => <option key={i + 1}>{i + 1}</option>)}
          </select>
        </label>
        {num('Attempts per job', 'maxAttempts', 1, 20)}
        {num('Delay between jobs, min (s)', 'delayMinSec', 0, 600)}
        {num('Delay between jobs, max (s)', 'delayMaxSec', 0, 900)}
        {num('Retry wait base (s)', 'backoffBaseSec', 5, 600, 'Doubles with each attempt; rate limits wait 4× longer.')}
        {num('Timeout per job (s)', 'generationTimeoutSec', 60, 3600)}
        {num('Pause after failures in a row', 'circuitBreakerFailures', 1, 50)}
      </div>
      <label className="field"><span>Download folder (inside Downloads)</span><input defaultValue={s.downloadRoot} onBlur={(e) => set({ downloadRoot: e.target.value.trim() || 'FlowForge' })} /></label>
      <label className="field">
        <span>File names</span>
        <input defaultValue={s.filenameTemplate} onBlur={(e) => set({ filenameTemplate: e.target.value.trim() || '{queue}/{index:03}_{slug}{variant}' })} />
        <span className="faint">{'{queue} {index:03} {name} {slug} {mode} {model} {aspect} {date} {time} {variant} {var.column}'} · “/” makes folders</span>
      </label>
      <label className="check"><input type="checkbox" defaultChecked={s.autoDownload} onChange={(e) => set({ autoDownload: e.target.checked })} />Download outputs automatically</label>
      <label className="check"><input type="checkbox" defaultChecked={s.skipPolicyBlocked} onChange={(e) => set({ skipPolicyBlocked: e.target.checked })} />Skip prompts Flow refuses and keep going (otherwise pause)</label>
      <label className="check"><input type="checkbox" defaultChecked={s.notifyOnFinish} onChange={(e) => set({ notifyOnFinish: e.target.checked })} />Notify when the queue finishes</label>
    </div>
  );
}

function FlowBehaviour({ ps, refresh }: { ps: PanelState; refresh: () => void }) {
  const act = useAction();
  const s = ps.settings;
  const set = (patch: Partial<Settings>) => act(async () => { await saveSettings(patch); refresh(); });
  return (
    <div className="card stack">
      <h3>Flow tab behaviour</h3>
      <label className="field">
        <span>How row settings (ratio, count, model) reach Flow</span>
        <select value={s.optionStrategy} onChange={(e) => set({ optionStrategy: e.target.value as Settings['optionStrategy'] })}>
          <option value="auto">Use Flow's controls when found, otherwise say it in the request</option>
          <option value="ui">Only Flow's controls (fail the job if a control is missing)</option>
          <option value="instruction">Always state them in the request text</option>
          <option value="none">Send the prompt as-is; use Flow's current settings</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={s.freshSessionPerJob} onChange={(e) => set({ freshSessionPerJob: e.target.checked })} />Start each job in a fresh Flow session, so one prompt doesn't influence the next</label>
      <label className="check"><input type="checkbox" checked={s.autoApproveAgent} onChange={(e) => set({ autoApproveAgent: e.target.checked })} />Approve Flow's generation plan automatically when it asks (this is the run you queued)</label>
      <label className="field">
        <span>Save the last frame of videos</span>
        <select value={s.extractLastFrames} onChange={(e) => set({ extractLastFrames: e.target.value as Settings['extractLastFrames'] })}>
          <option value="chains">Only when a later scene continues from it</option>
          <option value="always">Always (adds them to the Library)</option>
          <option value="never">Never</option>
        </select>
      </label>
      <label className="field">
        <span>Wait this long with no new output before calling a job done (s)</span>
        <input type="number" min={2} max={60} defaultValue={s.settleSec} onBlur={(e) => set({ settleSec: Math.max(2, Number(e.target.value) || 6) })} />
      </label>
      <label className="check"><input type="checkbox" checked={s.notifications} onChange={(e) => set({ notifications: e.target.checked })} />Desktop notifications (queue paused, finished, needs you)</label>
      <div className="note info small">Chrome slows down background tabs. For long runs keep the Flow tab in its own window. FlowForge pauses and tells you when Flow shows a verification, sign-in or unusual-activity notice; it never tries to get around them.</div>
      <label className="check small"><input type="checkbox" checked={s.devMode} onChange={(e) => set({ devMode: e.target.checked })} />Developer mode (allow the local mock Flow page at localhost:5179)</label>
    </div>
  );
}

function Calibration({ ps, refresh }: { ps: PanelState; refresh: () => void }) {
  const act = useAction();
  const [probe, setProbe] = useState<{ found: Record<string, { ok: boolean; via?: string }>; page: string } | null>(null);
  const [scan, setScan] = useState<UiMapReport | null>(null);
  const targets = Object.entries(DEFAULT_PACK.targets) as [TargetId, (typeof DEFAULT_PACK.targets)[TargetId]][];
  return (
    <div className="card stack">
      <div className="row">
        <h3 className="grow">Flow controls</h3>
        <button className="btn sm" onClick={() => act(async () => setProbe(await call({ t: 'probe' })))}>Check page</button>
        <button className="btn sm ghost" onClick={() => act(async () => {
          const r = await call<{ updated: boolean; version: string; error?: string }>({ t: 'refreshPack' });
          if (r.error) throw new Error(r.error);
          refresh();
          return r;
        }, 'Selector pack checked')}>Update pack</button>
      </div>
      <div className="small muted">If Flow changes its layout, click “Teach” and then click the matching control in the Flow tab. FlowForge remembers it.</div>
      {probe && <div className="small">Page state: <b>{probe.page}</b></div>}
      <table className="small">
        <tbody>
          {targets.map(([id, t]) => {
            const f = probe?.found[id];
            const taught = ps.taught[id]?.length;
            return (
              <tr key={id}>
                <td>{t.label}{t.optional ? <span className="faint"> (optional)</span> : ''}</td>
                <td>{f ? <span className={`chip ${f.ok ? 'ok' : t.optional ? '' : 'bad'}`}>{f.ok ? 'found' : 'not found'}</span> : <span className="faint">—</span>}{taught ? <span className="chip info" style={{ marginLeft: 4 }}>taught</span> : null}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn sm ghost" onClick={() => act(async () => { const r = await call<{ saved: boolean }>({ t: 'calibrate', target: id }); refresh(); return r; }, 'Saved')}>Teach</button>
                  {taught ? <button className="icon-btn" title="Forget" onClick={() => act(async () => { await call({ t: 'clearTaught', target: id }); refresh(); })}>✕</button> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row">
        <button className="btn sm ghost" onClick={() => act(async () => setScan(await call({ t: 'scanUi' })))}>Map Flow's UI</button>
        {scan && <button className="btn sm ghost" onClick={() => downloadJson('flow-ui-map.json', scan)}>Save map ({scan.controls.length} controls)</button>}
      </div>
    </div>
  );
}

function Agent({ ps, refresh }: { ps: PanelState; refresh: () => void }) {
  const act = useAction();
  const s = ps.settings;
  const [token, setToken] = useState(s.agentToken);
  const allowed = ps.license.limits.localApi;
  return (
    <div className="card stack">
      <div className="row">
        <h3 className="grow">Local agent: API, MCP, CLI, FFmpeg</h3>
        <span className={`chip ${ps.agent.connected ? 'ok' : ''}`}>{ps.agent.connected ? `connected ${ps.agent.agentVersion}` : 'not connected'}</span>
      </div>
      {!allowed && <div className="note small">Part of the Pro plan.</div>}
      <div className="small muted">
        Run <span className="mono">flowforge-agent serve</span> on this computer (see docs/AGENT.md). It listens on 127.0.0.1 only and prints a pairing token. Your Google session never leaves the browser; the agent only asks FlowForge to queue work.
      </div>
      <div className="grid2">
        <label className="field"><span>Port</span><input type="number" defaultValue={s.agentPort} onBlur={(e) => act(async () => { await saveSettings({ agentPort: Number(e.target.value) || 47321 }); refresh(); })} /></label>
        <label className="field"><span>Pairing token</span><input type="password" value={token} onChange={(e) => setToken(e.target.value)} /></label>
      </div>
      {ps.agent.error && !ps.agent.connected && s.agentEnabled && <div className="small" style={{ color: 'var(--warn)' }}>{ps.agent.error}</div>}
      <div className="row">
        <label className="check grow"><input type="checkbox" checked={s.agentEnabled} disabled={!allowed} onChange={(e) => act(async () => { await saveSettings({ agentEnabled: e.target.checked, agentToken: token.trim() }); await call({ t: 'agentReconnect' }); refresh(); })} />Connect to the local agent</label>
        <button className="btn sm" disabled={!allowed} onClick={() => act(async () => { await saveSettings({ agentToken: token.trim(), agentEnabled: true }); await call({ t: 'agentReconnect' }); refresh(); }, 'Connecting…')}>Save & connect</button>
      </div>
    </div>
  );
}
