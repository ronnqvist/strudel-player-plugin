/**
 * Runs the synth-rack evaluation check.
 *
 * `test/rack-eval.mjs` imports the Strudel packages, and Node's ESM resolver
 * cannot link them the way the browser bundle does, so it is bundled first
 * with esbuild (the same binary `build.mjs` uses) and then executed.
 *
 * Usage: node test/run-rack.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.build');
const bundle = join(outDir, 'rack-eval.run.mjs');

const executable = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
const esbuild = join(root, 'node_modules', '@esbuild', `${process.platform}-${process.arch}`, executable);
if (!existsSync(esbuild)) {
  throw new Error(`esbuild was not found at ${esbuild}; run npm install --ignore-scripts first`);
}

await mkdir(outDir, { recursive: true });

const runSync = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });

await runSync(esbuild, [
  'test/rack-eval.mjs',
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node20',
  `--outfile=${bundle}`,
  '--log-level=warning',
]);

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [bundle], { cwd: root, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`rack check failed with ${code}`))));
});
