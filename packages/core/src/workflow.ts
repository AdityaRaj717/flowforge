import type { GenerationMode, Job, JobOptions, ReferenceRef, ReferenceRole } from './types';
import { MODE_OUTPUT } from './types';

// A workflow is a DAG. Generator nodes compile to jobs; edges become job dependencies and
// references such as `lastframe:<jobId>`. The queue engine then runs them like any other job,
// which is why a workflow gets the same retries, logs and downloads as a CSV import.

export type PortType = 'text' | 'image' | 'video';

export type NodeKind = 'prompt' | 'asset' | 'image' | 'video' | 'lastFrame' | 'pick' | 'merge' | 'note';

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  position: { x: number; y: number };
  data: {
    label?: string;
    text?: string; // prompt / note
    assetId?: string; // asset
    mode?: GenerationMode; // image / video
    options?: JobOptions;
    pickIndex?: number; // pick: 1-based output
    skip?: boolean;
  };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle: string; // input port name
}

export interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: number;
  updatedAt: number;
}

export interface PortSpec {
  name: string;
  type: PortType;
  multiple?: boolean;
  required?: boolean;
  role?: ReferenceRole;
}

export const NODE_SPECS: Record<NodeKind, { inputs: PortSpec[]; output?: PortType; label: string }> = {
  prompt: { label: 'Prompt', inputs: [{ name: 'text', type: 'text', multiple: true }], output: 'text' },
  asset: { label: 'Library asset', inputs: [], output: 'image' },
  image: {
    label: 'Generate image',
    inputs: [
      { name: 'prompt', type: 'text', multiple: true, required: true },
      { name: 'source', type: 'image', role: 'source' },
      { name: 'refs', type: 'image', multiple: true, role: 'ingredient' },
      { name: 'style', type: 'image', role: 'style' },
    ],
    output: 'image',
  },
  video: {
    label: 'Generate video',
    inputs: [
      { name: 'prompt', type: 'text', multiple: true, required: true },
      { name: 'start', type: 'image', role: 'start' },
      { name: 'end', type: 'image', role: 'end' },
      { name: 'ingredients', type: 'image', multiple: true, role: 'ingredient' },
      { name: 'extend', type: 'video', role: 'source' },
    ],
    output: 'video',
  },
  lastFrame: { label: 'Last frame', inputs: [{ name: 'video', type: 'video', required: true }], output: 'image' },
  pick: { label: 'Pick output', inputs: [{ name: 'in', type: 'image', required: true }], output: 'image' },
  merge: { label: 'Merge clips (agent)', inputs: [{ name: 'clips', type: 'video', multiple: true, required: true }], output: 'video' },
  note: { label: 'Note', inputs: [] },
};

export interface Issue {
  nodeId?: string;
  edgeId?: string;
  level: 'error' | 'warning';
  message: string;
}

function outType(n: WorkflowNode): PortType | undefined {
  if (n.kind === 'pick') return 'image';
  return NODE_SPECS[n.kind].output;
}

export function topoSort(wf: Workflow): { order: string[]; cycle: string[] } {
  const indeg = new Map(wf.nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>(wf.nodes.map((n) => [n.id, []]));
  for (const e of wf.edges) {
    if (!indeg.has(e.source) || !indeg.has(e.target)) continue;
    adj.get(e.source)!.push(e.target);
    indeg.set(e.target, indeg.get(e.target)! + 1);
  }
  const q = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (q.length) {
    const id = q.shift()!;
    order.push(id);
    for (const t of adj.get(id)!) {
      indeg.set(t, indeg.get(t)! - 1);
      if (indeg.get(t) === 0) q.push(t);
    }
  }
  const cycle = wf.nodes.map((n) => n.id).filter((id) => !order.includes(id));
  return { order, cycle };
}

export function validateWorkflow(wf: Workflow, opts: { agentConnected?: boolean; assetIds?: Set<string> } = {}): Issue[] {
  const issues: Issue[] = [];
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const { cycle } = topoSort(wf);
  if (cycle.length) issues.push({ level: 'error', message: `Loop detected through ${cycle.length} node(s). Workflows must not loop.`, nodeId: cycle[0] });

  for (const e of wf.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) {
      issues.push({ level: 'error', edgeId: e.id, message: 'Connection points to a deleted node.' });
      continue;
    }
    const port = NODE_SPECS[t.kind].inputs.find((p) => p.name === e.targetHandle);
    if (!port) {
      issues.push({ level: 'error', edgeId: e.id, nodeId: t.id, message: `${NODE_SPECS[t.kind].label} has no input "${e.targetHandle}".` });
      continue;
    }
    const st = outType(s);
    if (st !== port.type) issues.push({ level: 'error', edgeId: e.id, nodeId: t.id, message: `Cannot plug ${st ?? 'nothing'} into ${port.type} input "${port.name}".` });
    if (!port.multiple && wf.edges.filter((x) => x.target === t.id && x.targetHandle === port.name).length > 1) {
      issues.push({ level: 'error', nodeId: t.id, message: `Input "${port.name}" takes one connection.` });
    }
  }

  for (const n of wf.nodes) {
    const spec = NODE_SPECS[n.kind];
    for (const p of spec.inputs) {
      const connected = wf.edges.some((e) => e.target === n.id && e.targetHandle === p.name);
      if (p.required && !connected) issues.push({ level: 'error', nodeId: n.id, message: `${spec.label}: connect "${p.name}".` });
    }
    if (n.kind === 'prompt' && !n.data.text?.trim() && !wf.edges.some((e) => e.target === n.id)) {
      issues.push({ level: 'error', nodeId: n.id, message: 'Prompt is empty.' });
    }
    if (n.kind === 'asset') {
      if (!n.data.assetId) issues.push({ level: 'error', nodeId: n.id, message: 'Pick an asset from the library.' });
      else if (opts.assetIds && !opts.assetIds.has(n.data.assetId)) issues.push({ level: 'error', nodeId: n.id, message: 'Asset was deleted from the library.' });
    }
    if (n.kind === 'video') {
      const has = (h: string) => wf.edges.some((e) => e.target === n.id && e.targetHandle === h);
      const mode = videoModeFor(n, has);
      if (mode === 'frames-to-video' && has('ingredients')) issues.push({ level: 'warning', nodeId: n.id, message: 'Start/end frames and ingredients together: Flow uses one or the other. Ingredients will be ignored.' });
      if (has('end') && !has('start')) issues.push({ level: 'error', nodeId: n.id, message: 'An end frame needs a start frame.' });
    }
    if (n.kind === 'merge' && !opts.agentConnected) {
      issues.push({ level: 'warning', nodeId: n.id, message: 'Merging clips runs in the local agent (FFmpeg). Start it, or the merge step will wait.' });
    }
  }
  if (!wf.nodes.some((n) => n.kind === 'image' || n.kind === 'video')) issues.push({ level: 'warning', message: 'No generator nodes yet.' });
  return issues;
}

function videoModeFor(n: WorkflowNode, has: (h: string) => boolean): GenerationMode {
  if (n.data.mode) return n.data.mode;
  if (has('extend')) return 'extend-video';
  if (has('start')) return 'frames-to-video';
  if (has('ingredients')) return 'ingredients-to-video';
  return 'text-to-video';
}

export interface CompiledNode {
  nodeId: string;
  kind: 'generate' | 'merge';
  prompt: string;
  mode: GenerationMode;
  options: JobOptions;
  references: ReferenceRef[];
  /** Node ids of generator nodes this one waits for. */
  dependsOnNodes: string[];
}

/**
 * Turns the graph into an ordered list of generation steps. References to upstream generator
 * outputs are written as `node:<nodeId>#<n>` / `lastframe-node:<nodeId>`; the engine rewrites them
 * to job ids once jobs exist (see bindNodeRefs).
 */
export function compileWorkflow(wf: Workflow, onlyFrom?: string): CompiledNode[] {
  const { order, cycle } = topoSort(wf);
  if (cycle.length) throw new Error('Workflow has a loop.');
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const inputs = (id: string, handle: string) =>
    wf.edges.filter((e) => e.target === id && e.targetHandle === handle).map((e) => byId.get(e.source)!).filter(Boolean);

  const textOf = (n: WorkflowNode, seen = new Set<string>()): string => {
    if (seen.has(n.id)) return '';
    seen.add(n.id);
    const upstream = inputs(n.id, 'text').map((u) => textOf(u, seen)).filter(Boolean);
    return [...upstream, n.data.text ?? ''].map((s) => s.trim()).filter(Boolean).join(' ');
  };

  // Resolve an image/video producing node to a reference id + the generator it depends on.
  const refOf = (n: WorkflowNode, pick = 1): { assetId: string; dep?: string } | undefined => {
    if (n.kind === 'asset' && n.data.assetId) return { assetId: n.data.assetId };
    if (n.kind === 'image' || n.kind === 'video') return { assetId: `node:${n.id}#${pick}`, dep: n.id };
    if (n.kind === 'pick') {
      const src = inputs(n.id, 'in')[0];
      return src ? refOf(src, n.data.pickIndex ?? 1) : undefined;
    }
    if (n.kind === 'lastFrame') {
      const src = inputs(n.id, 'video')[0];
      if (!src) return undefined;
      const r = refOf(src);
      return r?.dep ? { assetId: `lastframe-node:${r.dep}`, dep: r.dep } : undefined;
    }
    return undefined;
  };

  let allowed: Set<string> | undefined;
  if (onlyFrom) allowed = descendants(wf, onlyFrom);

  const steps: CompiledNode[] = [];
  for (const id of order) {
    const n = byId.get(id)!;
    if (n.data.skip) continue;
    if (allowed && !allowed.has(id)) continue;
    if (n.kind === 'merge') {
      const clips = inputs(id, 'clips').map((c) => refOf(c)).filter(Boolean) as { assetId: string; dep?: string }[];
      steps.push({
        nodeId: id, kind: 'merge', prompt: n.data.label ?? 'merge', mode: 'extend-video', options: n.data.options ?? {},
        references: clips.map((c) => ({ role: 'source', assetId: c.assetId })),
        dependsOnNodes: clips.map((c) => c.dep).filter(Boolean) as string[],
      });
      continue;
    }
    if (n.kind !== 'image' && n.kind !== 'video') continue;
    const prompt = inputs(id, 'prompt').map((p) => textOf(p)).filter(Boolean).join(' ');
    const refs: ReferenceRef[] = [];
    const deps = new Set<string>();
    for (const port of NODE_SPECS[n.kind].inputs) {
      if (port.type === 'text' || !port.role) continue;
      for (const src of inputs(id, port.name)) {
        const r = refOf(src);
        if (!r) continue;
        refs.push({ role: port.role, assetId: r.assetId });
        if (r.dep) deps.add(r.dep);
      }
    }
    const has = (h: string) => wf.edges.some((e) => e.target === id && e.targetHandle === h);
    const mode: GenerationMode =
      n.kind === 'image' ? (n.data.mode ?? (has('source') ? 'image-to-image' : 'text-to-image')) : videoModeFor(n, has);
    steps.push({ nodeId: id, kind: 'generate', prompt, mode, options: { ...(n.data.options ?? {}) }, references: refs, dependsOnNodes: [...deps] });
  }
  return steps;
}

export function descendants(wf: Workflow, start: string): Set<string> {
  const out = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of wf.edges) if (e.source === id && !out.has(e.target)) {
      out.add(e.target);
      stack.push(e.target);
    }
  }
  return out;
}

/** Rewrites node-relative references to job-relative ones once the jobs are created. */
export function bindNodeRefs(refs: ReferenceRef[], nodeToJob: Map<string, string>, previousOutputs?: Map<string, string>): ReferenceRef[] {
  return refs.map((r) => {
    let m = /^node:([^#]+)#(\d+)$/.exec(r.assetId);
    if (m) {
      const job = nodeToJob.get(m[1]);
      if (job) return { ...r, assetId: `job:${job}#${m[2]}` };
      const prev = previousOutputs?.get(`${m[1]}#${m[2]}`);
      if (prev) return { ...r, assetId: prev };
    }
    m = /^lastframe-node:(.+)$/.exec(r.assetId);
    if (m) {
      const job = nodeToJob.get(m[1]);
      if (job) return { ...r, assetId: `lastframe:${job}` };
      const prev = previousOutputs?.get(`${m[1]}#lastframe`);
      if (prev) return { ...r, assetId: prev };
    }
    return r;
  });
}

/** Builds a starter graph from queue rows: prompt -> generator, chaining videos by last frame when asked. */
export function workflowFromJobs(jobs: Pick<Job, 'id' | 'prompt' | 'mode' | 'options' | 'dependsOn'>[], name: string, chainVideos = false): Workflow {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  let prevVideo: string | undefined;
  jobs.forEach((j, i) => {
    const pid = `p${i}`;
    const gid = `g${i}`;
    const kind = MODE_OUTPUT[j.mode] === 'image' ? 'image' : 'video';
    nodes.push({ id: pid, kind: 'prompt', position: { x: 0, y: i * 170 }, data: { text: j.prompt } });
    nodes.push({ id: gid, kind, position: { x: 340, y: i * 170 }, data: { mode: j.mode, options: j.options, label: `Row ${i + 1}` } });
    edges.push({ id: `e${pid}`, source: pid, target: gid, targetHandle: 'prompt' });
    if (kind === 'video' && chainVideos && prevVideo) {
      const lf = `lf${i}`;
      nodes.push({ id: lf, kind: 'lastFrame', position: { x: 170, y: i * 170 - 70 }, data: {} });
      edges.push({ id: `e${lf}a`, source: prevVideo, target: lf, targetHandle: 'video' });
      edges.push({ id: `e${lf}b`, source: lf, target: gid, targetHandle: 'start' });
    }
    if (kind === 'video') prevVideo = gid;
  });
  const now = Date.now();
  return { id: `wf_${now.toString(36)}`, name, nodes, edges, createdAt: now, updatedAt: now };
}
