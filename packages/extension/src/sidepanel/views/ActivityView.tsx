import { useMemo, useState } from 'react';
import { call, downloadJson, downloadText, useLogs } from '../api';
import { useAction } from '../components/ui';

export function ActivityView() {
  const [logs] = useLogs();
  const act = useAction();
  const [level, setLevel] = useState<'all' | 'warn' | 'error'>('all');
  const [q, setQ] = useState('');
  const shown = useMemo(
    () => logs.filter((l) => (level === 'all' || (level === 'warn' ? l.level !== 'info' && l.level !== 'debug' : l.level === 'error')) && (!q || `${l.scope} ${l.message}`.toLowerCase().includes(q.toLowerCase()))),
    [logs, level, q],
  );
  return (
    <div className="stack">
      <div className="row tight">
        {(['all', 'warn', 'error'] as const).map((l) => <button key={l} className={`btn sm ${level === l ? '' : 'ghost'}`} onClick={() => setLevel(l)}>{l === 'all' ? 'All' : l === 'warn' ? 'Warnings' : 'Errors'}</button>)}
        <input className="grow" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="row tight">
        <button className="btn sm" onClick={() => downloadText('flowforge-log.txt', shown.slice().reverse().map((l) => `${new Date(l.at).toISOString()} ${l.level.toUpperCase()} [${l.scope}] ${l.message}`).join('\n'))}>Save log</button>
        <button className="btn sm" title="Settings, versions, job states and logs. Prompts, tokens and emails are left out." onClick={() => act(async () => downloadJson(`flowforge-diagnostics-${Date.now()}.json`, await call({ t: 'exportDiagnostics' })))}>Export diagnostics</button>
        <span className="small faint right">{shown.length} events</span>
      </div>
      <div>
        {shown.map((l) => (
          <div key={l.id} className="log">
            <span className="faint">{new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <span className={`lv-${l.level}`}>{l.scope}</span>
            <span style={{ wordBreak: 'break-word' }}>{l.message}</span>
          </div>
        ))}
        {!shown.length && <div className="empty">No activity yet.</div>}
      </div>
    </div>
  );
}
