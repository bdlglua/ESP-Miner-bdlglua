/**
 * Steps shared by the TypeScript 7 build (build-ts7.mjs) and unit tests (test-ts7.mjs):
 * a scratch workspace, Angular's ngp preprocessor (tools/ngp) and the TypeScript 7 check.
 * None of them loads the TypeScript 6 compiler API.
 */
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const require = createRequire(path.join(root, 'package.json'));
const ngpDir = path.join(root, 'tools/ngp');

export const step = (name) => console.log(`\n== ${name}`);

/** A build or test failure already reported to the console. */
export class BuildError extends Error {}

/** Runs a script's main function; a BuildError exits with status 1 without a stack trace. */
export async function runMain(main) {
  try {
    process.exitCode = (await main()) ?? 0;
  } catch (error) {
    if (!(error instanceof BuildError)) throw error;
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  }
}
export const rel = (file) => path.relative(root, file);
export function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

export const angular = JSON.parse(fs.readFileSync(path.join(root, 'angular.json'), 'utf8'));
export const architect = Object.values(angular.projects)[0].architect;

/**
 * Copies the sources to `work`. `configuration` names an angular.json build configuration
 * whose fileReplacements apply (e.g. production: environment.ts -> environment.prod.ts).
 */
export function prepareWorkspace(work, {configuration} = {}) {
  fs.rmSync(work, {recursive: true, force: true});
  fs.mkdirSync(work, {recursive: true});
  fs.cpSync(path.join(root, 'src'), path.join(work, 'src'), {recursive: true});
  // angular.json too: ngp reads inlineStyleLanguage and stylePreprocessorOptions from it.
  for (const name of ['angular.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.spec.json']) {
    if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(work, name));
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(work, 'node_modules'), 'dir');
  const replacements = configuration ? architect.build.configurations?.[configuration]?.fileReplacements ?? [] : [];
  for (const {replace, with: replacement} of replacements) {
    fs.copyFileSync(path.join(root, replacement), path.join(work, replace));
    console.log(`file replacement: ${replace} <- ${replacement}`);
  }
}

/**
 * Runs ngp on `work/<tsconfig>` into `work/ngp` (`minifyStyles` for optimized builds), stops on
 * its Angular diagnostics, then adds
 * the files ngp did not need to compile. Returns the output directory.
 */
export function runNgp(work, tsconfig, {minifyStyles = false} = {}) {
  step('ngp (Angular preprocessor, TypeScript 7 build, Sass component styles)');
  const workSrc = path.join(work, 'src');
  const ngpOut = path.join(work, 'ngp');
  // No --enable-template-type-checker: that is the editor (language service) mode, which adds
  // completion probes; ngtsc does not enable it for builds or tests either.
  execFileSync(process.execPath, [
    path.join(ngpDir, 'main.js'), path.join(work, tsconfig), '--root', work, '--out', ngpOut, '--optimize',
    // Production: component styles minified, as with the Angular CLI (optimization.styles).
    ...(minifyStyles ? ['--minify-styles'] : []),
  ], {stdio: 'inherit', env: {...process.env, NG_EXP_COMPILER_NATIVE_BINDING: path.join(ngpDir, 'ng_analyze.node')}});

  // ngp does not print its Angular diagnostics (template parse errors, unknown elements,
  // missing or invalid stylesheets...); it writes them next to the tsconfig.
  const diagnosticsFile = path.join(work, tsconfig.replace(/\.json$/, '.ngdiag.json'));
  if (!fs.existsSync(diagnosticsFile)) throw new Error(`ngp wrote no diagnostics file (${rel(diagnosticsFile)})`);
  const {diagnostics = [], optionDiagnostics = []} = JSON.parse(fs.readFileSync(diagnosticsFile, 'utf8'));
  let errors = 0;
  for (const d of [...optionDiagnostics, ...diagnostics]) {
    let where = d.filePath ? path.relative(work, d.filePath) : 'tsconfig';
    if (d.filePath && d.span && fs.existsSync(d.filePath)) {
      const before = fs.readFileSync(d.filePath, 'utf8').slice(0, d.span.start).split('\n');
      where += `:${before.length}:${before.at(-1).length + 1}`;
    }
    const isError = d.category === 'error' || d.category === 1;
    if (isError) errors++;
    console.log(`${where} - ${isError ? 'error' : d.category} NG${d.code}: ${d.messageText}`);
  }
  if (errors) throw new BuildError(`ngp reported ${errors} Angular error(s). Stopped.`);

  // ngp writes only the files it compiled; add the plain ones next to them.
  for (const file of walk(workSrc)) {
    const target = path.join(ngpOut, 'src', path.relative(workSrc, file));
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.copyFileSync(file, target);
    }
  }
  const outputs = walk(path.join(ngpOut, 'src'));
  const blocks = outputs.filter((f) => f.endsWith('.ngtypecheck.ts'));
  if (!blocks.length) throw new Error('ngp produced no template type-check block');
  if (blocks.some((f) => fs.readFileSync(f, 'utf8').includes('/*T:COMPCOMP*/'))) {
    throw new Error('ngp emitted editor completion probes: do not use --enable-template-type-checker');
  }
  const sassLeft = outputs.filter((f) => f.endsWith('.ts') && !f.endsWith('.ngtypecheck.ts'))
    .filter((f) => /styles:\s*\[[^\]]*(@include|@use|@mixin|\$[a-z-]+\s*:)/i.test(fs.readFileSync(f, 'utf8')));
  if (sassLeft.length) throw new Error(`Uncompiled Sass in component styles: ${sassLeft.map(rel).join(', ')}`);
  console.log(`${blocks.length} template type-check blocks, ${diagnostics.length + optionDiagnostics.length} Angular diagnostics, 0 errors`);
  return ngpOut;
}

/**
 * Type-checks the ngp output with TypeScript 7, templates included; stops on errors.
 * `specs` includes the unit tests and their test-host templates. Returns the tsconfig path.
 */
export function typecheckTs7(ngpOut, {specs = false, types = []} = {}) {
  step(`TypeScript 7 type check (code + templates${specs ? ' + unit tests' : ''})`);
  const tsconfig = path.join(ngpOut, specs ? 'tsconfig.spec.ts7.json' : 'tsconfig.ts7.json');
  fs.writeFileSync(tsconfig, JSON.stringify({
    extends: '../tsconfig.json',
    compilerOptions: {noEmit: true, types, paths: {'src/*': ['./src/*']}},
    include: ['src/**/*.ts'],
    exclude: specs ? [] : ['src/**/*.spec.ts', 'src/**/*.spec.ngtypecheck.ts'],
  }, null, 2));
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc');
  const version = execFileSync(process.execPath, [tsc, '--version'], {encoding: 'utf8'}).trim();
  try {
    execFileSync(process.execPath, [tsc, '-p', tsconfig], {stdio: 'inherit'});
  } catch {
    throw new BuildError('TypeScript 7 reported errors (template errors point into *.ngtypecheck.ts). Stopped.');
  }
  if (!/^Version 7\./.test(version)) throw new BuildError(`TypeScript 7 expected, found ${version}`);
  console.log(`${version}: no errors`);
  return {tsconfig, version};
}
