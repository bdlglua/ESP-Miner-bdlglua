#!/usr/bin/env node
/**
 * AxeOS build on TypeScript 7 (no TypeScript 6, no Angular CLI).
 *
 *   1. ngp, Angular's Rust/oxc template preprocessor (22.3.0 + local patches
 *      for Sass component styles, itself compiled with TypeScript 7, see
 *      tools/ngp/README.md): AOT-compiles components, compiles their SCSS and emits
 *      template type-check blocks (*.ngtypecheck.ts). Its diagnostics stop the build.
 *   2. TypeScript 7 type-checks the compiled application, templates included.
 *      Any error stops the build.
 *   3. esbuild bundles it; the Angular linker (Babel) finishes partially
 *      compiled libraries, as @angular/build does.
 *   4. Global styles, index.html, assets, third-party licenses and budgets.
 *
 * The angular.json build configuration drives the options, as with `ng build`:
 * optimization, sourceMap, outputHashing, namedChunks, extractLicenses, budgets,
 * fileReplacements.
 *
 * Usage: node scripts/build-ts7.mjs [--configuration <name>] [--output-path <dir>] [--stats-json]
 * Output: dist/axe-os (same layout as `ng build`).
 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  architect, BuildError, prepareWorkspace, rel, require, root, runMain, runNgp, step, typecheckTs7, walk,
} from './ts7-common.mjs';

const esbuild = require('esbuild');
const sass = require('sass');
const babel = await import(pathToFileURL(require.resolve('@babel/core')).href);
// Only the linker entry point: the package root would load a TypeScript compiler API.
const {createEs2015LinkerPlugin} = await import(
  pathToFileURL(require.resolve('@angular/compiler-cli/linker/babel')).href
);

/** `2kb` -> 2048 bytes, like Angular budgets. */
function budgetBytes(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(value).trim());
  if (!match) throw new BuildError(`Invalid budget size "${value}"`);
  return Number(match[1]) * {b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3}[(match[2] ?? 'b').toLowerCase()];
}

/**
 * Bytes of each compiled component's stylesheet, measured like the Angular CLI's
 * `anyComponentStyle` budget: the processed CSS before view encapsulation. That is the
 * `styles` of the decorator metadata (ɵsetClassMetadata); the encapsulated `styles` of
 * ɵɵdefineComponent, stripped of its attribute selectors, is the fallback.
 */
function componentStyleSizes(files) {
  const bytesOf = (array) => array?.type !== 'ArrayExpression' ? null
    : array.elements.filter((e) => e?.type === 'StringLiteral').reduce((n, e) => n + Buffer.byteLength(e.value), 0);
  const prop = (object, key) => object?.properties?.find((p) => (p.key?.name ?? p.key?.value) === key)?.value;
  const calleeName = (call) => (call.callee.type === 'MemberExpression' ? call.callee.property.name : call.callee.name);
  const sizes = [];
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    if (!code.includes('ɵɵdefineComponent')) continue;
    const ast = babel.parseSync(code, {
      filename: file, configFile: false, babelrc: false, sourceType: 'module',
      parserOpts: {plugins: ['typescript', 'decorators-legacy']},
    });
    const raw = new Map();
    const encapsulated = new Map();
    babel.traverse(ast, {
      CallExpression({node}) {
        const name = calleeName(node);
        if (name === 'ɵɵdefineComponent') {
          const definition = node.arguments[0];
          const styles = prop(definition, 'styles');
          const stripped = styles?.type === 'ArrayExpression' ? styles.elements
            .filter((e) => e?.type === 'StringLiteral')
            .reduce((n, e) => n + Buffer.byteLength(e.value.replace(/\[_ng(?:content|host)-%COMP%\]/g, '').replace(/ {3}/g, ' ')), 0) : null;
          encapsulated.set(prop(definition, 'type')?.name ?? path.basename(file), stripped);
        } else if (name === 'ɵsetClassMetadata') {
          const [type, decorators] = node.arguments;
          const component = decorators?.elements?.find((d) => prop(d, 'type')?.name === 'Component');
          const args = prop(component, 'args')?.elements?.[0];
          raw.set(type?.name, bytesOf(prop(args, 'styles')));
        }
      },
    });
    for (const [name, fallback] of encapsulated) {
      const bytes = raw.get(name) ?? fallback;
      if (bytes != null) sizes.push({name, bytes});
    }
  }
  return sizes;
}

/**
 * Builds AxeOS. Returns {outDir, files, metafile}; throws BuildError on failure.
 * `workDir` lets concurrent callers (dev server) use their own scratch workspace.
 */
export async function buildAxeos({
  configuration = architect.build.defaultConfiguration ?? 'production',
  outDir = path.join(root, 'dist/axe-os'),
  workDir = path.join(root, '.ts7-build'),
  statsJson = false,
} = {}) {
  const config = architect.build.configurations?.[configuration];
  if (!config) throw new BuildError(`Unknown build configuration "${configuration}" in angular.json`);
  const options = {...architect.build.options, ...config};
  const optimize = options.optimization !== false;
  const sourcemap = options.sourceMap === true;
  const hashing = options.outputHashing === 'all' || options.outputHashing === 'bundles';
  const entryNames = hashing ? '[name]-[hash]' : '[name]';
  const chunkNames = options.namedChunks ? '[name]-[hash]' : 'chunk-[hash]';
  console.log(`configuration: ${configuration} (optimization ${optimize}, sourceMap ${sourcemap}, outputHashing ${options.outputHashing ?? 'none'})`);

  // ------------------------------------------------------ 1-2. ngp + TS 7
  prepareWorkspace(workDir, {configuration});
  const workSrc = path.join(workDir, 'src');
  const ngpOut = runNgp(workDir, 'tsconfig.app.json', {minifyStyles: optimize});
  const {tsconfig, version: tsVersion} = typecheckTs7(ngpOut);

  // ------------------------------------------------------------ 3. bundle JS
  step('esbuild bundle + Angular linker');
  const linkerLogger = {
    level: 1, // info
    debug() {},
    info(...args) { console.log(...args); },
    warn(...args) { console.warn(...args); },
    error(...args) { console.error(...args); },
  };
  const linked = new Set();
  const linkerPlugin = {
    name: 'angular-linker',
    setup(build) {
      build.onLoad({filter: /\.m?js$/}, async (args) => {
        // Same predicate as @angular/build: core/compiler contain the marker but must not be linked.
        if (!args.path.includes('node_modules') || /[\\/]@angular[\\/](?:compiler|core)[\\/]/.test(args.path)) return;
        const code = await fs.promises.readFile(args.path, 'utf8');
        if (!code.includes('ɵɵngDeclare')) return;
        const result = await babel.transformAsync(code, {
          filename: args.path, compact: false, configFile: false, babelrc: false, browserslistConfigFile: false,
          plugins: [createEs2015LinkerPlugin({
            fileSystem: {
              exists: () => false, readFile: () => '', resolve: (...p) => p.join('/'),
              dirname: (p) => p.split('/').slice(0, -1).join('/'), relative: (_from, to) => to,
            },
            logger: linkerLogger, linkerJitMode: false, sourceMapping: false,
          })],
        });
        linked.add(args.path.split(/node_modules[\\/]/).pop().split(/[\\/]/).slice(0, 2).join('/'));
        return {contents: result.code, loader: 'js'};
      });
    },
  };
  fs.rmSync(outDir, {recursive: true, force: true});
  const polyfills = (options.polyfills ?? []).map((p, i) => ({in: p, out: i ? `polyfills-${i}` : 'polyfills'}));
  const js = await esbuild.build({
    absWorkingDir: ngpOut,
    entryPoints: [...polyfills, {in: path.join(ngpOut, options.browser), out: 'main'}],
    outdir: outDir, bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
    minify: optimize, sourcemap, legalComments: 'none', metafile: true, write: true,
    entryNames, chunkNames,
    tsconfig, mainFields: ['es2020', 'es2015', 'browser', 'module', 'main'],
    conditions: ['es2015', 'es2020', 'module', optimize ? 'production' : 'development'],
    // As @angular/build: ngDevMode is only forced off when optimizing (Angular turns an
    // undefined ngDevMode into its debugging object in development).
    define: {
      ...(optimize ? {ngDevMode: 'false'} : {}),
      ngJitMode: 'false', ngServerMode: 'false', ngHmrMode: 'false', ngI18nClosureMode: 'false',
    },
    plugins: [linkerPlugin], logLevel: 'warning',
  }).catch((error) => { throw new BuildError(`esbuild failed: ${error.message}`); });
  console.log(`linked libraries: ${[...linked].sort().join(', ') || 'none'}`);
  // Every bundled Angular class must be compiled ahead of time: an uncompiled one
  // would need the JIT compiler, which is not shipped. (Unused files are not bundled.)
  const bundledSources = Object.keys(js.metafile.inputs)
    .map((input) => path.resolve(ngpOut, input))
    .filter((file) => file.startsWith(path.join(ngpOut, 'src')) && file.endsWith('.ts'));
  const notCompiled = bundledSources.filter((file) =>
    /^\s*@(Component|Directive|Pipe|NgModule|Injectable)\(/m.test(fs.readFileSync(file, 'utf8')));
  const compiledAot = bundledSources.filter((file) => /static ɵ(cmp|dir|pipe|mod|prov|fac)\b/.test(fs.readFileSync(file, 'utf8')));
  if (notCompiled.length || !compiledAot.length) {
    throw new BuildError(`Bundled without AOT compilation: ${notCompiled.map((f) => path.relative(ngpOut, f)).join(', ') || 'no compiled class'}`);
  }
  console.log(`${bundledSources.length} application sources bundled, ${compiledAot.length} AOT-compiled by ngp, 0 left for JIT`);

  // ---------------------------------------------------- 4. global styles etc.
  step('Global styles, index.html, assets');
  const cssParts = (options.styles ?? []).map((entry) => {
    const file = path.join(workDir, typeof entry === 'string' ? entry : entry.input);
    return /\.s[ac]ss$/.test(file)
      ? sass.compile(file, {loadPaths: [workSrc, workDir, path.join(workDir, 'node_modules')], style: 'expanded'}).css
      : fs.readFileSync(file, 'utf8');
  });
  const globalCss = path.join(workSrc, '__global_styles.css');
  fs.writeFileSync(globalCss, cssParts.join('\n'));
  const css = await esbuild.build({
    absWorkingDir: ngpOut, // metafile paths relative to the same directory as the JS build
    entryPoints: [{in: globalCss, out: 'styles'}], outdir: outDir, bundle: true, minify: optimize, sourcemap,
    metafile: true, write: true, entryNames, assetNames: 'media/[name]-[hash]',
    external: ['/assets/*'], logLevel: 'warning',
    loader: {'.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.eot': 'file', '.svg': 'file', '.png': 'file', '.gif': 'file'},
  }).catch((error) => { throw new BuildError(`esbuild (styles) failed: ${error.message}`); });

  const outputs = {...js.metafile.outputs, ...css.metafile.outputs};
  const outputOf = (name) => {
    const hit = Object.keys(outputs).find((file) => outputs[file].entryPoint &&
      new RegExp(`^${name}(-[A-Z0-9]+)?\\.(js|css)$`).test(path.basename(file)));
    if (!hit) throw new BuildError(`No bundle produced for entry "${name}"`);
    return hit;
  };
  const scripts = [...polyfills.map((p) => p.out), 'main'].map(outputOf);
  const stylesheet = outputOf('styles');
  let html = fs.readFileSync(path.join(workDir, options.index), 'utf8');
  html = html.replace('</head>', `<link rel="stylesheet" href="${path.basename(stylesheet)}"></head>`);
  html = html.replace('</body>', `${scripts.map((s) => `<script src="${path.basename(s)}" type="module"></script>`).join('')}</body>`);
  fs.writeFileSync(path.join(outDir, 'index.html'), html);

  for (const asset of options.assets ?? []) {
    const source = path.join(root, typeof asset === 'string' ? asset : path.join(asset.input, asset.glob ?? ''));
    const target = path.join(outDir, path.relative(path.join(root, 'src'), source));
    fs.cpSync(source, target, {recursive: true});
  }

  if (options.extractLicenses !== false) {
    // Licenses of every bundled package, like 3rdpartylicenses.txt from `ng build`.
    const packages = new Map();
    for (const input of Object.keys(js.metafile.inputs)) {
      const match = input.match(/node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/);
      if (match && !packages.has(match[1])) packages.set(match[1], path.join(root, 'node_modules', match[1]));
    }
    const licenses = [...packages].sort().map(([name, dir]) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const file = fs.readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
      return `Package: ${name}\nLicense: "${pkg.license ?? 'unknown'}"\n\n${file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : ''}\n`;
    });
    fs.writeFileSync(path.join(outDir, '3rdpartylicenses.txt'), licenses.join('\n--------------------------------------------------------------------------------\n\n'));
  }
  if (statsJson) {
    fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify({inputs: {...js.metafile.inputs, ...css.metafile.inputs}, outputs}, null, 1));
  }

  // ------------------------------------------------------------ budgets
  // initial: scripts and styles loaded at startup (entries + their static imports).
  const initialFiles = new Set();
  const addInitial = (file) => {
    const key = path.relative(ngpOut, path.resolve(ngpOut, file));
    if (initialFiles.has(key) || !outputs[file]) return;
    initialFiles.add(key);
    for (const dep of outputs[file].imports ?? []) if (dep.kind === 'import-statement') addInitial(dep.path);
  };
  [...scripts, stylesheet].forEach(addInitial);
  const initialBytes = [...initialFiles].reduce((n, file) => n + fs.statSync(path.resolve(ngpOut, file)).size, 0);
  const componentStyles = componentStyleSizes(bundledSources);
  const problems = [];
  for (const budget of options.budgets ?? []) {
    const measured = budget.type === 'initial' ? [{name: 'initial total', bytes: initialBytes}]
      : budget.type === 'anyComponentStyle' ? componentStyles : null;
    if (!measured) {
      console.warn(`budget type "${budget.type}" is not checked by this build`);
      continue;
    }
    for (const {name, bytes} of measured) {
      if (budget.maximumError && bytes > budgetBytes(budget.maximumError)) {
        problems.push(`${budget.type} ${name}: ${(bytes / 1024).toFixed(2)} kB exceeds the ${budget.maximumError} error budget`);
      } else if (budget.maximumWarning && bytes > budgetBytes(budget.maximumWarning)) {
        console.warn(`warning: ${budget.type} ${name}: ${(bytes / 1024).toFixed(2)} kB exceeds the ${budget.maximumWarning} warning budget`);
      }
    }
  }
  const largestStyle = componentStyles.reduce((a, b) => (b.bytes > a.bytes ? b : a), {name: '-', bytes: 0});
  console.log(`budgets: initial ${(initialBytes / 1024).toFixed(1)} kB, largest component style ${largestStyle.name} ${(largestStyle.bytes / 1024).toFixed(2)} kB`);
  if (problems.length) throw new BuildError(`Budget exceeded:\n  ${problems.join('\n  ')}`);

  const files = walk(outDir).sort();
  for (const file of files) {
    console.log(`  ${path.relative(outDir, file).padEnd(52)} ${(fs.statSync(file).size / 1024).toFixed(1).padStart(8)} kB`);
  }
  fs.rmSync(workDir, {recursive: true, force: true});
  const ngpVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@angular/compiler/package.json'), 'utf8')).version;
  console.log(`\nAxeOS built with ${tsVersion} (ngp ${ngpVersion}, ${configuration}) -> ${rel(outDir)}`);
  return {outDir, files, metafile: js.metafile};
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMain(async () => {
    const args = process.argv.slice(2);
    const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const outputPath = value('--output-path');
    await buildAxeos({
      configuration: value('--configuration') ?? value('-c'),
      outDir: outputPath ? path.resolve(outputPath) : undefined,
      statsJson: args.includes('--stats-json'),
    });
  });
}
