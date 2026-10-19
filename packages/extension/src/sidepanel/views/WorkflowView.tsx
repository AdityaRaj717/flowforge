import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position, addEdge, applyEdgeChanges, applyNodeChanges,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Job, NodeKind, Workflow, WorkflowEdge, WorkflowNode } from '@flowforge/core';
import { ASPECT_RATIOS, NODE_SPECS, STATE_LABEL, uid, validateWorkflow } from '@flowforge/core';
import { call, delLocal, putLocal, useAllJobs, useAssets, useBlobUrl, useWorkflows, type PanelState } from '../api';
import { useAction } from '../components/ui';

type FFData = WorkflowNode['data'] & { kind: NodeKind; status?: string; error?: boolean; thumb?: string };

const PALETTE: [NodeKind, string][] = [['prompt', 'Prompt'], ['asset', 'Asset'], ['image', 'Image'], ['video', 'Video'], ['lastFrame', 'Last frame'], ['pick', 'Pick'], ['merge', 'Merge'], ['note', 'Note']];
const TEMPLATES: Record<string, () => Pick<Workflow, 'nodes' | 'edges'>> = {
  'Image → animate': () => ({
    nodes: [
      n('p1', 'prompt', 0, 0, { text: 'Portrait of a lighthouse keeper, golden hour' }),
      n('i1', 'image', 260, 0, { options: { outputs: 2, aspect: '9:16' } }),
      n('pk', 'pick', 500, 0, { pickIndex: 1 }),
      n('p2', 'prompt', 500, 160, { text: 'She turns toward the sea as waves crash below' }),
      n('v1', 'video', 760, 40, { options: { aspect: '9:16' } }),
    ],
    edges: [e('p1', 'i1', 'prompt'), e('i1', 'pk', 'in'), e('pk', 'v1', 'start'), e('p2', 'v1', 'prompt')],
  }),
  '3-shot chain': () => ({
    nodes: [
      n('s1', 'prompt', 0, 0, { text: 'Shot 1: a paper boat sails down a rainy gutter' }),
      n('v1', 'video', 260, 0, {}),
      n('l1', 'lastFrame', 500, 0, {}),
      n('s2', 'prompt', 500, 140, { text: 'Shot 2: the boat drops into a storm drain, light from above' }),
      n('v2', 'video', 740, 40, {}),
      n('l2', 'lastFrame', 980, 40, {}),
      n('s3', 'prompt', 980, 180, { text: 'Shot 3: it emerges into a glowing underground river' }),
      n('v3', 'video', 1220, 80, {}),
      n('m', 'merge', 1460, 80, { label: 'Final cut' }),
    ],
    edges: [e('s1', 'v1', 'prompt'), e('v1', 'l1', 'video'), e('l1', 'v2', 'start'), e('s2', 'v2', 'prompt'), e('v2', 'l2', 'video'), e('l2', 'v3', 'start'), e('s3', 'v3', 'prompt'), e('v1', 'm', 'clips'), e('v2', 'm', 'clips'), e('v3', 'm', 'clips')],
  }),
};

function n(id: string, kind: NodeKind, x: number, y: number, data: WorkflowNode['data']): WorkflowNode {
  return { id, kind, position: { x, y }, data };
}
function e(source: string, target: string, targetHandle: string): WorkflowEdge {
  return { id: `${source}-${target}-${targetHandle}`, source, target, targetHandle };
}

function FFNode({ data, selected }: NodeProps<Node<FFData>>) {
  const spec = NODE_SPECS[data.kind];
  const thumb = useBlobUrl(data.thumb);
  const body =
    data.kind === 'prompt' || data.kind === 'note' ? data.text :
    data.kind === 'image' || data.kind === 'video' ? [data.mode, data.options?.aspect, data.options?.outputs && `×${data.options.outputs}`, data.options?.model].filter(Boolean).join(' · ') :
    data.kind === 'pick' ? `output #${data.pickIndex ?? 1}` : '';
  return (
    <div className={`ffnode ${selected ? 'selected' : ''} ${data.error ? 'err' : ''}`} style={data.skip ? { opacity: 0.5 } : undefined}>
      <div className="ffnode-h">
        <span className={`k-${data.kind}`}>●</span>
        {data.label || spec.label}
        {data.status && <span className="chip" style={{ marginLeft: 'auto', fontSize: 10 }}>{data.status}</span>}
      </div>
      {spec.inputs.map((p) => (
        <div key={p.name} className="port">
          <Handle type="target" position={Position.Left} id={p.name} className={`t-${p.type}`} style={{ top: '50%', left: -5 }} />
          {p.name}{p.required ? '*' : ''}{p.multiple ? ' …' : ''}
        </div>
      ))}
      {thumb && <img src={thumb} alt="" style={{ width: '100%', display: 'block' }} />}
      {body && <div className="ffnode-b">{body}</div>}
      {spec.output && <Handle type="source" position={Position.Right} className={`t-${spec.output}`} />}
    </div>
  );
}

const nodeTypes = { ff: FFNode };

function toFlow(wf: Workflow, jobs: Job[]): { nodes: Node<FFData>[]; edges: Edge[] } {
  const latest = new Map<string, Job>();
  jobs.forEach((j) => {
    if (j.workflowId !== wf.id || !j.nodeId) return;
    const cur = latest.get(j.nodeId);
    if (!cur || cur.createdAt < j.createdAt) latest.set(j.nodeId, j);
  });
  return {
    nodes: wf.nodes.map((x) => {
      const j = latest.get(x.id);
      return { id: x.id, type: 'ff', position: x.position, data: { ...x.data, kind: x.kind, status: j ? STATE_LABEL[j.state] : undefined, thumb: j?.outputs[0]?.thumbKey } };
    }),
    edges: wf.edges.map((x) => ({ id: x.id, source: x.source, target: x.target, targetHandle: x.targetHandle, sourceHandle: x.sourceHandle, animated: latest.get(x.target)?.state === 'generating' })),
  };
}

function fromFlow(wf: Workflow, nodes: Node<FFData>[], edges: Edge[]): Workflow {
  return {
    ...wf,
    nodes: nodes.map(({ id, position, data }) => {
      const { kind, status: _s, error: _e, thumb: _t, ...rest } = data;
      return { id, kind, position, data: rest };
    }),
    edges: edges.map((x) => ({ id: x.id, source: x.source, target: x.target, targetHandle: x.targetHandle ?? '', sourceHandle: x.sourceHandle ?? undefined })),
    updatedAt: Date.now(),
  };
}

export default function WorkflowView({ ps, onRun }: { ps: PanelState | null; queueId?: string; onRun: (queueId: string) => void }) {
  const [wfs] = useWorkflows();
  const [id, setId] = useState<string | null>(null);
  const act = useAction();
  useEffect(() => {
    if (!id && wfs.length) setId(wfs[0].id);
  }, [wfs, id]);
  const wf = wfs.find((w) => w.id === id);

  const create = (tpl?: string) => act(async () => {
    const base = tpl ? TEMPLATES[tpl]() : { nodes: [n('p1', 'prompt', 0, 0, { text: '' }), n('g1', 'image', 280, 0, {})], edges: [e('p1', 'g1', 'prompt')] };
    const w: Workflow = { id: uid('wf'), name: tpl ?? `Workflow ${wfs.length + 1}`, ...base, createdAt: Date.now(), updatedAt: Date.now() };
    await putLocal('workflows', w);
    setId(w.id);
  });

  const importJson = (f: File) => act(async () => {
    // Exports carry // comment lines to help people (and AI assistants) edit them; strip before parsing.
    const text = (await f.text()).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const w = JSON.parse(text) as Workflow;
    if (!Array.isArray(w.nodes) || !Array.isArray(w.edges)) throw new Error('Not a FlowForge workflow file.');
    const copy: Workflow = { ...w, id: uid('wf'), name: `${w.name ?? 'Imported'}`, createdAt: Date.now(), updatedAt: Date.now() };
    await putLocal('workflows', copy);
    setId(copy.id);
  }, 'Imported');

  return (
    <div className="wf">
      <div className="wf-bar">
        <select value={id ?? ''} onChange={(ev) => setId(ev.target.value)} aria-label="Workflow">
          {!wfs.length && <option value="">No workflows</option>}
          {wfs.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <button className="btn sm" onClick={() => create()}>＋ New</button>
        <select value="" onChange={(ev) => ev.target.value && create(ev.target.value)} aria-label="From template">
          <option value="">From template…</option>
          {Object.keys(TEMPLATES).map((t) => <option key={t}>{t}</option>)}
        </select>
        <label className="btn sm ghost">Import<input type="file" hidden accept=".json" onChange={(ev) => ev.target.files?.[0] && importJson(ev.target.files[0])} /></label>
      </div>
      {wf ? <Canvas key={wf.id} wf={wf} ps={ps} onRun={onRun} /> : <div className="view"><div className="empty"><b>Visual workflows</b>Wire prompts, references, image and video steps. FlowForge runs them in dependency order with the same retries and downloads as a queue.</div></div>}
    </div>
  );
}

function Canvas({ wf, ps, onRun }: { wf: Workflow; ps: PanelState | null; onRun: (queueId: string) => void }) {
  const act = useAction();
  const [jobs] = useAllJobs();
  const [assets] = useAssets();
  const init = useMemo(() => toFlow(wf, jobs), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes] = useState<Node<FFData>[]>(init.nodes);
  const [edges, setEdges] = useState<Edge[]>(init.edges);
  const [name, setName] = useState(wf.name);
  const [selected, setSelected] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const latest = useRef({ nodes, edges, name });
  latest.current = { nodes, edges, name };

  const persist = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined; // saved: nothing left for the unmount flush to write
      const { nodes: ns, edges: es, name: nm } = latest.current;
      void putLocal('workflows', fromFlow({ ...wf, name: nm }, ns, es));
    }, 500);
  }, [wf]);
  useEffect(() => () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      const { nodes: ns, edges: es, name: nm } = latest.current;
      void putLocal('workflows', fromFlow({ ...wf, name: nm }, ns, es));
    }
  }, [wf]);

  // Live status from the jobs this workflow produced.
  useEffect(() => {
    const fresh = toFlow(fromFlow(wf, nodes, edges), jobs);
    setNodes((ns) => ns.map((x) => {
      const f = fresh.nodes.find((y) => y.id === x.id);
      return f && (f.data.status !== x.data.status || f.data.thumb !== x.data.thumb) ? { ...x, data: { ...x.data, status: f.data.status, thumb: f.data.thumb } } : x;
    }));
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = fromFlow({ ...wf, name }, nodes, edges);
  const issues = useMemo(() => validateWorkflow(current, { agentConnected: ps?.agent.connected, assetIds: new Set(assets.map((a) => a.id)) }), [nodes, edges, assets, ps?.agent.connected]); // eslint-disable-line react-hooks/exhaustive-deps
  const errorNodes = new Set(issues.filter((i) => i.level === 'error' && i.nodeId).map((i) => i.nodeId!));
  const shownNodes = nodes.map((x) => (errorNodes.has(x.id) !== !!x.data.error ? { ...x, data: { ...x.data, error: errorNodes.has(x.id) } } : x));

  const onNodesChange = useCallback((c: NodeChange<Node<FFData>>[]) => {
    setNodes((ns) => applyNodeChanges(c, ns));
    if (c.some((x) => x.type !== 'select' && x.type !== 'dimensions')) persist();
  }, [persist]);
  const onEdgesChange = useCallback((c: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(c, es));
    persist();
  }, [persist]);
  const onConnect = useCallback((c: Connection) => {
    setEdges((es) => addEdge({ ...c, id: uid('e') }, es));
    persist();
  }, [persist]);

  const addNode = (kind: NodeKind) => {
    const idn = uid(kind.slice(0, 2));
    const y = Math.max(0, ...nodes.map((x) => x.position.y)) + 40;
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { id: idn, type: 'ff', position: { x: 80 + (ns.length % 4) * 60, y }, selected: true, data: { kind, text: kind === 'prompt' ? '' : undefined } }]);
    setSelected(idn);
    persist();
  };
  const update = (idn: string, patch: Partial<FFData>) => {
    setNodes((ns) => ns.map((x) => (x.id === idn ? { ...x, data: { ...x.data, ...patch } } : x)));
    persist();
  };

  const run = (from?: string) => act(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    await putLocal('workflows', current);
    const r = await call<{ queueId: string; jobIds: string[] }>({ t: 'runWorkflow', workflowId: wf.id, fromNodeId: from });
    onRun(r.queueId);
  });

  const exportWf = () => {
    const header = [
      '// FlowForge workflow. Node kinds: prompt, asset, image, video, lastFrame, pick, merge, note.',
      '// Edges: source -> target.targetHandle. Inputs: image{prompt,source,refs,style} video{prompt,start,end,ingredients,extend}',
      '// lastFrame{video} pick{in} merge{clips} prompt{text}. Lines starting with // are ignored on import.',
    ].join('\n');
    const blob = new Blob([`${header}\n${JSON.stringify(current, null, 2)}`], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w-]+/g, '_')}.flowforge.json`;
    a.click();
  };

  const sel = nodes.find((x) => x.id === selected);
  const limit = ps?.license.limits.workflowNodes;
  const errors = issues.filter((i) => i.level === 'error');

  return (
    <div className="wf" style={{ gridTemplateRows: 'auto auto 1fr' }}>
      <div className="wf-bar">
        <input value={name} onChange={(ev) => (setName(ev.target.value), persist())} aria-label="Workflow name" style={{ width: 150 }} />
        {PALETTE.map(([k, l]) => <button key={k} className="btn sm ghost" onClick={() => addNode(k)} title={NODE_SPECS[k].label}>＋{l}</button>)}
      </div>
      <div className="wf-bar">
        <button className="btn sm primary" disabled={errors.length > 0} onClick={() => run()} title={errors[0]?.message}>▶ Run all</button>
        <button className="btn sm" disabled={!sel || errors.length > 0 || !['image', 'video', 'merge'].includes(sel.data.kind)} onClick={() => run(selected!)}>Run from selected</button>
        <span className={`chip ${errors.length ? 'bad' : 'ok'}`}>{errors.length ? `${errors.length} issue(s)` : 'Ready'}</span>
        {limit !== null && limit !== undefined && <span className={`small ${nodes.length > limit ? '' : 'faint'}`} style={nodes.length > limit ? { color: 'var(--warn)' } : undefined}>{nodes.length}/{limit} nodes{nodes.length > limit ? ` (over the ${ps?.license.limits.label} limit)` : ''}</span>}
        <button className="btn sm ghost right" onClick={exportWf}>Export</button>
        <button className="btn sm ghost danger" onClick={() => {
          if (!confirm(`Delete workflow "${name}"?`)) return;
          // A pending save would otherwise be flushed on unmount and bring the workflow back.
          clearTimeout(saveTimer.current);
          saveTimer.current = undefined;
          void act(() => delLocal('workflows', wf.id));
        }}>Delete</button>
      </div>
      <div className="wf-body">
        <ReactFlow
          nodes={shownNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={({ nodes: s }) => setSelected(s[0]?.id ?? null)}
          fitView
          colorMode="dark"
          deleteKeyCode={['Delete', 'Backspace']}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} size={1} color="#2b251e" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable maskColor="#0009" nodeColor="#433a2f" />
        </ReactFlow>
        <div className="wf-side stack">
          {sel && <Inspector node={sel} assets={assets} update={(p) => update(sel.id, p)} />}
          {issues.length > 0 && (
            <div className="card tight stack small">
              <h3>Checks</h3>
              {issues.map((i, k) => (
                <button key={k} className="btn ghost sm" style={{ justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left', color: i.level === 'error' ? 'var(--bad)' : 'var(--warn)' }} onClick={() => i.nodeId && setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === i.nodeId })))}>
                  {i.message}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Inspector({ node, assets, update }: { node: Node<FFData>; assets: { id: string; name: string; aliases: string[] }[]; update: (p: Partial<FFData>) => void }) {
  const d = node.data;
  const opts = d.options ?? {};
  const setOpt = (p: Partial<NonNullable<FFData['options']>>) => update({ options: { ...opts, ...p } });
  return (
    <div className="card tight stack small">
      <div className="row"><h3 className="grow">{NODE_SPECS[d.kind].label}</h3><span className="faint mono">{node.id}</span></div>
      <label className="field"><span>Label</span><input value={d.label ?? ''} onChange={(ev) => update({ label: ev.target.value || undefined })} /></label>
      {(d.kind === 'prompt' || d.kind === 'note') && <textarea rows={5} value={d.text ?? ''} onChange={(ev) => update({ text: ev.target.value })} placeholder={d.kind === 'prompt' ? 'Prompt text. Connected prompts are joined in order.' : 'Note'} />}
      {d.kind === 'asset' && (
        <select value={d.assetId ?? ''} onChange={(ev) => update({ assetId: ev.target.value || undefined })}>
          <option value="">Pick from Library…</option>
          {assets.map((a) => <option key={a.id} value={a.id}>{a.aliases[0] ? `@${a.aliases[0]}` : a.name}</option>)}
        </select>
      )}
      {d.kind === 'pick' && <label className="field"><span>Use output #</span><select value={d.pickIndex ?? 1} onChange={(ev) => update({ pickIndex: Number(ev.target.value) })}>{[1, 2, 3, 4].map((x) => <option key={x}>{x}</option>)}</select></label>}
      {(d.kind === 'image' || d.kind === 'video') && (
        <>
          <div className="grid2">
            <label className="field"><span>Aspect</span><select value={opts.aspect ?? ''} onChange={(ev) => setOpt({ aspect: (ev.target.value || undefined) as never })}><option value="">Default</option>{ASPECT_RATIOS.map((a) => <option key={a}>{a}</option>)}</select></label>
            <label className="field"><span>Outputs</span><select value={opts.outputs ?? 1} onChange={(ev) => setOpt({ outputs: Number(ev.target.value) })}>{[1, 2, 3, 4].map((x) => <option key={x}>{x}</option>)}</select></label>
          </div>
          <label className="field"><span>Model</span><input value={opts.model ?? ''} onChange={(ev) => setOpt({ model: ev.target.value || undefined })} placeholder="Flow default" /></label>
          {d.kind === 'video' && <label className="field"><span>Duration (s)</span><input type="number" value={opts.durationSec ?? ''} onChange={(ev) => setOpt({ durationSec: Number(ev.target.value) || undefined })} /></label>}
        </>
      )}
      <label className="check"><input type="checkbox" checked={!!d.skip} onChange={(ev) => update({ skip: ev.target.checked })} />Skip this node when running</label>
    </div>
  );
}
