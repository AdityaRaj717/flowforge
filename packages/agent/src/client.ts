import { loadConfig } from './config';

// Thin REST client for the running agent; used by the CLI and the MCP server.

export async function api<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const cfg = loadConfig();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`FlowForge agent is not running on port ${cfg.port}. Start it with: flowforge-agent serve`);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? `HTTP ${res.status}`);
  return data as T;
}
