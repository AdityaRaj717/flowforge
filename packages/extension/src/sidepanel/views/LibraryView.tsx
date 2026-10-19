import { useMemo, useState } from 'react';
import type { Asset, Job } from '@flowforge/core';
import { uid } from '@flowforge/core';
import * as db from '../../shared/db';
import { call, delLocal, putLocal, useAllJobs, useAssets, useBlobUrl, useQueues } from '../api';
import { Modal, useAction } from '../components/ui';

type Sub = 'outputs' | 'assets';

export function LibraryView() {
  const [sub, setSub] = useState<Sub>('outputs');
  return (
    <div className="stack">
      <div className="row tight">
        <button className={`btn sm ${sub === 'outputs' ? '' : 'ghost'}`} onClick={() => setSub('outputs')}>Generated</button>
        <button className={`btn sm ${sub === 'assets' ? '' : 'ghost'}`} onClick={() => setSub('assets')}>References & characters</button>
      </div>
      {sub === 'outputs' ? <Outputs /> : <Assets />}
    </div>
  );
}

function Outputs() {
  const [jobs] = useAllJobs();
  const [queues] = useQueues();
  const act = useAction();
  const [kind, setKind] = useState<'all' | 'image' | 'video'>('all');
  const [qid, setQid] = useState('all');
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [view, setView] = useState<{ j: Job; i: number } | null>(null);

  const items = useMemo(() => {
    const s = search.toLowerCase();
    const out: { j: Job; i: number; key: string }[] = [];
    jobs
      .filter((j) => j.outputs.length && (qid === 'all' || j.queueId === qid) && (!s || j.prompt.toLowerCase().includes(s)))
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      .forEach((j) => j.outputs.forEach((o, i) => (kind === 'all' || o.kind === kind) && out.push({ j, i, key: o.id })));
    return out;
  }, [jobs, kind, qid, search]);

  const toggle = (k: string) => setSel((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  });

  const failedDownloads = items.filter((x) => !x.j.outputs[x.i].savedPath);

  return (
    <>
      <div className="row tight">
        <select value={qid} onChange={(e) => setQid(e.target.value)} aria-label="Queue filter">
          <option value="all">All queues</option>
          {queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Type filter">
          <option value="all">Images & videos</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
        </select>
        <input className="grow" placeholder="Search prompts" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="row tight small">
        <span className="muted">{items.length} output(s){sel.size ? ` · ${sel.size} selected` : ''}</span>
        {sel.size > 0 && (
          <>
            <button className="btn sm" onClick={() => act(async () => {
              const ids = new Set(items.filter((x) => sel.has(x.key)).map((x) => x.j.id));
              for (const id of ids) await call({ t: 'redownload', jobId: id });
            }, 'Download started')}>Download again</button>
            <button className="btn sm" onClick={() => act(async () => {
              for (const x of items.filter((y) => sel.has(y.key))) await saveAsReference(x.j, x.i);
              setSel(new Set());
            }, 'Added to references')}>Use as reference</button>
            <button className="btn sm ghost" onClick={() => setSel(new Set())}>Clear</button>
          </>
        )}
        {!sel.size && failedDownloads.length > 0 && <span className="chip warn">{failedDownloads.length} not saved to disk</span>}
        <button className="btn sm ghost right" onClick={() => setSel(new Set(items.map((x) => x.key)))}>Select all</button>
      </div>
      {items.length === 0 ? (
        <div className="empty"><b>Nothing generated yet</b>Finished jobs show up here with previews, sizes and where the files were saved.</div>
      ) : (
        <div className="gallery">
          {items.slice(0, 600).map((x) => (
            <Tile key={x.key} j={x.j} i={x.i} selected={sel.has(x.key)} onClick={(e) => (e.shiftKey || e.ctrlKey || e.metaKey || sel.size ? toggle(x.key) : setView({ j: x.j, i: x.i }))} />
          ))}
        </div>
      )}
      {view && <OutputModal j={view.j} i={view.i} onClose={() => setView(null)} />}
    </>
  );
}

async function saveAsReference(j: Job, i: number) {
  const o = j.outputs[i];
  const blob = (await db.get<Blob>('blobs', `out:${o.id}`)) ?? (o.sourceUrl ? await fetch(o.sourceUrl).then((r) => (r.ok ? r.blob() : undefined)).catch(() => undefined) : undefined) ?? (o.thumbKey ? await db.get<Blob>('blobs', o.thumbKey) : undefined);
  if (!blob) throw new Error('The original file is no longer available in the browser; add it from disk instead.');
  const asset: Asset = {
    id: uid('a'), name: `${j.name ?? `job-${j.index}`}-${i + 1}`, kind: o.kind, mime: blob.type || 'image/png', blobKey: uid('b'), bytes: blob.size,
    width: o.width, height: o.height, tags: ['generated'], aliases: [], source: 'generated', sourceJobId: j.id, createdAt: Date.now(),
  };
  await db.put('blobs', blob, asset.blobKey);
  await putLocal('assets', asset);
}

function Tile({ j, i, selected, onClick }: { j: Job; i: number; selected: boolean; onClick: (e: React.MouseEvent) => void }) {
  const o = j.outputs[i];
  const u = useBlobUrl(o.thumbKey);
  return (
    <div className={`tile ${selected ? 'sel' : ''}`} onClick={onClick} title={j.prompt}>
      {u ? <img src={u} alt="" loading="lazy" /> : <div style={{ display: 'grid', placeItems: 'center', height: '100%' }} className="faint small">{o.kind}</div>}
      <span className="badge">{o.kind === 'video' ? `▶ ${o.durationSec ? `${Math.round(o.durationSec)}s` : ''}` : `${o.width ?? ''}${o.width ? '×' : ''}${o.height ?? ''}`}</span>
      <span className="cap">#{j.index} {j.prompt}</span>
    </div>
  );
}

function OutputModal({ j, i, onClose }: { j: Job; i: number; onClose: () => void }) {
  const o = j.outputs[i];
  const u = useBlobUrl(o.thumbKey);
  const act = useAction();
  return (
    <Modal title={`#${j.index} · output ${i + 1}`} onClose={onClose}>
      {u && <img src={u} alt="" style={{ width: '100%', borderRadius: 8 }} />}
      <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{j.prompt}</div>
      <div className="small muted">
        {o.kind} · {o.width}×{o.height}{o.durationSec ? ` · ${o.durationSec.toFixed(1)}s` : ''}{o.bytes ? ` · ${(o.bytes / 1024 / 1024).toFixed(2)} MB` : ''}
        {o.sha256 && <div className="mono faint">sha256 {o.sha256.slice(0, 16)}…</div>}
        {o.savedPath ? <div>Saved to {o.savedPath}</div> : <div style={{ color: 'var(--warn)' }}>Not saved to disk.</div>}
        {o.verifyNotes?.map((n, k) => <div key={k} style={{ color: 'var(--warn)' }}>{n}</div>)}
      </div>
      <div className="row">
        {o.downloadId && <button className="btn sm" onClick={() => chrome.downloads.show(o.downloadId!)}>Show in folder</button>}
        <button className="btn sm" onClick={() => act(() => call({ t: 'redownload', jobId: j.id }), 'Download started')}>Download again</button>
        <button className="btn sm" onClick={() => act(() => saveAsReference(j, i), 'Added to references')}>Use as reference</button>
        <button className="btn sm ghost right" onClick={() => navigator.clipboard.writeText(j.prompt)}>Copy prompt</button>
      </div>
    </Modal>
  );
}

// ---------- reference assets ----------

function Assets() {
  const [assets] = useAssets();
  const act = useAction();
  const [over, setOver] = useState(false);
  const [edit, setEdit] = useState<Asset | null>(null);
  const [filter, setFilter] = useState('');
  const [showFrames, setShowFrames] = useState(false);

  const add = (files: FileList | File[]) =>
    act(async () => {
      for (const f of Array.from(files)) {
        if (!f.type.startsWith('image/')) continue;
        const bmp = await createImageBitmap(f).catch(() => null);
        const stem = f.name.replace(/\.[^.]+$/, '');
        const asset: Asset = {
          id: uid('a'), name: f.name, kind: 'image', mime: f.type, blobKey: uid('b'), bytes: f.size, width: bmp?.width, height: bmp?.height,
          tags: [], aliases: [stem.toLowerCase().replace(/[\s_]+/g, '-')], source: 'upload', createdAt: Date.now(),
        };
        bmp?.close();
        await db.put('blobs', f, asset.blobKey);
        await putLocal('assets', asset);
      }
    }, 'Added');

  const shown = assets.filter((a) => (showFrames || a.source !== 'lastframe') && (!filter || `${a.name} ${a.aliases.join(' ')} ${a.tags.join(' ')} ${a.collection ?? ''} ${a.character?.displayName ?? ''}`.toLowerCase().includes(filter.toLowerCase())));
  const frames = assets.filter((a) => a.source === 'lastframe').length;

  return (
    <>
      <label className={`drop ${over ? 'over' : ''}`} onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={(e) => (e.preventDefault(), setOver(false), add(e.dataTransfer.files))}>
        <input type="file" hidden multiple accept="image/*" onChange={(e) => e.target.files && add(e.target.files)} />
        Drop reference images, characters, start/end frames
        <div className="small">Imports match them by file name or alias; prompts can attach them with @alias.</div>
      </label>
      <div className="row tight">
        <input className="grow" placeholder="Filter by name, alias, tag, collection" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {frames > 0 && <label className="check small"><input type="checkbox" checked={showFrames} onChange={(e) => setShowFrames(e.target.checked)} />{frames} last frames</label>}
      </div>
      {shown.length === 0 ? (
        <div className="empty"><b>No references yet</b>Add a character once, give it an alias like <span className="mono">@mira</span>, and every prompt that mentions it gets the image attached.</div>
      ) : (
        <div className="gallery">
          {shown.map((a) => <AssetTile key={a.id} a={a} onClick={() => setEdit(a)} />)}
        </div>
      )}
      {edit && <AssetModal a={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function AssetTile({ a, onClick }: { a: Asset; onClick: () => void }) {
  const u = useBlobUrl(a.blobKey);
  return (
    <div className="tile" onClick={onClick} title={a.name}>
      {u && <img src={u} alt="" loading="lazy" />}
      {a.character && <span className="badge">character</span>}
      <span className="cap">{a.aliases[0] ? `@${a.aliases[0]}` : a.name}</span>
    </div>
  );
}

function AssetModal({ a, onClose }: { a: Asset; onClose: () => void }) {
  const u = useBlobUrl(a.blobKey);
  const act = useAction();
  const [name, setName] = useState(a.name);
  const [aliases, setAliases] = useState(a.aliases.join(', '));
  const [tags, setTags] = useState(a.tags.join(', '));
  const [collection, setCollection] = useState(a.collection ?? '');
  const [isChar, setIsChar] = useState(!!a.character);
  const [ch, setCh] = useState(a.character ?? { displayName: a.aliases[0] ?? a.name, description: '', wardrobe: '', locks: [], avoid: [] });
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  const save = () => act(async () => {
    await putLocal('assets', {
      ...a, name, aliases: list(aliases).map((x) => x.replace(/^@/, '').toLowerCase()), tags: list(tags), collection: collection || undefined,
      character: isChar ? { ...ch, locks: ch.locks?.filter(Boolean), avoid: ch.avoid?.filter(Boolean) } : undefined,
    } satisfies Asset);
    onClose();
  }, 'Saved');

  return (
    <Modal title="Reference" onClose={onClose}>
      {u && <img src={u} alt="" style={{ maxHeight: 220, objectFit: 'contain', borderRadius: 8, background: 'var(--bg-3)' }} />}
      <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>Aliases (used for @mentions and file matching)</span><input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="mira, hero" /></label>
      <div className="grid2">
        <label className="field"><span>Tags</span><input value={tags} onChange={(e) => setTags(e.target.value)} /></label>
        <label className="field"><span>Collection</span><input value={collection} onChange={(e) => setCollection(e.target.value)} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={isChar} onChange={(e) => setIsChar(e.target.checked)} />This is a character (adds a consistency note to every scene it appears in)</label>
      {isChar && (
        <div className="card tight stack">
          <label className="field"><span>Display name</span><input value={ch.displayName} onChange={(e) => setCh({ ...ch, displayName: e.target.value })} /></label>
          <label className="field"><span>Look (face, hair, build, age)</span><textarea rows={2} value={ch.description} onChange={(e) => setCh({ ...ch, description: e.target.value })} /></label>
          <label className="field"><span>Wardrobe</span><input value={ch.wardrobe ?? ''} onChange={(e) => setCh({ ...ch, wardrobe: e.target.value })} /></label>
          <label className="field"><span>Always (comma separated)</span><input value={ch.locks?.join(', ') ?? ''} onChange={(e) => setCh({ ...ch, locks: list(e.target.value) })} placeholder="red scarf, left-handed" /></label>
          <label className="field"><span>Never</span><input value={ch.avoid?.join(', ') ?? ''} onChange={(e) => setCh({ ...ch, avoid: list(e.target.value) })} placeholder="glasses, beard" /></label>
        </div>
      )}
      <div className="row">
        <button className="btn sm danger" onClick={() => confirm('Delete this reference?') && act(async () => { await db.del('blobs', a.blobKey); await delLocal('assets', a.id); onClose(); })}>Delete</button>
        <span className="small faint">{a.width}×{a.height} · {Math.round(a.bytes / 1024)} KB</span>
        <button className="btn primary right" onClick={save}>Save</button>
      </div>
    </Modal>
  );
}
