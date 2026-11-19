#!/usr/bin/env node
/**
 * Development server on TypeScript 7 (replaces `ng serve` / `ng build --watch`).
 *
 * Builds with the angular.json `development` configuration (scripts/build-ts7.mjs: ngp +
 * TypeScript 7 + esbuild), serves the result, rebuilds when src/ changes and reloads open
 * pages. A failed rebuild is reported and the last good build stays served.
 *
 * Usage: node scripts/serve-ts7.mjs [--port 4200] [--host localhost] [--configuration development]
 *        node scripts/serve-ts7.mjs --no-server        rebuild dist/axe-os on change (`watch`)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {buildAxeos} from './build-ts7.mjs';
import {BuildError, root} from './ts7-common.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const serve = !args.includes('--no-server');
const configuration = value('--configuration', 'development');
const port = Number(value('--port', 4200));
const host = value('--host', 'localhost');
const outDir = serve ? path.join(root, '.ts7-serve/dist') : path.join(root, 'dist/axe-os');
const workDir = path.join(root, '.ts7-serve/work');

const reloadClients = new Set();
let building = false;
let pending = false;
let lastGood = false;

async function rebuild(reason) {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  const started = Date.now();
  console.log(`\n[ts7] build (${reason})`);
  try {
    await buildAxeos({configuration, outDir, workDir});
    lastGood = true;
    console.log(`[ts7] ready in ${((Date.now() - started) / 1000).toFixed(1)} s${serve ? ` - http://${host}:${port}/` : ''}`);
    for (const client of reloadClients) client.write('data: reload\n\n');
  } catch (error) {
    if (!(error instanceof BuildError)) console.error(error);
    else console.error(`\n[ts7] build failed: ${error.message}`);
    console.error(lastGood ? '[ts7] still serving the last successful build' : '[ts7] waiting for a fix');
  } finally {
    building = false;
    if (pending) {
      pending = false;
      rebuild('changes during the build');
    }
  }
}

// Rebuild on source changes (debounced: editors write files in bursts).
let timer;
fs.watch(path.join(root, 'src'), {recursive: true}, (_event, file) => {
  if (!file || /(^|[\\/])\.|~$/.test(file)) return;
  clearTimeout(timer);
  timer = setTimeout(() => rebuild(`changed: src/${file}`), 200);
});
for (const name of ['angular.json', 'tsconfig.json', 'tsconfig.app.json']) {
  fs.watch(path.join(root, name), () => {
    clearTimeout(timer);
    timer = setTimeout(() => rebuild(`changed: ${name}`), 200);
  });
}

if (serve) {
  const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.map': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.svg': 'image/svg+xml'};
  const reloadScript = `<script>new EventSource('/__ts7_reload').onmessage = () => location.reload();</script>`;
  http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (url === '/__ts7_reload') {
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'});
      res.write(': connected\n\n');
      reloadClients.add(res);
      req.on('close', () => reloadClients.delete(res));
      return;
    }
    let file = path.join(outDir, url);
    // Unknown paths fall back to index.html (client-side routing), as `ng serve` does.
    if (!file.startsWith(outDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(outDir, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(503, {'content-type': 'text/plain'}).end('AxeOS is building...');
      return;
    }
    res.writeHead(200, {'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store'});
    if (file.endsWith('index.html')) res.end(fs.readFileSync(file, 'utf8').replace('</body>', `${reloadScript}</body>`));
    else fs.createReadStream(file).pipe(res);
  }).listen(port, host, () => console.log(`[ts7] development server on http://${host}:${port}/ (${configuration})`));
}

await rebuild('start');
