/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
export { ErrorCode } from './src/error_code.js';
export { createHybridCompiler, HybridCompiler } from './src/hybrid_compiler.js';
// The sidecar transport: usable with no N-API addon and no wasm engine present.
export { SidecarAnalyzer } from './src/analyzer_sidecar.js';
export { run } from './ngp.js';
export { isStyleLanguage, StylePreprocessError, StylePreprocessor, } from './src/style_preprocessor.js';
export { WasmAnalyzer } from './src/analyzer_wasm.js';
export { IndexerBoundTemplate } from './src/indexing/indexer.js';
export { buildTypeCheckingConfig } from './src/tcb.js';
export { verifyCompilerOptions } from './src/compiler_options.js';
export { IncrementalEmitTracker } from './src/incremental.js';
export { FileUpdateType } from './src/types.js';
export { resolveWorkspaceConfig } from './src/workspace.js';
export async function createAnalyzer(tsconfigPathOrOptions, options) {
    const { loadAnalyzer, toLoadAnalyzerOptions } = await import('./src/analyzer_loader.js');
    return loadAnalyzer(toLoadAnalyzerOptions(tsconfigPathOrOptions, options));
}
export async function createAnalyzerWithInfo(tsconfigPathOrOptions, options) {
    const { loadAnalyzerWithInfo, toLoadAnalyzerOptions } = await import('./src/analyzer_loader.js');
    return loadAnalyzerWithInfo(toLoadAnalyzerOptions(tsconfigPathOrOptions, options));
}
