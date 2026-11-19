/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
/**
 * Resolves the Rust analysis engine and wraps it in an {@link IAnalyzer}.
 *
 * Two engines can back the compiler:
 *
 * - **native** — the N-API addon, delivered by the per-platform
 *   `ng-exp-compiler-arch-<triple>` packages and loaded through napi's generated
 *   dispatcher (which owns the musl/glibc detection we must not reimplement).
 * - **wasm** — the `wasm-bindgen` build in `ng-exp-compiler-arch-wasm`, which runs
 *   anywhere.
 *
 * IMPORTANT: nothing in this module may run at import time, and nothing on the
 * sidecar code path may import it *statically*. The compiler is also deployed to
 * environments where N-API is unavailable and the engine is an out-of-process
 * sidecar binary; a static edge from `api.ts` or `analyzer_sidecar.ts` to this file
 * would drag engine resolution into module evaluation and break those deployments.
 * Reach this module through `createAnalyzer()` in `api.ts` or a dynamic `import()`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
/**
 * Normalizes the `(tsconfigPath, options?)` and `(options)` call forms into one options object.
 * A positional `tsconfigPath` takes precedence over `options.tsconfigPath`.
 */
export function toLoadAnalyzerOptions(tsconfigPathOrOptions, options = {}) {
    return typeof tsconfigPathOrOptions === 'string'
        ? { ...options, tsconfigPath: tsconfigPathOrOptions }
        : tsconfigPathOrOptions;
}
/** Strips the loader-only keys from `options`, leaving exactly the engine's options. */
function engineOptions(options) {
    const { backend, nativeBinding, wasmBinding, hostFs, ngAnalyzeDir, useWasm, ...engine } = options;
    return { ...engine, optimize: options.optimize ?? true };
}
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);
/**
 * True when this file lives inside an installed dependency tree. Gates the
 * repo-layout probes below: an installed copy must never walk up into the
 * consumer's project and guess at an unrelated `ng-analyze/` directory.
 */
const IS_INSTALLED = SELF_DIR.split(path.sep).includes('node_modules');
const MAX_WALK_UP = 8;
function envFlag(name) {
    const value = process.env[name];
    return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}
function debugLog(message) {
    if (envFlag('NG_EXP_DEBUG_LOADER')) {
        console.error(`[ng-exp-compiler loader] ${message}`);
    }
}
function pathExists(p) {
    return fs.access(p).then(() => true, () => false);
}
/** Walks up from this module looking for `relative`, stopping at the filesystem root. */
async function walkUpFor(relative) {
    let dir = SELF_DIR;
    for (let i = 0; i < MAX_WALK_UP; i++) {
        const candidate = path.join(dir, relative);
        if (await pathExists(candidate)) {
            return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return null;
}
async function existingPath(candidate) {
    return (await pathExists(candidate)) ? candidate : null;
}
/** Resolves the requested backend, or `null` to mean "native, then fall back to wasm". */
function requestedBackend(options) {
    if (options.backend) {
        return options.backend;
    }
    if (options.useWasm) {
        return 'wasm';
    }
    const fromEnv = process.env['NG_EXP_COMPILER_BACKEND'];
    if (fromEnv === 'native' || fromEnv === 'wasm') {
        return fromEnv;
    }
    if (envFlag('NG_EXP_FORCE_WASM')) {
        return 'wasm';
    }
    return null;
}
async function nativeCandidates(options) {
    const out = [];
    const push = (spec, origin) => {
        if (spec) {
            out.push({ backend: 'native', spec, origin });
        }
    };
    const [ngAnalyzeDirIndex, bundledBinding, inRepoIndex] = await Promise.all([
        options.ngAnalyzeDir ? existingPath(path.join(options.ngAnalyzeDir, 'index.js')) : null,
        existingPath(path.resolve(SELF_DIR, '../../native/binding.cjs')),
        !IS_INSTALLED ? walkUpFor(path.join('ng-analyze', 'index.js')) : null,
    ]);
    push(options.nativeBinding, 'nativeBinding option');
    push(process.env['NG_EXP_COMPILER_NATIVE_BINDING'], 'NG_EXP_COMPILER_NATIVE_BINDING');
    push(ngAnalyzeDirIndex, 'ngAnalyzeDir option');
    push(bundledBinding, 'bundled napi binding');
    push(inRepoIndex, 'in-repo ng-analyze/');
    return out;
}
async function wasmCandidates(options) {
    const out = [];
    const push = (spec, origin) => {
        if (spec) {
            out.push({ backend: 'wasm', spec, origin });
        }
    };
    const wasmBinRel = path.join('packages', 'compiler-cli', 'preprocessor', 'ng-analyze', 'ng_analyze_wasm', 'ng_analyze_wasm.js');
    const [ngAnalyzeWasmDirIndex, bundledWasm, bazelBinWasm, bazelOutWasm, inRepoWasm] = await Promise.all([
        options.ngAnalyzeDir
            ? existingPath(path.join(options.ngAnalyzeDir, '..', 'ng-analyze-wasm', 'ng_analyze.js'))
            : null,
        existingPath(path.resolve(SELF_DIR, '../ng-analyze/ng_analyze_wasm/ng_analyze_wasm.js')),
        !IS_INSTALLED ? walkUpFor(path.join('dist', 'bin', wasmBinRel)) : null,
        !IS_INSTALLED ? walkUpFor(wasmBinRel) : null,
        !IS_INSTALLED ? walkUpFor(path.join('ng-analyze-wasm', 'ng_analyze.js')) : null,
    ]);
    push(options.wasmBinding, 'wasmBinding option');
    push(process.env['NG_EXP_COMPILER_WASM_BINDING'], 'NG_EXP_COMPILER_WASM_BINDING');
    push(ngAnalyzeWasmDirIndex, 'ngAnalyzeDir option');
    push(bundledWasm, 'bundled ng_analyze_wasm');
    push(bazelBinWasm, 'bazel-bin ng_analyze_wasm');
    push(bazelOutWasm, 'bazel-out ng_analyze_wasm');
    push('ng-exp-compiler-arch-wasm', 'ng-exp-compiler-arch-wasm package');
    push(inRepoWasm, 'in-repo ng-analyze-wasm/');
    return out;
}
function describeExports(mod) {
    if (mod === null || mod === undefined) {
        return 'module resolved to null/undefined';
    }
    const keys = Object.keys(mod);
    return keys.length > 0 ? `exports: ${keys.join(', ')}` : 'module has no exports';
}
async function constructNative(spec, options) {
    const mod = requireFromHere(spec);
    const Analyzer = mod?.Analyzer;
    if (typeof Analyzer !== 'function') {
        throw new Error(`'${spec}' does not export an 'Analyzer' constructor (${describeExports(mod)})`);
    }
    const { NapiAnalyzer } = await import('./analyzer_napi.js');
    return new NapiAnalyzer(new Analyzer(engineOptions(options)));
}
async function constructWasm(spec, options) {
    const mod = requireFromHere(spec);
    const Inner = mod?.WasmAnalyzer;
    if (typeof Inner !== 'function') {
        // Guards against pointing this at napi's WASI build, which exposes the napi
        // surface (Analyzer/TestAnalyzer) rather than the wasm-bindgen WasmAnalyzer.
        throw new Error(`'${spec}' does not export a 'WasmAnalyzer' constructor (${describeExports(mod)})`);
    }
    const { WasmAnalyzer } = await import('./analyzer_wasm.js');
    // The engine has no OS beneath it, so without this bridge it can only see
    // `virtualFiles` and cannot analyze a project on disk. Callers can substitute their
    // own host (a bundler's module graph, say) or pass null to keep it in-memory only.
    let hostFs = options.hostFs;
    if (hostFs === undefined) {
        const { createNodeHostFs } = await import('./wasm_host_fs.js');
        hostFs = createNodeHostFs();
    }
    const inner = new Inner(JSON.stringify(engineOptions(options)), hostFs);
    return new WasmAnalyzer(inner);
}
function hostDescription() {
    const parts = [`${process.platform}/${process.arch}`, `node ${process.version}`];
    return parts.join(', ');
}
function noAnalyzerError(attempts, strict) {
    const lines = attempts.map(({ candidate, error }, i) => {
        const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
        return `  ${i + 1}. ${candidate.backend.padEnd(6)} ${candidate.spec}\n       via ${candidate.origin}\n       ${reason}`;
    });
    const detail = attempts.length > 0
        ? `Tried, in order:\n${lines.join('\n')}`
        : 'No candidate engines were available to try.';
    const remedy = strict
        ? 'A specific backend was requested, so no fallback was attempted. Unset ' +
            'NG_EXP_COMPILER_BACKEND / NG_EXP_FORCE_WASM (or drop the `backend` option) to allow fallback.'
        : [
            'The engines ship as optionalDependencies. Package managers skip optional',
            'dependencies when installed with --omit=optional / --no-optional, or when a',
            'lockfile was generated on a different platform (npm/cli#4828).',
            '',
            'Fix:  npm install --save-optional ng-exp-compiler-arch-wasm',
            ' or:  rm -rf node_modules package-lock.json && npm install',
        ].join('\n');
    const error = new Error(`Could not load the ng-exp-compiler analysis engine.\n\n` +
        `Host: ${hostDescription()}\n${detail}\n\n${remedy}\n\n` +
        `Set NG_EXP_DEBUG_LOADER=1 for the full resolution trace.`);
    error.code = 'ERR_NG_EXP_NO_ANALYZER';
    if (attempts.length > 0) {
        error.cause = new AggregateError(attempts.map((a) => a.error), 'All analyzer engine candidates failed');
    }
    return error;
}
export async function loadAnalyzerWithInfo(tsconfigPathOrOptions, maybeOptions) {
    const options = toLoadAnalyzerOptions(tsconfigPathOrOptions, maybeOptions);
    const requested = requestedBackend(options);
    const candidates = requested === 'wasm'
        ? await wasmCandidates(options)
        : requested === 'native'
            ? await nativeCandidates(options)
            : [...(await nativeCandidates(options)), ...(await wasmCandidates(options))];
    debugLog(`backend=${requested ?? 'auto'} installed=${IS_INSTALLED} candidates=${candidates.length}`);
    const attempts = [];
    for (const candidate of candidates) {
        try {
            debugLog(`trying ${candidate.backend}: ${candidate.spec} (${candidate.origin})`);
            const analyzer = candidate.backend === 'native'
                ? await constructNative(candidate.spec, options)
                : await constructWasm(candidate.spec, options);
            debugLog(`loaded ${candidate.backend} from ${candidate.spec}`);
            return { analyzer, backend: candidate.backend, resolvedFrom: candidate.spec };
        }
        catch (error) {
            debugLog(`failed ${candidate.spec}: ${error instanceof Error ? error.message : error}`);
            attempts.push({ candidate, error });
        }
    }
    throw noAnalyzerError(attempts, requested !== null);
}
export async function loadAnalyzer(tsconfigPathOrOptions, maybeOptions) {
    const { analyzer } = await loadAnalyzerWithInfo(toLoadAnalyzerOptions(tsconfigPathOrOptions, maybeOptions));
    return analyzer;
}
