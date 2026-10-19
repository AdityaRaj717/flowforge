// Serves the mock Flow page on http://localhost:5179 (the dev build of the extension runs there).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 5179);

export function startMock() {
  const server = createServer(async (req, res) => {
    if (req.url !== '/' && !req.url?.startsWith('/?') && !req.url?.startsWith('/project')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await readFile(join(dir, req.url.startsWith('/project/agent') ? 'agent.html' : 'index.html')));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await startMock();
  console.log(`mock Flow on http://localhost:${port}/`);
}
