import { useEffect, useRef, useState } from 'react';
import type { AspectRatio, Storyboard, StoryScene } from '@flowforge/core';
import { ASPECT_RATIOS, scenesFromScript, storyboardPrompt, uid } from '@flowforge/core';
import { call, delLocal, putLocal, useAssets, useStoryboards, type PanelState } from '../api';
import { Modal, useAction } from '../components/ui';

const SHOTS = ['', 'Wide', 'Medium', 'Close-up', 'Extreme close-up', 'Over-the-shoulder', 'Aerial', 'POV', 'Low angle'];
const CAMERA = ['', 'Static', 'Slow dolly in', 'Dolly out', 'Pan left', 'Pan right', 'Tracking', 'Handheld', 'Orbit', 'Crane up'];

export function StoryboardView({ ps, onRun }: { ps: PanelState | null; onRun: (queueId: string) => void }) {
  const [boards] = useStoryboards();
  const [openId, setOpenId] = useState<string | null>(null);
  const act = useAction();
  const board = boards.find((b) => b.id === openId);

  const create = () => act(async () => {
    const sb: Storyboard = { id: uid('sb'), name: `Story ${boards.length + 1}`, aspect: '9:16', style: '', characters: [], scenes: [], createdAt: Date.now(), updatedAt: Date.now() };
    await putLocal('storyboards', sb);
    setOpenId(sb.id);
  });

  if (board) return <Editor sb={board} ps={ps} onBack={() => setOpenId(null)} onRun={onRun} />;

  return (
    <div className="stack">
      <div className="row">
        <span className="muted small grow">A storyboard turns a script into scenes that keep the same characters and can continue from the previous clip's last frame.</span>
        <button className="btn primary" onClick={create}>New storyboard</button>
      </div>
      {boards.length === 0 && <div className="empty"><b>No storyboards</b>Paste a script, cast your characters from the Library, then run it as a chained queue.</div>}
      {boards.map((b) => (
        <button key={b.id} className="card row" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setOpenId(b.id)}>
          <div className="grow">
            <b>{b.name}</b>
            <div className="small muted">{b.scenes.length} scenes · {b.aspect}{b.style ? ` · ${b.style}` : ''}</div>
          </div>
          <span className="faint">›</span>
        </button>
      ))}
    </div>
  );
}

function Editor({ sb: stored, ps, onBack, onRun }: { sb: Storyboard; ps: PanelState | null; onBack: () => void; onRun: (queueId: string) => void }) {
  const act = useAction();
  // Edit a local copy and write it back shortly after typing stops, so fast typing never races the database.
  const [sb, setSb] = useState(stored);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const latest = useRef(sb);
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      void putLocal('storyboards', latest.current);
    }
  }, []);
  const [assets] = useAssets();
  const [script, setScript] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const chars = assets.filter((a) => a.character);
  const commit = (next: Storyboard) => {
    latest.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void putLocal('storyboards', latest.current);
    }, 400);
    return next;
  };
  const save = (patch: Partial<Storyboard>) => setSb((d) => commit({ ...d, ...patch, updatedAt: Date.now() }));
  const setScene = (id: string, patch: Partial<StoryScene>) =>
    setSb((d) => commit({ ...d, scenes: d.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)), updatedAt: Date.now() }));
  const limit = ps?.license.limits.storyboardScenes;
  const sheets = chars.filter((c) => sb.characters.includes(c.id)).map((c) => c.character!);

  const addScene = () => save({ scenes: [...sb.scenes, { id: uid('sc'), title: `Scene ${sb.scenes.length + 1}`, action: '', continuity: sb.scenes.length ? 'last-frame' : 'none' }] });
  const move = (i: number, d: number) => {
    const s = [...sb.scenes];
    const [x] = s.splice(i, 1);
    s.splice(i + d, 0, x);
    void save({ scenes: s });
  };

  return (
    <div className="stack">
      <div className="row">
        <button className="btn sm ghost" onClick={onBack}>‹ All storyboards</button>
        <button className="btn sm danger right" onClick={() => confirm(`Delete "${sb.name}"?`) && act(async () => { await delLocal('storyboards', sb.id); onBack(); })}>Delete</button>
      </div>
      <input value={sb.name} onChange={(e) => save({ name: e.target.value })} style={{ fontWeight: 600 }} aria-label="Storyboard name" />
      <div className="grid2">
        <label className="field"><span>Aspect ratio</span>
          <select value={sb.aspect} onChange={(e) => save({ aspect: e.target.value as AspectRatio })}>{ASPECT_RATIOS.map((a) => <option key={a}>{a}</option>)}</select>
        </label>
        <label className="field"><span>Look & style (added to every scene)</span>
          <input value={sb.style} onChange={(e) => save({ style: e.target.value })} placeholder="warm 35mm film, soft light" />
        </label>
      </div>
      <div className="stack">
        <h3>Cast</h3>
        {chars.length === 0 ? <div className="small muted">Mark images as characters in Library › References to cast them here.</div> : (
          <div className="row tight">
            {chars.map((c) => {
              const on = sb.characters.includes(c.id);
              return <button key={c.id} className={`chip ${on ? 'run' : ''}`} style={{ cursor: 'pointer' }} onClick={() => save({ characters: on ? sb.characters.filter((x) => x !== c.id) : [...sb.characters, c.id] })}>{on ? '✓ ' : ''}{c.character!.displayName}</button>;
            })}
          </div>
        )}
      </div>

      <div className="row">
        <h3 className="grow">Scenes {limit !== null && limit !== undefined && <span className="faint">({sb.scenes.length}/{limit} on {ps?.license.limits.label})</span>}</h3>
        <button className="btn sm ghost" onClick={() => setScript('')}>Paste script…</button>
        <button className="btn sm" onClick={addScene}>＋ Scene</button>
      </div>

      {sb.scenes.map((s, i) => (
        <div key={s.id} className="stack" style={{ gap: 4 }}>
          {i > 0 && <div className="chain">{s.continuity === 'last-frame' ? '⛓ continues from the last frame of the scene above' : s.continuity === 'same-references' ? '↺ same character references' : '· independent shot'}</div>}
          <div className="scene card tight">
            <span className="scene-n">{String(i + 1).padStart(2, '0')}</span>
            <div className="stack" style={{ gap: 6 }}>
              <div className="row tight">
                <input className="grow" value={s.title} onChange={(e) => setScene(s.id, { title: e.target.value })} aria-label="Scene title" />
                <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">↑</button>
                <button className="icon-btn" disabled={i === sb.scenes.length - 1} onClick={() => move(i, 1)} title="Move down">↓</button>
                <button className="icon-btn" onClick={() => save({ scenes: sb.scenes.filter((x) => x.id !== s.id) })} title="Remove">✕</button>
              </div>
              <textarea rows={2} value={s.action} onChange={(e) => setScene(s.id, { action: e.target.value })} placeholder="What happens in this shot" />
              <div className="grid3">
                <select value={s.shot ?? ''} onChange={(e) => setScene(s.id, { shot: e.target.value || undefined })} aria-label="Shot">{SHOTS.map((x) => <option key={x} value={x}>{x || 'Shot…'}</option>)}</select>
                <select value={s.camera ?? ''} onChange={(e) => setScene(s.id, { camera: e.target.value || undefined })} aria-label="Camera">{CAMERA.map((x) => <option key={x} value={x}>{x || 'Camera…'}</option>)}</select>
                <select value={s.continuity} onChange={(e) => setScene(s.id, { continuity: e.target.value as StoryScene['continuity'] })} aria-label="Continuity">
                  <option value="none">Fresh shot</option>
                  <option value="last-frame">From last frame</option>
                  <option value="same-references">Same references</option>
                </select>
              </div>
              <div className="grid2">
                <input value={s.location ?? ''} onChange={(e) => setScene(s.id, { location: e.target.value || undefined })} placeholder="Location" />
                <input value={s.dialogue ?? ''} onChange={(e) => setScene(s.id, { dialogue: e.target.value || undefined })} placeholder="Dialogue (spoken line)" />
              </div>
            </div>
          </div>
        </div>
      ))}

      {sb.scenes.length > 0 && (
        <div className="row">
          <button className="btn ghost" onClick={() => setPreview(true)}>Preview prompts</button>
          <button className="btn primary right" onClick={() => act(async () => {
            if (timer.current) clearTimeout(timer.current);
            await putLocal('storyboards', latest.current);
            const r = await call<{ queueId: string }>({ t: 'runStoryboard', storyboardId: sb.id });
            onRun(r.queueId);
          })}>Run {sb.scenes.length} scenes</button>
        </div>
      )}

      {script !== null && (
        <Modal title="Script to scenes" onClose={() => setScript(null)}>
          <div className="small muted">Each paragraph becomes a scene. Lines in quotes become dialogue. “Scene 3: Rooftop” style headings become titles.</div>
          <textarea rows={12} value={script} onChange={(e) => setScript(e.target.value)} autoFocus />
          <div className="row">
            <span className="small faint">{script.trim() ? `${scenesFromScript(script).length} scenes` : ''}</span>
            <button className="btn sm right" onClick={() => (save({ scenes: [...sb.scenes, ...scenesFromScript(script)] }), setScript(null))}>Append scenes</button>
            <button className="btn sm primary" onClick={() => (save({ scenes: scenesFromScript(script) }), setScript(null))}>Replace scenes</button>
          </div>
        </Modal>
      )}
      {preview && (
        <Modal title="What FlowForge will send" onClose={() => setPreview(false)}>
          {sb.scenes.map((s, i) => (
            <div key={s.id} className="card tight small" style={{ whiteSpace: 'pre-wrap' }}>
              <b>{i + 1}. {s.title}</b>{'\n'}{storyboardPrompt(sb, s, (s.characters?.length ? chars.filter((c) => s.characters!.includes(c.id)).map((c) => c.character!) : sheets))}
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}
