import { useMemo, useState } from 'react';
import type { GenerationMode, Job, Queue } from '@flowforge/core';
import { ACTIVE_STATES, ASPECT_RATIOS, MODE_OUTPUT, TERMINAL_STATES, findMentions, jobsFromRows, resolveReferences, rowsFromTxt, toCsv, workflowFromJobs } from '@flowforge/core';
import { call, downloadText, putLocal, useAssets, useBlobUrl, useJobs, type PanelState } from '../api';
import { StateChip, dur, timeAgo, useAction, useToast, Modal } from '../components/ui';

export const MODES: [GenerationMode, string][] = [
  ['text-to-image', 'Text → Image'],
  ['image-to-image', 'Image → Image'],
  ['text-to-video', 'Text → Video'],
  ['frames-to-video', 'Frames → Video'],
  ['ingredients-to-video', 'Ingredients → Video'],
  ['extend-video', 'Extend video'],
];
export const MODE_SHORT: Record<GenerationMode, string> = {
  'text-to-image': 'T→I', 'image-to-image': 'I→I', 'text-to-video': 'T→V', 'frames-to-video': 'F→V', 'ingredients-to-video': 'Ing→V', 'extend-video': 'Ext',
};

type Filter = 'all' | 'active' | 'problems' | 'done';
const PROBLEM: Job['state'][] = ['failed', 'policy_blocked', 'unsupported', 'download_failed', 'verification_failed', 'waiting_for_user', 'waiting_for_flow'];

interface Props {
  ps: PanelState | null;
  queues: Queue[];
  queueId?: string;
  setQueueId: (id: string) => void;
  goImport: () => void;
}

export function QueueView({ ps, queues, queueId, setQueueId, goImport }: Props) {
  const act = useAction();
  const toast = useToast();
  const q = queues.find((x) => x.id === queueId);
  const [jobs] = useJobs(queueId);
  const [assets] = useAssets();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [quick, setQuick] = useState('');
  const [drag, setDrag] = useState<string | null>(null);
  const [naming, setNaming] = useState<null | 'new' | 'rename'>(null);

  const counts = useMemo(() => {
    const c = { done: 0, run: 0, bad: 0, wait: 0, total: jobs.length };
    jobs.forEach((j) => {
      if (j.state === 'succeeded') c.done++;
      else if (ACTIVE_STATES.includes(j.state)) c.run++;
      else if (TERMINAL_STATES.includes(j.state) || PROBLEM.includes(j.state)) c.bad++;
      else c.wait++;
    });
    return c;
  }, [jobs]);

  const eta = useMemo(() => {
    if (!q) return null;
    const done = jobs.filter((j) => j.state === 'succeeded' && j.startedAt && j.finishedAt);
    const avg = (kind: 'image' | 'video') => {
      const xs = done.filter((j) => MODE_OUTPUT[j.mode] === kind).map((j) => j.finishedAt! - j.startedAt!);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : kind === 'image' ? 60_000 : 150_000;
    };
    const left = jobs.filter((j) => !TERMINAL_STATES.includes(j.state));
    const delay = ((q.settings.delayMinSec + q.settings.delayMaxSec) / 2) * 1000;
    const total = left.reduce((s, j) => s + avg(MODE_OUTPUT[j.mode]) + delay, 0) / Math.max(1, q.settings.concurrency);
    const outputs = left.reduce((s, j) => s + (j.options.outputs ?? 1), 0);
    return { ms: total, jobs: left.length, outputs };
  }, [jobs, q]);

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return jobs.filter((j) => {
      if (filter === 'active' && !(ACTIVE_STATES.includes(j.state) || j.state === 'queued' || j.state === 'retry_wait' || j.state === 'blocked')) return false;
      if (filter === 'problems' && !PROBLEM.includes(j.state)) return false;
      if (filter === 'done' && j.state !== 'succeeded') return false;
      return !s || j.prompt.toLowerCase().includes(s) || (j.name ?? '').toLowerCase().includes(s) || String(j.index) === s;
    });
  }, [jobs, filter, search]);

  if (!queues.length || !q) {
    return (
      <div className="stack">
        <div className="empty">
          <b>No queues yet</b>
          A queue is a list of prompts FlowForge runs in your Flow tab, one after another, with retries and downloads.
          <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
            <button className="btn primary" onClick={() => setNaming('new')}>New queue</button>
            <button className="btn" onClick={goImport}>Import a file</button>
          </div>
        </div>
        {naming && <NameModal title="New queue" initial="My queue" onClose={() => setNaming(null)} onSave={(n) => act(async () => { const nq = await call<Queue>({ t: 'createQueue', name: n }); setQueueId(nq.id); })} />}
      </div>
    );
  }

  const addQuick = () =>
    act(async () => {
      const lic = ps?.license.limits;
      const index = assets.map((a) => ({ id: a.id, name: a.name, aliases: a.aliases }));
      const missing: string[] = [];
      const rows = rowsFromTxt(quick).rows.map((r) => {
        // Same reference rules as Import: [start: file.png] names and @aliases attach Library images.
        const { refs, missing: miss } = resolveReferences(r.referenceNames, index);
        missing.push(...miss);
        for (const m of findMentions(r.prompt, index)) if (!refs.some((x) => x.assetId === m.assetId)) refs.push({ role: 'ingredient', assetId: m.assetId });
        return { ...r, mode: r.mode ?? (refs.length ? ('ingredients-to-video' as const) : undefined), references: refs };
      });
      if (missing.length) throw new Error(`Not in your Library: ${[...new Set(missing)].join(', ')}. Add them in Library first.`);
      const start = jobs.reduce((m, j) => Math.max(m, j.index), 0) + 1;
      const { jobs: made, truncated } = jobsFromRows(q, rows, start, lic?.promptExpansions ?? 20);
      if (!made.length) throw new Error('Nothing to add.');
      await call({ t: 'addJobs', queueId: q.id, jobs: made });
      setQuick('');
      toast(truncated ? `Added ${made.length}. ${truncated} more variations were over your plan's limit.` : `Added ${made.length} job(s).`, !!truncated);
    });

  const toggle = (id: string) => setSel((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const drop = (targetId: string) => {
    if (!drag || drag === targetId) return;
    const ids = jobs.map((j) => j.id).filter((id) => id !== drag);
    ids.splice(ids.indexOf(targetId), 0, drag);
    void act(() => call({ t: 'reorderJobs', queueId: q.id, orderedIds: ids }));
    setDrag(null);
  };

  const exportReport = () => {
    const rows = [['index', 'name', 'mode', 'state', 'attempts', 'prompt', 'error', 'flow_message', 'files']];
    jobs.forEach((j) => rows.push([String(j.index), j.name ?? '', j.mode, j.state, String(j.attempts), j.prompt, j.error?.message ?? '', j.error?.providerMessage ?? '', j.outputs.map((o) => o.savedPath ?? '').filter(Boolean).join(' | ')]));
    downloadText(`${q.name}-report.csv`, toCsv(rows), 'text/csv');
  };

  const running = q.status === 'running';
  const pct = (n: number) => `${(100 * n) / Math.max(1, counts.total)}%`;
  const failedIds = jobs.filter((j) => PROBLEM.includes(j.state) && j.state !== 'waiting_for_flow').map((j) => j.id);

  return (
    <div className="stack">
      <div className="queue-head">
        <div className="row">
          <select className="grow" value={q.id} onChange={(e) => setQueueId(e.target.value)} aria-label="Queue">
            {queues.map((x) => (
              <option key={x.id} value={x.id}>{x.name}{x.status === 'running' ? '  ●' : ''}</option>
            ))}
          </select>
          <button className="icon-btn" title="New queue" onClick={() => setNaming('new')}>＋</button>
          <button className="icon-btn" title="Rename" onClick={() => setNaming('rename')}>✎</button>
          <button className="icon-btn" title="Delete queue" onClick={() => confirm(`Delete "${q.name}" and its ${jobs.length} jobs? Downloaded files stay on disk.`) && act(() => call({ t: 'deleteQueue', queueId: q.id }))}>🗑</button>
        </div>

        <div className="row">
          {!running && q.status !== 'paused' && (
            <button className="btn primary" disabled={!counts.wait && !failedIds.length} onClick={() => act(() => call({ t: 'control', queueId: q.id, action: 'start' }))}>▶ Start</button>
          )}
          {q.status === 'paused' && <button className="btn primary" onClick={() => act(() => call({ t: 'control', queueId: q.id, action: 'resume' }))}>▶ Resume</button>}
          {running && <button className="btn" onClick={() => act(() => call({ t: 'control', queueId: q.id, action: 'pause' }))}>❚❚ Pause</button>}
          {(running || q.status === 'paused') && <button className="btn danger" onClick={() => act(() => call({ t: 'control', queueId: q.id, action: 'stop' }))}>■ Stop</button>}
          <span className="right small muted">
            {eta && eta.jobs > 0 ? <>~{dur(eta.ms)} for {eta.jobs} jobs · {eta.outputs} outputs</> : counts.total ? 'All done' : ''}
          </span>
        </div>

        {q.status === 'paused' && q.pausedReason && <div className="note">{q.pausedReason}</div>}
        {ps && <QuotaLine ps={ps} />}

        <div className="progress" aria-label="Progress">
          <span style={{ width: pct(counts.done), background: 'var(--ok)' }} />
          <span style={{ width: pct(counts.run), background: 'var(--accent)' }} />
          <span style={{ width: pct(counts.bad), background: 'var(--bad)' }} />
        </div>
        <div className="stats">
          <span><b>{counts.done}</b> done</span>
          <span><b>{counts.run}</b> running</span>
          <span><b>{counts.wait}</b> waiting</span>
          <span><b>{counts.bad}</b> need attention</span>
        </div>

        <div className="row tight">
          {(['all', 'active', 'problems', 'done'] as Filter[]).map((f) => (
            <button key={f} className={`btn sm ${filter === f ? '' : 'ghost'}`} onClick={() => setFilter(f)}>
              {f === 'problems' ? 'Needs attention' : f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
          <input className="grow" placeholder="Search prompts or #" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 90 }} />
        </div>

        <div className="row tight">
          {sel.size > 0 ? (
            <>
              <span className="small muted">{sel.size} selected</span>
              <button className="btn sm" onClick={() => act(() => call({ t: 'retryJobs', jobIds: [...sel] }), 'Requeued')}>Retry</button>
              <button className="btn sm danger" onClick={() => act(async () => { await call({ t: 'deleteJobs', jobIds: [...sel] }); setSel(new Set()); })}>Delete</button>
              <button className="btn sm ghost" onClick={() => setSel(new Set())}>Clear</button>
            </>
          ) : (
            <>
              <button className="btn sm ghost" onClick={() => setSel(new Set(shown.map((j) => j.id)))}>Select shown</button>
              {failedIds.length > 0 && <button className="btn sm" onClick={() => act(() => call({ t: 'retryJobs', jobIds: failedIds }), `Requeued ${failedIds.length}`)}>Retry {failedIds.length} problem job(s)</button>}
              <button className="btn sm ghost" onClick={exportReport}>Export report</button>
              <button className="btn sm ghost" title="Open these rows as a workflow graph" onClick={() => act(async () => {
                const wf = workflowFromJobs(jobs, q.name, jobs.every((j) => MODE_OUTPUT[j.mode] === 'video'));
                await putLocal('workflows', wf);
              }, 'Workflow created. Open the Workflow tab.')}>As workflow</button>
            </>
          )}
        </div>
      </div>

      <Defaults q={q} />

      <div className="card tight stack">
        <textarea rows={3} value={quick} onChange={(e) => setQuick(e.target.value)} placeholder={'Add prompts: one per line, or blank-line separated.\nInline settings: [aspect: 9:16] [n: 2] [mode: t2v]  ·  variations: a {red|blue} car'} />
        <div className="row">
          <span className="small faint">Variations with {'{a|b}'} expand into separate jobs.</span>
          <button className="btn sm primary right" disabled={!quick.trim()} onClick={addQuick}>Add to queue</button>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="empty">{jobs.length ? 'Nothing matches this filter.' : <><b>Queue is empty</b>Add prompts above or import a TXT, CSV, XLSX or JSON file.</>}</div>
      ) : (
        <div className="jobs">
          {shown.slice(0, 400).map((j) => (
            <JobRow
              key={j.id}
              j={j}
              open={open === j.id}
              selected={sel.has(j.id)}
              onToggle={() => toggle(j.id)}
              onOpen={() => setOpen(open === j.id ? null : j.id)}
              draggable={!running}
              onDragStart={() => setDrag(j.id)}
              onDrop={() => drop(j.id)}
              dragging={drag === j.id}
            />
          ))}
          {shown.length > 400 && <div className="job"><span /><span /><span className="muted small">{shown.length - 400} more not shown; use search or filters.</span></div>}
        </div>
      )}

      {naming && (
        <NameModal
          title={naming === 'new' ? 'New queue' : 'Rename queue'}
          initial={naming === 'new' ? `Queue ${queues.length + 1}` : q.name}
          onClose={() => setNaming(null)}
          onSave={(n) => act(async () => {
            if (naming === 'new') {
              const nq = await call<Queue>({ t: 'createQueue', name: n });
              setQueueId(nq.id);
            } else await call({ t: 'updateQueue', queueId: q.id, patch: { name: n } });
          })}
        />
      )}
    </div>
  );
}

function QuotaLine({ ps }: { ps: PanelState }) {
  const { quota, license } = ps;
  return (
    <div className="row small muted" title="FlowForge's own daily limit. Your Google Flow credits and limits are separate and are shown in Flow itself.">
      <span>
        {license.limits.label} plan:{' '}
        {quota.limit === null ? <>unlimited FlowForge jobs</> : <><b className="mono" style={{ color: 'var(--text)' }}>{quota.used}/{quota.limit}</b> jobs today, resets {new Date(quota.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>}
      </span>
      <span className="faint">· Flow credits are billed by Google, separately</span>
    </div>
  );
}

function Defaults({ q }: { q: Queue }) {
  const act = useAction();
  const d = q.defaults;
  const set = (patch: Partial<Queue['defaults']>) => act(() => call({ t: 'updateQueue', queueId: q.id, patch: { defaults: patch } }));
  return (
    <details className="card tight">
      <summary className="small" style={{ cursor: 'pointer' }}>
        New rows use: <b>{MODES.find((m) => m[0] === d.mode)?.[1]}</b> · {d.aspect ?? 'any ratio'} · ×{d.outputs ?? 1}{d.model ? ` · ${d.model}` : ''}
      </summary>
      <div className="grid2" style={{ marginTop: 8 }}>
        <label className="field"><span>Mode</span>
          <select value={d.mode} onChange={(e) => set({ mode: e.target.value as GenerationMode })}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="field"><span>Aspect ratio</span>
          <select value={d.aspect ?? ''} onChange={(e) => set({ aspect: (e.target.value || undefined) as Queue['defaults']['aspect'] })}>
            <option value="">Flow default</option>
            {ASPECT_RATIOS.map((a) => <option key={a}>{a}</option>)}
          </select>
        </label>
        <label className="field"><span>Outputs per prompt</span>
          <select value={d.outputs ?? 1} onChange={(e) => set({ outputs: Number(e.target.value) })}>{[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select>
        </label>
        <label className="field"><span>Model (as named in Flow)</span>
          <input defaultValue={d.model ?? ''} placeholder="Flow default" onBlur={(e) => set({ model: e.target.value.trim() || undefined })} />
        </label>
        {MODE_OUTPUT[d.mode] === 'video' && (
          <label className="field"><span>Duration (s)</span>
            <input type="number" min={2} max={30} defaultValue={d.durationSec ?? ''} placeholder="default" onBlur={(e) => set({ durationSec: Number(e.target.value) || undefined })} />
          </label>
        )}
      </div>
      <p className="small faint" style={{ marginBottom: 0 }}>Defaults apply to rows added from now on. Each row can override them.</p>
    </details>
  );
}

function Thumb({ k }: { k?: string }) {
  const u = useBlobUrl(k);
  return u ? <img src={u} alt="" /> : null;
}

function JobRow(p: { j: Job; open: boolean; selected: boolean; onToggle: () => void; onOpen: () => void; draggable: boolean; onDragStart: () => void; onDrop: () => void; dragging: boolean }) {
  const { j } = p;
  const act = useAction();
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(j.prompt);
  const active = ACTIVE_STATES.includes(j.state);
  const canEdit = !active && j.state !== 'succeeded' && j.state !== 'downloading';
  const last = j.history[j.history.length - 1];

  return (
    <div
      className={`job ${p.open ? 'open' : ''} ${p.selected ? 'sel' : ''} ${p.dragging ? 'dragging' : ''}`}
      draggable={p.draggable && !edit}
      onDragStart={p.onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={p.onDrop}
    >
      <input type="checkbox" checked={p.selected} onChange={p.onToggle} aria-label={`Select job ${j.index}`} style={{ accentColor: 'var(--accent)' }} />
      <span className="idx">{String(j.index).padStart(3, '0')}</span>
      <div style={{ minWidth: 0 }}>
        {edit ? (
          <div className="stack">
            <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            <div className="row tight">
              <button className="btn sm primary" onClick={() => act(async () => { await call({ t: 'updateJob', jobId: j.id, patch: { prompt: text } }); setEdit(false); })}>Save</button>
              <button className="btn sm ghost" onClick={() => (setEdit(false), setText(j.prompt))}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="prompt" onClick={p.onOpen} style={{ cursor: 'pointer' }}>
            {j.name && <b>{j.name}: </b>}
            {j.prompt}
          </div>
        )}
        <div className="meta">
          <StateChip state={j.state} />
          <span className="tag">{MODE_SHORT[j.mode]}</span>
          {j.options.aspect && <span className="tag">{j.options.aspect}</span>}
          {(j.options.outputs ?? 1) > 1 && <span className="tag">×{j.options.outputs}</span>}
          {j.options.model && <span className="tag">{j.options.model}</span>}
          {j.options.references?.length ? <span className="tag" title={j.options.references.map((r) => r.role).join(', ')}>{j.options.references.length} ref</span> : null}
          {j.dependsOn?.length ? <span className="tag" title="Waits for an earlier job">⛓</span> : null}
          {j.attempts > 1 && <span className="tag">try {j.attempts}</span>}
          {j.state === 'retry_wait' && j.nextRetryAt && <span className="small faint">in {dur(Math.max(0, j.nextRetryAt - Date.now()))}</span>}
          {active && last?.note && <span className="small faint">{last.note}</span>}
        </div>
        {j.error && !active && j.state !== 'succeeded' && (
          <div className="err">
            {j.error.message}
            {j.error.providerMessage && <span className="flow-said">Flow said: “{j.error.providerMessage}”</span>}
          </div>
        )}
        {j.outputs.some((o) => o.thumbKey) && (
          <div className="thumbs">{j.outputs.map((o) => <Thumb key={o.id} k={o.thumbKey} />)}</div>
        )}
        {p.open && (
          <div className="stack" style={{ marginTop: 6 }}>
            {j.outputs.map((o, i) => (
              <div key={o.id} className="small muted">
                {i + 1}. {o.kind} {o.width ? `${o.width}×${o.height}` : ''} {o.durationSec ? `${o.durationSec.toFixed(1)}s` : ''} {o.bytes ? `${Math.round(o.bytes / 1024)} KB` : ''}
                {o.savedPath ? <span className="faint"> → {o.savedPath}</span> : ''}
                {o.verifyNotes?.length ? <span style={{ color: 'var(--warn)' }}> · {o.verifyNotes.join(' ')}</span> : ''}
              </div>
            ))}
            <div className="history">
              {j.history.slice().reverse().map((h, i) => (
                <div key={i}>{new Date(h.at).toLocaleTimeString()} {h.from === h.to ? '·' : `${h.from} → ${h.to}`} {h.note ?? ''}</div>
              ))}
            </div>
            <div className="small faint">created {timeAgo(j.createdAt)} · id {j.id}</div>
          </div>
        )}
      </div>
      <div className="acts">
        {canEdit && <button className="icon-btn" title="Edit prompt" onClick={() => setEdit(true)}>✎</button>}
        {(PROBLEM.includes(j.state) || j.state === 'succeeded' || j.state === 'cancelled') && <button className="icon-btn" title={j.state === 'succeeded' ? 'Run again' : 'Retry'} onClick={() => act(() => call({ t: 'retryJobs', jobIds: [j.id] }))}>↻</button>}
        {j.state === 'download_failed' && <button className="icon-btn" title="Retry download" onClick={() => act(() => call({ t: 'redownload', jobId: j.id }))}>⤓</button>}
        {(active || j.state === 'queued' || j.state === 'retry_wait' || j.state === 'blocked') && <button className="icon-btn" title="Cancel" onClick={() => act(() => call({ t: 'cancelJob', jobId: j.id }))}>✕</button>}
      </div>
    </div>
  );
}

export function NameModal({ title, initial, onClose, onSave }: { title: string; initial: string; onClose: () => void; onSave: (name: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <Modal title={title} onClose={onClose}>
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && v.trim() && (onSave(v.trim()), onClose())} />
      <div className="row">
        <button className="btn primary right" disabled={!v.trim()} onClick={() => (onSave(v.trim()), onClose())}>Save</button>
      </div>
    </Modal>
  );
}
