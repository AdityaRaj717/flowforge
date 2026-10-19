import type { CharacterSheet, Asset, Job, Queue } from '@flowforge/core';
import { bindNodeRefs, compileWorkflow, jobsFromStoryboard, newJob, newQueue, validateWorkflow } from '@flowforge/core';
import { getAll } from '../shared/db';
import { license } from './entitlement';
import { control } from './engine';
import { getStoryboard, getWorkflow, jobsOf, log, saveJobs, saveQueue, state } from './store';

async function queueFor(name: string, queueId?: string, mode: Job['mode'] = 'text-to-video'): Promise<Queue> {
  if (queueId && state.queues.get(queueId)) return state.queues.get(queueId)!;
  const existing = [...state.queues.values()].find((q) => q.name === name);
  return existing ?? saveQueue(newQueue(name, mode));
}

/** Compiles a workflow graph into jobs and starts them. `fromNodeId` reruns that node and everything after it. */
export async function runWorkflow(workflowId: string, fromNodeId?: string, queueId?: string) {
  const wf = await getWorkflow(workflowId);
  if (!wf) throw new Error('Workflow not found.');
  const lic = await license();
  if (lic.limits.workflowNodes !== null && wf.nodes.length > lic.limits.workflowNodes) {
    throw new Error(`The ${lic.limits.label} plan runs workflows up to ${lic.limits.workflowNodes} nodes (this one has ${wf.nodes.length}).`);
  }
  const assets = await getAll<Asset>('assets');
  const issues = validateWorkflow(wf, { assetIds: new Set(assets.map((a) => a.id)) }).filter((i) => i.level === 'error');
  if (issues.length) throw new Error(`Fix the workflow first: ${issues.map((i) => i.message).join(' ')}`);

  const steps = compileWorkflow(wf, fromNodeId);
  if (!steps.length) throw new Error('Nothing to run.');
  const q = await queueFor(`Workflow: ${wf.name}`, queueId);

  // Outputs of nodes that are not being rerun come from their most recent successful job.
  const previous = new Map<string, string>();
  const prevJobByNode = new Map<string, Job>();
  for (const j of state.jobs.values()) {
    if (j.workflowId !== wf.id || j.state !== 'succeeded' || !j.nodeId) continue;
    const cur = prevJobByNode.get(j.nodeId);
    if (!cur || cur.finishedAt! < j.finishedAt!) prevJobByNode.set(j.nodeId, j);
  }
  prevJobByNode.forEach((j, node) => {
    j.outputs.forEach((_, i) => previous.set(`${node}#${i + 1}`, `job:${j.id}#${i + 1}`));
    previous.set(`${node}#lastframe`, `lastframe:${j.id}`);
  });

  const nodeToJob = new Map<string, string>();
  const start = jobsOf(q.id).reduce((m, j) => Math.max(m, j.index), 0) + 1;
  const jobs: Job[] = [];
  steps.forEach((s, i) => {
    const deps = s.dependsOnNodes.map((n) => nodeToJob.get(n) ?? prevJobByNode.get(n)?.id).filter(Boolean) as string[];
    const missing = s.dependsOnNodes.filter((n) => !nodeToJob.has(n) && !prevJobByNode.has(n));
    if (missing.length) throw new Error(`Run the upstream node(s) first: ${missing.join(', ')}.`);
    const job = newJob(q, {
      prompt: s.prompt,
      mode: s.mode,
      options: s.options,
      references: bindNodeRefs(s.references, nodeToJob, previous),
      dependsOn: deps.length ? deps : undefined,
      name: wf.nodes.find((n) => n.id === s.nodeId)?.data.label ?? s.nodeId,
      workflowId: wf.id,
      nodeId: s.nodeId,
      vars: s.kind === 'merge' ? { op: 'merge' } : undefined,
    }, start + i);
    nodeToJob.set(s.nodeId, job.id);
    jobs.push(job);
  });
  // Last-frame references need the source job's frame extracted: mark it so the engine knows.
  await saveJobs(jobs);
  await log('info', 'workflow', `Workflow "${wf.name}" queued ${jobs.length} step(s)${fromNodeId ? ' from the selected node' : ''}.`, { queueId: q.id });
  await control(q.id, 'start');
  return { queueId: q.id, jobIds: jobs.map((j) => j.id) };
}

export async function runStoryboard(storyboardId: string, queueId?: string) {
  const sb = await getStoryboard(storyboardId);
  if (!sb) throw new Error('Storyboard not found.');
  const lic = await license();
  if (lic.limits.storyboardScenes !== null && sb.scenes.length > lic.limits.storyboardScenes) {
    throw new Error(`The ${lic.limits.label} plan runs storyboards up to ${lic.limits.storyboardScenes} scenes (this one has ${sb.scenes.length}).`);
  }
  const assets = await getAll<Asset>('assets');
  const sheets = new Map<string, CharacterSheet>();
  assets.forEach((a) => a.character && sheets.set(a.id, a.character));
  const q = await queueFor(`Story: ${sb.name}`, queueId);
  const start = jobsOf(q.id).reduce((m, j) => Math.max(m, j.index), 0) + 1;
  const jobs = jobsFromStoryboard(q, sb, sheets, start);
  await saveJobs(jobs);
  await log('info', 'storyboard', `Storyboard "${sb.name}" queued ${jobs.length} scene(s).`, { queueId: q.id });
  await control(q.id, 'start');
  return { queueId: q.id, jobIds: jobs.map((j) => j.id) };
}
