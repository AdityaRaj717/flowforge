// Zips the release build of the extension for the Chrome Web Store.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'packages/extension/dist');
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (JSON.stringify(manifest).includes('localhost')) throw new Error('dist is a dev build (localhost permissions). Run npm run build first.');
const outDir = join(root, 'packages/extension/release');
mkdirSync(outDir, { recursive: true });
const zip = join(outDir, `flowforge-${manifest.version}.zip`);
rmSync(zip, { force: true });
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${dist}\*' -DestinationPath '${zip}'`], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-r', '-q', zip, '.'], { cwd: dist, stdio: 'inherit' });
}
console.log(`packaged ${zip}`);
