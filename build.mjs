/**
 * Builds `client.js` from `src/client.jsx`.
 *
 * The browser half is one CommonJS bundle wrapped in the DSH Client module
 * loader's factory form. `react` stays external and resolves from the page's
 * shared module table; everything else (including @strudel/web) is inlined.
 *
 * Usage: node build.mjs
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const outDir = join(root, '.build');
const bodyPath = join(outDir, 'client.body.cjs');

const platform = process.platform;
const arch = process.arch;
const binary = join(
  root,
  'node_modules',
  '@esbuild',
  `${platform}-${arch}`,
  platform === 'win32' ? 'esbuild.exe' : 'esbuild',
);

const args = [
  'src/client.jsx',
  '--bundle',
  '--format=cjs',
  '--platform=browser',
  '--target=es2020',
  '--minify',
  '--external:react',
  '--jsx=transform',
  '--jsx-factory=React.createElement',
  '--jsx-fragment=React.Fragment',
  '--legal-comments=inline',
  '--log-level=warning',
  `--outfile=${bodyPath}`,
];

await mkdir(outDir, { recursive: true });

await new Promise((resolve, reject) => {
  const child = spawn(binary, args, { cwd: root, stdio: 'inherit' });
  child.on('error', (error) => {
    reject(
      new Error(
        `Could not run esbuild at ${binary}. Install the dev dependencies first: npm install --ignore-scripts\n${error.message}`,
      ),
    );
  });
  child.on('exit', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`esbuild exited with code ${code}`));
  });
});

const body = await readFile(bodyPath, 'utf8');
const banner = `/*! Strudel Player for DeepSeek Harness. Bundles @strudel/web (AGPL-3.0-or-later), https://strudel.cc. */\n`;
const client = `${banner}window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
${body}
    return module.exports;
  },
});
`;

await writeFile(join(root, 'client.js'), client, 'utf8');
const bytes = Buffer.byteLength(client);
console.log(`client.js written (${(bytes / 1024).toFixed(0)} KiB)`);
