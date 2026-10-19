import { useMemo, useState } from 'react';
import type { ColumnMapping, Field, ImportResult, Queue, TxtSplit } from '@flowforge/core';
import { countExpansions, guessMapping, jobsFromRows, looksLikeHeader, parseCsv, resolveReferences, rowsFromJson, rowsFromTable, rowsFromTxt, findMentions } from '@flowforge/core';
import { call, useAssets, type PanelState } from '../api';
import { useAction } from '../components/ui';

const FIELDS: [Field, string][] = [
  ['prompt', 'Prompt'], ['name', 'Name'], ['mode', 'Mode'], ['model', 'Model'], ['aspect', 'Aspect'], ['outputs', 'Outputs'],
  ['duration', 'Duration'], ['start', 'Start frame'], ['end', 'End frame'], ['ingredients', 'Ingredients'], ['character', 'Characters'],
  ['style', 'Style ref'], ['source', 'Source image'], ['negative', 'Negative'], ['folder', 'Folder'], ['filename', 'Filename'], ['tags', 'Tags'],
  ['var', 'Variable'], ['ignore', 'Ignore'],
];

type Source = { kind: 'table'; table: string[][]; name: string } | { kind: 'txt'; text: string; name: string } | { kind: 'json'; text: string; name: string };

interface Props {
  ps: PanelState | null;
  queues: Queue[];
  queueId?: string;
  onDone: (queueId: string) => void;
}

export function ImportView({ ps, queues, queueId, onDone }: Props) {
  const act = useAction();
  const [assets] = useAssets();
  const [src, setSrc] = useState<Source | null>(null);
  const [split, setSplit] = useState<TxtSplit>('auto');
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [header, setHeader] = useState(true);
  const [skipDups, setSkipDups] = useState(true);
  const [autoMentions, setAutoMentions] = useState(true);
  const [target, setTarget] = useState<string>(queueId ?? '__new');
  const [over, setOver] = useState(false);
  const [paste, setPaste] = useState('');

  const loadFile = async (f: File) => {
    const name = f.name.toLowerCase();
    if (/\.(xlsx|xls|ods)$/.test(name)) {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const table = (XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }) as unknown[][]).map((r) => r.map((c) => String(c ?? '')));
      setTable(table, f.name);
    } else if (/\.(csv|tsv)$/.test(name)) setTable(parseCsv(await f.text(), name.endsWith('.tsv') ? '\t' : undefined), f.name);
    else if (name.endsWith('.json')) setSrc({ kind: 'json', text: await f.text(), name: f.name });
    else setSrc({ kind: 'txt', text: await f.text(), name: f.name });
  };

  const setTable = (table: string[][], name: string) => {
    const h = table.length > 0 && looksLikeHeader(table[0]);
    setHeader(h);
    setMapping(h ? guessMapping(table[0]) : { 0: { field: 'prompt' } });
    setSrc({ kind: 'table', table, name });
  };

  const result: ImportResult | null = useMemo(() => {
    if (!src) return null;
    if (src.kind === 'txt') return rowsFromTxt(src.text, split);
    if (src.kind === 'json') return rowsFromJson(src.text);
    return rowsFromTable(src.table, mapping ?? undefined, header);
  }, [src, split, mapping, header]);

  const index = useMemo(() => assets.map((a) => ({ id: a.id, name: a.name, aliases: a.aliases })), [assets]);
  const resolved = useMemo(() => {
    if (!result) return null;
    const dupLines = new Set(result.duplicates.map((d) => d.line));
    const missing = new Set<string>();
    let expanded = 0;
    const rows = result.rows
      .filter((r) => !(skipDups && dupLines.has(r.line)))
      .map((r) => {
        const { refs, missing: miss } = resolveReferences(r.referenceNames, index);
        miss.forEach((m) => missing.add(m));
        if (autoMentions) {
          for (const m of findMentions(r.prompt, index)) {
            if (!refs.some((x) => x.assetId === m.assetId)) refs.push({ role: 'ingredient', assetId: m.assetId });
          }
        }
        expanded += countExpansions(r.prompt);
        return { ...r, mode: r.mode ?? (refs.length ? 'ingredients-to-video' as const : undefined), references: refs };
      });
    return { rows, missing: [...missing], expanded, dupLines };
  }, [result, index, skipDups, autoMentions]);

  const commit = () =>
    act(async () => {
      if (!resolved?.rows.length) throw new Error('Nothing to import.');
      let q = queues.find((x) => x.id === target);
      if (!q) q = await call<Queue>({ t: 'createQueue', name: src?.name.replace(/\.[^.]+$/, '') || 'Imported' });
      const existing = await import('../../shared/db').then((db) => db.getAllByIndex<{ index: number }>('jobs', 'queueId', q!.id));
      const start = existing.reduce((m, j) => Math.max(m, j.index), 0) + 1;
      const { jobs, truncated } = jobsFromRows(q, resolved.rows, start, ps?.license.limits.promptExpansions ?? 20);
      await call({ t: 'addJobs', queueId: q.id, jobs });
      setSrc(null);
      setPaste('');
      onDone(q.id);
      return truncated;
    }, 'Imported');

  const tableCols = src?.kind === 'table' ? Math.max(0, ...src.table.slice(0, 50).map((r) => r.length)) : 0;

  return (
    <div className="stack">
      {!src && (
        <>
          <label
            className={`drop ${over ? 'over' : ''}`}
            onDragOver={(e) => (e.preventDefault(), setOver(true))}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files[0];
              if (f) void act(() => loadFile(f));
            }}
          >
            <input type="file" hidden accept=".txt,.csv,.tsv,.xlsx,.xls,.ods,.json,.md" onChange={(e) => e.target.files?.[0] && act(() => loadFile(e.target.files![0]))} />
            <div style={{ fontSize: 14, color: 'var(--text)' }}>Drop a file or click to choose</div>
            <div className="small">TXT · CSV · TSV · XLSX · JSON</div>
          </label>
          <div className="card tight stack">
            <h3>Or paste</h3>
            <textarea rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste prompts, or a table copied from Google Sheets / Excel (tab separated)." />
            <div className="row">
              <button className="btn sm right" disabled={!paste.trim()} onClick={() => (paste.includes('\t') ? setTable(parseCsv(paste, '\t'), 'Pasted table') : setSrc({ kind: 'txt', text: paste, name: 'Pasted' }))}>Preview</button>
            </div>
          </div>
          <div className="card tight small muted stack">
            <h3>Columns FlowForge understands</h3>
            <div>prompt · name · mode (t2i, t2v, i2v, ingredients…) · model · aspect (16:9, portrait…) · outputs (1-4) · duration · start / end frame · ingredients · characters · style · negative · folder · filename · tags</div>
            <div>Any other column becomes a variable you can use as {'{{column}}'} in prompts and {'{var.column}'} in file names. Image columns match file names or aliases in your Library.</div>
          </div>
        </>
      )}

      {src && result && resolved && (
        <>
          <div className="row">
            <b className="grow">{src.name}</b>
            <button className="btn sm ghost" onClick={() => setSrc(null)}>Choose another</button>
          </div>

          {src.kind === 'txt' && (
            <label className="field">
              <span>Split prompts by</span>
              <select value={split} onChange={(e) => setSplit(e.target.value as TxtSplit)}>
                <option value="auto">Auto-detect</option>
                <option value="line">Each line</option>
                <option value="blank-line">Blank lines (multi-line prompts)</option>
                <option value="delimiter">--- or @@@NEXT@@@ lines</option>
              </select>
            </label>
          )}
          {src.kind === 'table' && (
            <label className="check small">
              <input type="checkbox" checked={header} onChange={(e) => {
                setHeader(e.target.checked);
                setMapping(e.target.checked ? guessMapping(src.table[0]) : { 0: { field: 'prompt' } });
              }} />
              First row is a header
            </label>
          )}

          {result.warnings.length > 0 && <div className="note">{result.warnings.slice(0, 6).map((w, i) => <div key={i}>{w}</div>)}{result.warnings.length > 6 && <div>…and {result.warnings.length - 6} more</div>}</div>}
          {resolved.missing.length > 0 && <div className="note bad">Not in your Library: {resolved.missing.slice(0, 8).join(', ')}{resolved.missing.length > 8 ? '…' : ''}. Add them in Library (names must match) or those references will be skipped.</div>}

          <div className="table-wrap">
            <table>
              <thead>
                {src.kind === 'table' ? (
                  <tr>
                    <th>#</th>
                    {Array.from({ length: tableCols }, (_, c) => (
                      <th key={c}>
                        <select value={mapping?.[c]?.field ?? 'ignore'} onChange={(e) => setMapping({ ...(mapping ?? {}), [c]: { field: e.target.value as Field, varName: header ? src.table[0][c]?.trim().toLowerCase().replace(/\s+/g, '_') : `col${c + 1}` } })}>
                          {FIELDS.map(([f, l]) => <option key={f} value={f}>{l}</option>)}
                        </select>
                        {header && <div className="faint" style={{ fontWeight: 400 }}>{src.table[0][c]}</div>}
                      </th>
                    ))}
                  </tr>
                ) : (
                  <tr><th>Line</th><th>Prompt</th><th>Settings</th></tr>
                )}
              </thead>
              <tbody>
                {src.kind === 'table'
                  ? src.table.slice(header ? 1 : 0, 60).map((r, i) => {
                      const line = i + (header ? 2 : 1);
                      return (
                        <tr key={i}>
                          <td className={resolved.dupLines.has(line) ? 'dup' : 'faint'}>{line}{resolved.dupLines.has(line) ? ' dup' : ''}</td>
                          {Array.from({ length: tableCols }, (_, c) => <td key={c} style={{ opacity: mapping?.[c]?.field === 'ignore' ? 0.4 : 1 }}>{(r[c] ?? '').slice(0, 140)}</td>)}
                        </tr>
                      );
                    })
                  : result.rows.slice(0, 60).map((r) => (
                      <tr key={r.line}>
                        <td className={resolved.dupLines.has(r.line) ? 'dup' : 'faint'}>{r.line}{resolved.dupLines.has(r.line) ? ' dup' : ''}</td>
                        <td style={{ whiteSpace: 'pre-wrap' }}>{r.prompt.slice(0, 300)}</td>
                        <td className="faint">{[r.mode, r.options.aspect, r.options.outputs && `×${r.options.outputs}`, r.referenceNames.length && `${r.referenceNames.length} ref`].filter(Boolean).join(' · ')}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>

          <div className="stack small">
            <label className="check"><input type="checkbox" checked={skipDups} onChange={(e) => setSkipDups(e.target.checked)} />Skip {result.duplicates.length} duplicate row(s)</label>
            <label className="check"><input type="checkbox" checked={autoMentions} onChange={(e) => setAutoMentions(e.target.checked)} />Attach Library assets named with @mentions in prompts (e.g. @mira)</label>
          </div>

          <div className="row">
            <select value={target} onChange={(e) => setTarget(e.target.value)} className="grow" aria-label="Target queue">
              <option value="__new">New queue “{src.name.replace(/\.[^.]+$/, '')}”</option>
              {queues.map((q) => <option key={q.id} value={q.id}>Add to “{q.name}”</option>)}
            </select>
            <button className="btn primary" onClick={commit} disabled={!resolved.rows.length}>
              Add {resolved.expanded} job{resolved.expanded === 1 ? '' : 's'}
            </button>
          </div>
          {resolved.expanded > resolved.rows.length && <div className="small faint">{resolved.rows.length} rows expand to {resolved.expanded} jobs because of {'{a|b}'} variations.</div>}
        </>
      )}
    </div>
  );
}
