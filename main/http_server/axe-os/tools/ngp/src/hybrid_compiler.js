/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import { LEGACY_OPTIONAL_CHAINING_DEFAULT, MatchSource, } from '@angular/compiler';
import { makeClassKey } from './compiler-utils.js';
import { verifyCompilerOptions, verifyExtendedDiagnosticsOptions, } from './compiler_options.js';
import { DependencyTemplates, ngContentSignature } from './dependency_templates.js';
import { flattenNgDiagnosticMessage, withErrorGuide } from './diagnostic.js';
import { getOrCreateFileAnalysis } from './file_analysis.js';
import { IncrementalEmitTracker } from './incremental.js';
import { getIndexedComponents } from './indexing/indexer.js';
import { fingerprintOf, ProcessedFileCache } from './processed_file_cache.js';
import { Counter, NOOP_TRACER, SpanKind } from './perf.js';
import { buildTcbTargets, processFile } from './processor.js';
import { buildTypeCheckingConfig, combineTcbContent, generateTcbCode, prepareTcbTargets, } from './tcb.js';
import * as nga from './types.js';
export function getDiagnosticPath(tsconfigPath) {
    if (tsconfigPath.endsWith('.json')) {
        return tsconfigPath.slice(0, -5) + '.ngdiag.json';
    }
    return tsconfigPath + '.ngdiag.json';
}
/**
 * Serialize diagnostics to the `.ngdiag.json` payload. `diagnostics` is the output of
 * `HybridCompiler.getDiagnostics()`, which already leaves out diagnostics anchored on a `.d.ts`
 * file and orders the rest deterministically.
 *
 * Compiler option diagnostics (`verifyCompilerOptions`) are serialized separately under
 * `optionDiagnostics` so downstream consumers reading `diagnostics` for per-file reporting
 * do not mix option diagnostics into file diagnostics.
 */
export function serializeDiagnostics(tsconfigPath, diagnostics, optionDiagnostics = []) {
    return (JSON.stringify({
        tsconfigPath,
        ...(optionDiagnostics.length > 0
            ? { optionDiagnostics: optionDiagnostics.map(formatSerializedDiagnostic) }
            : {}),
        diagnostics: diagnostics.map(formatSerializedDiagnostic),
    }, null, 2) + '\n');
}
/**
 * Whether `diag` is reported against a `.d.ts` file. `analyzedPath` (the `diagnosticsMap` key)
 * is the file a diagnostic without its own `filePath` belongs to.
 *
 * The analyzer anchors some diagnostics on a declaration in a dependency, e.g. `NG1010` for an
 * `@NgModule` that imports a non-class from a `.d.ts` is reported on that declaration, like
 * ngtsc's `createValueHasWrongTypeError(entry.node, ...)`. ngtsc keeps such diagnostics in
 * `NgCompiler.getDiagnostics()`, but a build that asks for the diagnostics of each source file
 * of the compilation unit (`getDiagnosticsForFile`) never sees them, and that is what the
 * `.ngdiag.json` consumers do. `diagnosticsMap` keeps them so that
 * `getDiagnostics({includeDeclarationFiles: true})` consumers still can.
 */
function targetsDeclarationFile(diag, analyzedPath) {
    return (diag.filePath ?? analyzedPath).endsWith('.d.ts');
}
function isAbsolutePosixOrWindowsPath(p) {
    return p.startsWith('/') || /^[a-zA-Z]:\//.test(p);
}
/**
 * Whether `filePath` is a TypeScript/JavaScript source or a JSON file (e.g. a tsconfig), as
 * opposed to a template or stylesheet a component may read.
 */
function isSourceOrConfigFile(filePath) {
    return /\.(?:[cm]?[jt]sx?|json)$/i.test(filePath);
}
/**
 * Creates a configured {@link HybridCompiler} using compiler options read from `innerAnalyzer`.
 */
export function createHybridCompiler(innerAnalyzer, options = {}) {
    const angularCompilerOptions = innerAnalyzer.getCompilerOptions?.();
    const optionDiagnostics = verifyCompilerOptions(angularCompilerOptions ?? {});
    const tcbConfig = buildTypeCheckingConfig(angularCompilerOptions, options.enableTemplateTypeChecker);
    const isClosureCompilerEnabled = angularCompilerOptions?.annotateForClosureCompiler === true;
    const emitDeclarationOnly = angularCompilerOptions?.emitDeclarationOnly === true &&
        angularCompilerOptions?._experimentalAllowEmitDeclarationOnly === true;
    const onlyPublishPublicTypingsForNgModules = angularCompilerOptions?.onlyPublishPublicTypingsForNgModules === true;
    const workspaceName = angularCompilerOptions?.workspaceName || undefined;
    const rootDirs = angularCompilerOptions?.rootDirs;
    const enableHmr = angularCompilerOptions?._enableHmr;
    const optimize = options.optimize ?? false;
    return new HybridCompiler(innerAnalyzer, {
        optimize,
        tcbConfig,
        optionDiagnostics,
        legacyOptionalChaining: angularCompilerOptions?.legacyOptionalChaining,
        isClosureCompilerEnabled,
        onlyExplicitDeferDependencyImports: angularCompilerOptions?.onlyExplicitDeferDependencyImports,
        enableTemplateSourceLocations: angularCompilerOptions?.enableTemplateSourceLocations,
        emitDeclarationOnly,
        onlyPublishPublicTypingsForNgModules,
        forbidOrphanComponents: angularCompilerOptions?.forbidOrphanComponents,
        supportJitMode: angularCompilerOptions?.supportJitMode !== false,
        preserveWhitespaces: angularCompilerOptions?.preserveWhitespaces,
        supportTestBed: angularCompilerOptions?.supportTestBed,
        enableI18nLegacyMessageIdFormat: angularCompilerOptions?.enableI18nLegacyMessageIdFormat,
        i18nUseExternalIds: angularCompilerOptions?.i18nUseExternalIds,
        i18nNormalizeLineEndingsInICUs: angularCompilerOptions?.i18nNormalizeLineEndingsInICUs,
        i18nPreserveWhitespaceForLegacyExtraction: angularCompilerOptions?.i18nPreserveWhitespaceForLegacyExtraction,
        enableHmr,
        rootDir: options.rootDir,
        workspaceName,
        rootDirs,
        incremental: options.incremental,
        tracer: options.tracer,
        stylePreprocessor: options.stylePreprocessor,
    });
}
export class HybridCompiler {
    analyzer;
    /** Bound targets and TCBs per file, keyed by `AnalysisResult.filePath`. */
    fileCache = new Map();
    /** Decides which files an incremental build has to re-emit. */
    incremental = new IncrementalEmitTracker();
    incrementalEnabled;
    /**
     * Persistent map of the latest `ProcessedFile` for every file in the program across incremental
     * builds, updated by `compile()`.
     */
    currentProcessedFiles = new Map();
    /** Errors thrown while processing individual files in the latest `compile()`. */
    currentProcessErrors = new Map();
    optimize;
    diagnosticsMap = new Map();
    analysisDiagnosticsBySource = new Map();
    processedDiagnosticsBySource = new Map();
    optionDiagnostics = [];
    tcbConfig;
    templateParseOptions;
    legacyOptionalChaining;
    isClosureCompilerEnabled;
    emitDeclarationOnly;
    externalRuntimeStyles;
    stylePreprocessor;
    onlyExplicitDeferDependencyImports;
    enableTemplateSourceLocations;
    onlyPublishPublicTypingsForNgModules;
    forbidOrphanComponents;
    supportJitMode;
    supportTestBed;
    i18nUseExternalIds;
    enableHmr;
    rootDir;
    complianceMode;
    workspaceName;
    rootDirs;
    tracer;
    reuseProcessedFiles;
    verifyReusedProcessedFiles;
    processedFiles = new ProcessedFileCache();
    pendingVerification = new Map();
    knownResources = new Set();
    templateStyleUrlsByFile = new Map();
    metadataByFile = new Map();
    lastChunkByFile = new Map();
    componentTemplateConsumers = new Map();
    ngContentSignatureByFile = new Map();
    jsDirtyFiles = new Set();
    pendingDeltaChunks = [];
    serializedObjects = new WeakMap();
    ngContentSignatures = new WeakMap();
    hasCompiled = false;
    pendingCompilation = Promise.resolve();
    constructor(analyzer, options = {}) {
        this.optimize = options.optimize ?? true;
        this.templateParseOptions = {
            preserveWhitespaces: options.preserveWhitespaces ?? false,
            preserveSignificantWhitespace: options.i18nPreserveWhitespaceForLegacyExtraction ?? true,
            enableI18nLegacyMessageIdFormat: options.enableI18nLegacyMessageIdFormat !== false,
            i18nNormalizeLineEndingsInICUs: options.i18nNormalizeLineEndingsInICUs === true,
            ...options.templateParseOptions,
        };
        this.supportJitMode = options.supportJitMode !== false;
        this.supportTestBed = options.supportTestBed !== false;
        this.i18nUseExternalIds = options.i18nUseExternalIds !== false;
        this.enableHmr = options.enableHmr === true;
        this.analyzer = analyzer;
        this.tcbConfig = options.tcbConfig ?? buildTypeCheckingConfig({});
        this.legacyOptionalChaining =
            options.legacyOptionalChaining ?? LEGACY_OPTIONAL_CHAINING_DEFAULT;
        this.isClosureCompilerEnabled = options.isClosureCompilerEnabled ?? false;
        this.emitDeclarationOnly = options.emitDeclarationOnly ?? false;
        this.externalRuntimeStyles = options.externalRuntimeStyles ?? false;
        this.stylePreprocessor = options.stylePreprocessor;
        this.onlyExplicitDeferDependencyImports = options.onlyExplicitDeferDependencyImports ?? false;
        this.enableTemplateSourceLocations = options.enableTemplateSourceLocations ?? false;
        this.onlyPublishPublicTypingsForNgModules =
            options.onlyPublishPublicTypingsForNgModules ?? false;
        this.forbidOrphanComponents = options.forbidOrphanComponents ?? false;
        if (options.supportJitMode === false && this.forbidOrphanComponents) {
            throw new Error('JIT mode support ("supportJitMode" option) cannot be disabled when forbidOrphanComponents is set to true');
        }
        const configErrors = options.optionDiagnostics ??
            (this.tcbConfig.extendedDiagnostics
                ? verifyExtendedDiagnosticsOptions({
                    strictTemplates: this.tcbConfig.checkTemplateBodies,
                    extendedDiagnostics: this.tcbConfig.extendedDiagnostics,
                })
                : []);
        this.optionDiagnostics = [...configErrors];
        // Mirrors `NgCompiler`, which doesn't construct the extended template checker, the template
        // semantics checker or the source file validator when it has construction diagnostics. Note
        // that `controlFlowPreventingContentProjection` is intentionally left alone: ngtsc reports
        // it from the type check block regardless of option diagnostics.
        if (this.optionDiagnostics.length > 0) {
            this.tcbConfig = { ...this.tcbConfig, disabledExtendedDiagnostics: true };
        }
        if (options.rootDir !== undefined) {
            const norm = options.rootDir.replace(/\\/g, '/');
            if (!isAbsolutePosixOrWindowsPath(norm)) {
                throw new Error(`'${options.rootDir}' in 'rootDir' must be an absolute path`);
            }
            this.rootDir = norm;
        }
        this.complianceMode = options.complianceMode ?? false;
        this.incrementalEnabled = options.incremental ?? true;
        this.reuseProcessedFiles = this.incrementalEnabled && (options.reuseProcessedFiles ?? true);
        this.verifyReusedProcessedFiles = options.verifyReusedProcessedFiles ?? false;
        this.tracer = options.tracer ?? NOOP_TRACER;
        this.workspaceName = options.workspaceName;
        if (options.rootDirs) {
            this.rootDirs = options.rootDirs.map((d) => {
                const norm = d.replace(/\\/g, '/');
                if (!isAbsolutePosixOrWindowsPath(norm)) {
                    throw new Error(`'${d}' in 'rootDirs' must be an absolute path`);
                }
                return norm;
            });
        }
        else {
            this.rootDirs = undefined;
        }
    }
    /**
     * Returns the collected per-file diagnostics. `diagnosticsMap` is keyed by completion order of
     * the parallel analysis chunks, which varies from run to run (and across transports), so the
     * result is sorted (file path, then span start) to keep consumers such as the `.ngdiag.json`
     * deterministic; the sort is stable, so a file's diagnostics sharing a span keep their
     * reporting order.
     *
     * Diagnostics anchored on `.d.ts` files are excluded unless `includeDeclarationFiles` is
     * `true` (see `targetsDeclarationFile`).
     *
     * Compiler option diagnostics (`this.optionDiagnostics`) are kept separate so per-file
     * diagnostic consumers do not mix option diagnostics into file diagnostics.
     */
    getDiagnostics(options) {
        const includeDeclarationFiles = options?.includeDeclarationFiles ?? false;
        const allDiagnostics = [];
        for (const [analyzedPath, diags] of this.diagnosticsMap) {
            for (const diag of diags) {
                if (includeDeclarationFiles || !targetsDeclarationFile(diag, analyzedPath)) {
                    allDiagnostics.push(diag);
                }
            }
        }
        allDiagnostics.sort((a, b) => (a.filePath ?? '').localeCompare(b.filePath ?? '') ||
            (a.span?.start ?? -1) - (b.span?.start ?? -1));
        return allDiagnostics;
    }
    async prepareChunk(chunk) {
        // Spans awaits, but chunks are prepared one at a time with no other work in between.
        return this.tracer.sliceAsync(SpanKind.PrepareChunk, async () => {
            this.recordChunkDiagnostics(chunk);
            if (!this.incrementalEnabled) {
                for (const file of chunk.files) {
                    this.fileCache.delete(file.filePath);
                }
            }
            const metadataMap = chunkMetadataMap(chunk);
            if (this.emitDeclarationOnly || (!this.optimize && chunk.files.length <= 1)) {
                return {
                    remoteScopedClasses: new Set(),
                    metadataMap,
                    eagerlyUsedDeclarations: new Map(),
                };
            }
            const boundFiles = await Promise.all(chunk.files.map(async (file) => ({
                file,
                analysis: await this.ensureBoundWithMetadata(file, undefined, metadataMap),
            })));
            return this.finalizePreparedChunk(chunk, boundFiles, metadataMap);
        });
    }
    recordChunkDiagnostics(chunk) {
        this.tracer.count(Counter.FilesAnalyzed, chunk.files.length);
        if (chunk.removedFiles && chunk.removedFiles.length > 0) {
            for (const removed of chunk.removedFiles) {
                this.evictRemovedFile(removed);
            }
            if (this.incrementalEnabled) {
                this.incremental.recordChanges([], chunk.removedFiles);
            }
        }
        // `NgCompiler` skips the `SourceFileValidator` when it has construction diagnostics.
        const skipSourceFileValidator = this.optionDiagnostics.length > 0;
        for (const file of chunk.files) {
            this.recordMetadata(file);
            this.lastChunkByFile.set(file.filePath, chunk);
            const diagnostics = [];
            if (file.diagnostics) {
                diagnostics.push(...file.diagnostics.map(withErrorGuide));
            }
            if (!skipSourceFileValidator && file.sourceFileValidatorDiagnostics) {
                diagnostics.push(...file.sourceFileValidatorDiagnostics.map(withErrorGuide));
            }
            this.replaceDiagnostics(this.analysisDiagnosticsBySource, file.filePath, diagnostics.map((diag) => ({ target: file.filePath, diag })));
        }
    }
    /**
     * Replaces the diagnostics `source` contributed through `contributions` with `next`, leaving
     * every other file's diagnostics, and their order, untouched. Each file reports diagnostics at
     * two points (analysis, then processing) and a processed diagnostic may target another file
     * (e.g. an external template), so a re-run has to remove exactly what that run reported before.
     */
    replaceDiagnostics(contributions, source, next) {
        for (const { target, diag } of contributions.get(source) ?? []) {
            const existing = this.diagnosticsMap.get(target);
            if (existing === undefined) {
                continue;
            }
            const remaining = existing.filter((d) => d !== diag);
            if (remaining.length > 0) {
                this.diagnosticsMap.set(target, remaining);
            }
            else {
                this.diagnosticsMap.delete(target);
            }
        }
        if (next.length === 0) {
            contributions.delete(source);
            return;
        }
        contributions.set(source, next);
        for (const { target, diag } of next) {
            const existing = this.diagnosticsMap.get(target);
            if (existing === undefined) {
                this.diagnosticsMap.set(target, [diag]);
            }
            else {
                existing.push(diag);
            }
        }
    }
    /** Drops every diagnostic `filePath` reported, e.g. once it has left the program. */
    forgetDiagnosticsOf(filePath) {
        this.replaceDiagnostics(this.analysisDiagnosticsBySource, filePath, []);
        this.replaceDiagnostics(this.processedDiagnosticsBySource, filePath, []);
    }
    /** Evicts all cached state for a file that was deleted or left the program closure. */
    evictRemovedFile(filePath) {
        this.forgetDiagnosticsOf(filePath);
        this.fileCache.delete(filePath);
        this.metadataByFile.delete(filePath);
        this.lastChunkByFile.delete(filePath);
        this.processedFiles.delete(filePath);
        this.currentProcessedFiles.delete(filePath);
        this.currentProcessErrors.delete(filePath);
        this.templateStyleUrlsByFile.delete(filePath);
        this.ngContentSignatureByFile.delete(filePath);
        this.jsDirtyFiles.delete(filePath);
        this.componentTemplateConsumers.delete(filePath);
        for (const consumers of this.componentTemplateConsumers.values()) {
            consumers.delete(filePath);
        }
    }
    recordMetadata(result) {
        if (this.metadataByFile.get(result.filePath) === result) {
            return;
        }
        this.metadataByFile.set(result.filePath, result);
        // Template consumers only drive incremental invalidation and delta passes.
        if (this.incrementalEnabled) {
            this.recordComponentTemplateConsumers(result.filePath, result);
        }
    }
    invalidateCachedFile(filePath) {
        this.fileCache.delete(filePath);
        this.metadataByFile.delete(filePath);
    }
    recordComponentTemplateConsumers(filePath, result) {
        for (const consumers of this.componentTemplateConsumers.values()) {
            consumers.delete(filePath);
        }
        const ngContentParts = [];
        for (const cls of result.classes) {
            const component = cls.component;
            if (!component) {
                continue;
            }
            if (cls.className) {
                ngContentParts.push(`${cls.className}:${this.ngContentSignatureOf(component)}`);
            }
            if (component.templateUrl) {
                this.knownResources.add(component.templateUrl.resolvedPath);
            }
            for (const styleUrl of component.styleUrls ?? []) {
                this.knownResources.add(styleUrl.resolvedPath);
            }
            const declarations = [
                ...(component.resolvedDeclarations ?? []),
                ...(component.resolvedDeferredDeclarations ?? []),
                ...Object.values(component.resolvedDeferredDeclarationsByBlock ?? {}).flat(),
            ];
            for (const decl of declarations) {
                if (decl.declarationType !== 'component' ||
                    decl.ngContentSelectors != null ||
                    !decl.filePath ||
                    decl.filePath === filePath) {
                    continue;
                }
                let consumers = this.componentTemplateConsumers.get(decl.filePath);
                if (!consumers) {
                    consumers = new Set();
                    this.componentTemplateConsumers.set(decl.filePath, consumers);
                }
                consumers.add(filePath);
            }
        }
        const nextSignature = ngContentParts.join(';');
        const prevSignature = this.ngContentSignatureByFile.get(filePath);
        this.ngContentSignatureByFile.set(filePath, nextSignature);
        if (prevSignature !== undefined && prevSignature !== nextSignature) {
            for (const consumer of this.componentTemplateConsumers.get(filePath) ?? []) {
                this.jsDirtyFiles.add(consumer);
            }
        }
    }
    finalizePreparedChunk(chunk, boundFiles, metadataMap) {
        const remoteScopedClasses = new Set();
        const eagerlyUsedDeclarations = new Map();
        // Identify template dependencies of components in the chunk and check cycleProne.
        const chunkFileIds = new Set(chunk.files.map((f) => f.fileId));
        const dynamicGraph = new Map();
        // Pre-seed graph with intra-chunk static TypeScript import edges from Rust
        if (chunk.staticEdges) {
            for (const [fromIdStr, targets] of Object.entries(chunk.staticEdges)) {
                const fromId = Number(fromIdStr);
                let edges = dynamicGraph.get(fromId);
                if (!edges) {
                    edges = new Set();
                    dynamicGraph.set(fromId, edges);
                }
                for (const target of targets) {
                    if (chunkFileIds.has(target) && target !== fromId) {
                        edges.add(target);
                    }
                }
            }
        }
        for (const { file, analysis } of boundFiles) {
            if (!analysis)
                continue;
            for (const classMeta of file.classes) {
                if (!classMeta.component || !classMeta.className)
                    continue;
                const className = classMeta.className;
                const classKey = makeClassKey(className, classMeta.span.start);
                const boundTarget = analysis.preparedTcbData?.boundTargetMap.get(classKey);
                if (!boundTarget)
                    continue;
                // Remote scoping replaces the component's own dependency list, so it carries the
                // eager set only — deferred dependencies keep their dynamic imports and do not create static cycles.
                const eagerDirs = new Set(boundTarget
                    .getEagerlyUsedDirectives()
                    .filter((d) => d.matchSource === MatchSource.Selector)
                    .map((d) => d.name));
                const eagerPipes = new Set(boundTarget.getEagerlyUsedPipes());
                const resolvedDecls = classMeta.component.resolvedDeclarations || [];
                const pipeNameToDecl = new Map();
                for (const decl of resolvedDecls) {
                    if (decl.declarationType === 'pipe' && decl.pipeName) {
                        pipeNameToDecl.set(decl.pipeName, decl);
                    }
                }
                const eagerDirDecls = resolvedDecls.filter((d) => d.declarationType !== 'pipe' &&
                    d.declarationType !== 'ngmodule' &&
                    eagerDirs.has(d.name));
                const eagerPipeDecls = Array.from(pipeNameToDecl.values()).filter((d) => !!d.pipeName && eagerPipes.has(d.pipeName));
                const eagerDecls = [...eagerDirDecls, ...eagerPipeDecls];
                eagerlyUsedDeclarations.set(`${file.filePath}#${className}`, eagerDecls);
                if (classMeta.component.standalone && !classMeta.component.declaringNgModule) {
                    continue;
                }
                // Check if any eagerly used dependency is statically cycleProne
                let hasStaticCycle = false;
                for (const decl of eagerDecls) {
                    if (decl.cycleProne) {
                        hasStaticCycle = true;
                        break;
                    }
                }
                if (hasStaticCycle) {
                    remoteScopedClasses.add(`${file.filePath}#${className}`);
                    continue;
                }
                let createsCycle = false;
                for (const decl of eagerDecls) {
                    if (chunkFileIds.has(decl.fileId) &&
                        decl.fileId !== file.fileId &&
                        hasGraphPath(dynamicGraph, decl.fileId, file.fileId)) {
                        createsCycle = true;
                        break;
                    }
                }
                if (createsCycle) {
                    remoteScopedClasses.add(`${file.filePath}#${className}`);
                    continue;
                }
                // Add eager dependencies to local dynamic graph only when not remote-scoped
                let edges = dynamicGraph.get(file.fileId);
                if (!edges) {
                    edges = new Set();
                    dynamicGraph.set(file.fileId, edges);
                }
                for (const decl of eagerDecls) {
                    if (chunkFileIds.has(decl.fileId) && decl.fileId !== file.fileId) {
                        edges.add(decl.fileId);
                    }
                }
            }
        }
        return { remoteScopedClasses, metadataMap, eagerlyUsedDeclarations };
    }
    async init() {
        const iterator = this.optimize ? this.analyzer.analyzeOptimized() : this.analyzer.analyze();
        for await (const _ of iterator) {
        }
    }
    /**
     * Resolves once every update queued so far has been applied, or has failed.
     *
     * This is a barrier for readers (the language service awaits it before each request), not a
     * report of how the updates went: a failed update's error goes to that update's caller, and
     * rethrowing it here would fail every later request for an error the requester can't act on.
     */
    async ensureReady() {
        await this.pendingCompilation;
    }
    async updateFileContent(updates) {
        if (updates.length === 0) {
            return;
        }
        await this.enqueueUpdate(async () => {
            await this.recordInvalidations(updates.map(({ filePath }) => ({ filePath, updateType: nga.FileUpdateType.Changed })));
            return this.analyzer.updateFileContent(updates);
        });
    }
    async invalidateFiles(updates) {
        if (updates.length === 0) {
            return;
        }
        await this.enqueueUpdate(async () => {
            await this.recordInvalidations(updates);
            return this.analyzer.invalidateFiles(updates);
        });
    }
    /**
     * Applies file invalidations already executed on `this.analyzer` (e.g. when reusing a
     * `HybridCompiler` across persistent worker requests with `run()`).
     */
    applyInvalidations(updates, invalidatedTsFiles, canonicalPaths) {
        this.recordCanonicalInvalidations(updates, canonicalPaths);
        for (const filePath of invalidatedTsFiles) {
            this.invalidateCachedFile(filePath);
        }
    }
    async recordInvalidations(updates) {
        const canonical = await this.analyzer.canonicalPaths?.(updates.map(({ filePath }) => filePath));
        this.recordCanonicalInvalidations(updates, canonical);
    }
    /**
     * Records host-reported changes for incremental emit and drops what deleted files reported.
     * Both are keyed by the paths results carry, so a change is recorded under `canonicalPaths`,
     * the analyzer's form of each update's path, when the engine provides it: hosts may report a
     * path through a symlink (macOS `/tmp`, Bazel output trees) that results never mention.
     */
    recordCanonicalInvalidations(updates, canonicalPaths) {
        const changed = [];
        const deleted = [];
        updates.forEach(({ filePath: hostPath, updateType }, i) => {
            const filePath = canonicalPaths?.[i] ?? hostPath;
            // A resource no component is known to use may still be read during processing (e.g. a
            // stylesheet a template links that could not be read before), so every reusable output is
            // dropped. Sources and config files (a `tsconfig.json` edit is how roots change) are never
            // read that way, and are tracked through the analyzer instead. Whether a reprocessed file
            // is then re-emitted is decided by its output (`IncrementalEmitTracker`), so this costs
            // processing time, not spurious emits.
            if (!isSourceOrConfigFile(filePath) && !this.knownResources.has(filePath)) {
                this.processedFiles.clear();
                for (const knownTs of this.lastChunkByFile.keys()) {
                    this.jsDirtyFiles.add(knownTs);
                }
            }
            for (const [ownerTs, styleFiles] of this.templateStyleUrlsByFile) {
                if (styleFiles.includes(filePath)) {
                    this.processedFiles.delete(ownerTs);
                    this.jsDirtyFiles.add(ownerTs);
                }
            }
            this.invalidateCachedFile(filePath);
            if (updateType === nga.FileUpdateType.Deleted) {
                deleted.push(filePath);
                this.evictRemovedFile(filePath);
            }
            else {
                changed.push(filePath);
            }
        });
        if (this.incrementalEnabled) {
            this.incremental.recordChanges(changed, deleted);
        }
    }
    /**
     * Runs `applyUpdate` and the delta pass that follows it once every earlier update has
     * settled, so the analyzer sees updates one at a time and in call order.
     *
     * The returned promise rejects if this update fails. `pendingCompilation` itself never
     * rejects: a rejected link would skip every later update and make `ensureReady` throw for the
     * rest of the session.
     */
    enqueueUpdate(applyUpdate) {
        const update = this.pendingCompilation.then(() => this.runUpdate(applyUpdate));
        this.pendingCompilation = update.catch(() => { });
        return update;
    }
    async runUpdate(applyUpdate) {
        try {
            const invalidatedTsFiles = await applyUpdate();
            for (const filePath of invalidatedTsFiles) {
                this.invalidateCachedFile(filePath);
            }
            const iterator = this.optimize
                ? this.analyzer.analyzeOptimizedDelta()
                : this.analyzer.analyzeDelta();
            for await (const chunk of iterator) {
                if (chunk.files.length > 0 || (chunk.removedFiles && chunk.removedFiles.length > 0)) {
                    for (const file of chunk.files) {
                        this.invalidateCachedFile(file.filePath);
                    }
                    for (const removed of chunk.removedFiles ?? []) {
                        this.invalidateCachedFile(removed);
                    }
                    this.pendingDeltaChunks.push(chunk);
                }
            }
        }
        catch (error) {
            // A failed update may stop partway through, so there's no telling which cached analyses are
            // stale. Drop them all.
            this.fileCache.clear();
            this.metadataByFile.clear();
            this.pendingDeltaChunks.length = 0;
            throw error;
        }
    }
    analyze() {
        return this.fullAsync(this.analyzer.analyze());
    }
    analyzeOptimized() {
        return this.fullAsync(this.analyzer.analyzeOptimized());
    }
    recordFullChunk(chunk) {
        for (const file of chunk.files) {
            this.recordMetadata(file);
            this.lastChunkByFile.set(file.filePath, chunk);
        }
    }
    async *fullAsync(chunks) {
        this.jsDirtyFiles.clear();
        this.pendingDeltaChunks.length = 0;
        for await (const chunk of chunks) {
            this.recordFullChunk(chunk);
            yield chunk;
        }
    }
    recordDeltaChunk(chunk, yieldedFiles) {
        if (chunk.removedFiles && chunk.removedFiles.length > 0) {
            for (const removed of chunk.removedFiles) {
                this.evictRemovedFile(removed);
            }
            if (this.incrementalEnabled) {
                this.incremental.recordChanges([], chunk.removedFiles);
            }
        }
        for (const file of chunk.files) {
            yieldedFiles.add(file.filePath);
            this.recordMetadata(file);
            this.lastChunkByFile.set(file.filePath, chunk);
        }
        return chunk.files.length > 0 || Boolean(chunk.removedFiles && chunk.removedFiles.length > 0);
    }
    *drainJsDirtyChunks(yieldedFiles) {
        while (this.jsDirtyFiles.size > 0) {
            const dirtyFile = this.jsDirtyFiles.values().next().value;
            this.jsDirtyFiles.delete(dirtyFile);
            if (yieldedFiles.has(dirtyFile)) {
                continue;
            }
            const prevChunk = this.lastChunkByFile.get(dirtyFile);
            if (!prevChunk) {
                continue;
            }
            const refreshedFiles = prevChunk.files.map((f) => this.metadataByFile.get(f.filePath) ?? f);
            const refreshedChunk = {
                files: refreshedFiles,
                staticEdges: prevChunk.staticEdges,
            };
            for (const f of refreshedFiles) {
                yieldedFiles.add(f.filePath);
                this.lastChunkByFile.set(f.filePath, refreshedChunk);
            }
            yield refreshedChunk;
        }
    }
    analyzeDelta() {
        return this.deltaAsync(this.analyzer.analyzeDelta());
    }
    analyzeOptimizedDelta() {
        return this.deltaAsync(this.analyzer.analyzeOptimizedDelta());
    }
    async *deltaAsync(chunks) {
        const yieldedFiles = new Set();
        for (const chunk of this.pendingDeltaChunks.splice(0)) {
            if (this.recordDeltaChunk(chunk, yieldedFiles)) {
                yield chunk;
            }
        }
        for await (const chunk of chunks) {
            if (this.recordDeltaChunk(chunk, yieldedFiles)) {
                yield chunk;
            }
        }
        yield* this.drainJsDirtyChunks(yieldedFiles);
    }
    beginCompilationPass() {
        const useDelta = this.hasCompiled && this.incrementalEnabled;
        if (!useDelta) {
            this.currentProcessedFiles.clear();
            this.currentProcessErrors.clear();
            if (!this.incrementalEnabled) {
                this.fileCache.clear();
                this.metadataByFile.clear();
                this.lastChunkByFile.clear();
                this.processedFiles.clear();
                this.analysisDiagnosticsBySource.clear();
                this.processedDiagnosticsBySource.clear();
                this.diagnosticsMap.clear();
            }
        }
        return { useDelta, useOptimized: this.optimize && !this.emitDeclarationOnly };
    }
    /**
     * Runs an initial or incremental delta compilation pass, preparing and processing only the
     * chunks affected since the previous build (or all chunks on the initial build / when
     * `incremental` is `false`), and returns the full map of current `ProcessedFile`s across the
     * program.
     */
    async compile(options) {
        const { useDelta, useOptimized } = this.beginCompilationPass();
        const chunks = useDelta
            ? useOptimized
                ? this.analyzeOptimizedDelta()
                : this.analyzeDelta()
            : useOptimized
                ? this.analyzeOptimized()
                : this.analyze();
        for await (const chunk of chunks) {
            if (chunk.files.length === 0) {
                this.recordChunkDiagnostics(chunk);
                continue;
            }
            const chunkContext = await this.prepareChunk(chunk);
            for (const fileResult of chunk.files) {
                const filePath = fileResult.filePath;
                const content = options?.readFile
                    ? options.readFile(filePath)
                    : (this.fileCache.get(filePath)?.sourceContent ??
                        (await this.analyzer.getFileContent(filePath)));
                if (content === undefined) {
                    this.currentProcessedFiles.delete(filePath);
                    continue;
                }
                try {
                    const processed = await this.processFile(filePath, content, fileResult, chunkContext);
                    this.currentProcessedFiles.set(filePath, processed);
                    this.currentProcessErrors.delete(filePath);
                }
                catch (e) {
                    this.currentProcessedFiles.delete(filePath);
                    this.currentProcessErrors.set(filePath, e instanceof Error ? e.message : String(e));
                }
            }
        }
        this.hasCompiled = true;
        return this.currentProcessedFiles;
    }
    /**
     * Returns a predicate `(filePath: string) => boolean` for `ts.Program.emit` that decides whether
     * `filePath` must be emitted in the current build. When `incremental` is `false`, every file is
     * emitted.
     */
    createEmitFilter() {
        if (!this.incrementalEnabled) {
            return () => true;
        }
        return this.incremental.createEmitFilter();
    }
    /** Records the source files whose `.js`/`.d.ts` outputs were emitted in the current build. */
    recordSuccessfulEmit(emittedFiles) {
        if (!this.incrementalEnabled) {
            return;
        }
        this.incremental.recordSuccessfulEmit(emittedFiles);
    }
    /** Returns the latest cached `AnalysisResult` for `filePath`, or queries the analyzer if needed. */
    async getCachedMetadata(filePath) {
        return this.metadataByFile.get(filePath) ?? (await this.analyzer.getMetadataForFile(filePath));
    }
    async getTcbForFile(filePath) {
        return (await this.ensureTcb(filePath)).tcb || null;
    }
    hasTcbCandidates(classes) {
        return classes.some((c) => Boolean(c.className) &&
            ((c.component !== undefined && !c.component.isJit) ||
                (c.directive !== undefined &&
                    !c.directive.isJit &&
                    this.tcbConfig.typeCheckHostBindings !== false &&
                    (c.directive.hostProperties.length > 0 ||
                        c.hostBindings.length > 0 ||
                        c.hostListeners.length > 0))));
    }
    prepareFileAnalysisForBinding(result, content, knownMetadata) {
        const normalized = result.filePath;
        this.recordMetadata(result);
        const fileAnalysis = getOrCreateFileAnalysis(this.fileCache, normalized);
        if (!this.hasTcbCandidates(result.classes)) {
            fileAnalysis.parsedTemplates.clear();
            fileAnalysis.preparedTcbData = null;
            fileAnalysis.tcb = null;
            fileAnalysis.boundFingerprint = undefined;
            return {
                fileAnalysis,
                effectiveContent: content,
                boundFingerprint: undefined,
                reuseExisting: true,
            };
        }
        const effectiveContent = content ?? fileAnalysis.sourceContent;
        const boundFingerprint = effectiveContent !== undefined
            ? this.computeBoundFingerprint(normalized, effectiveContent, result, knownMetadata)
            : undefined;
        if (fileAnalysis.preparedTcbData !== undefined &&
            boundFingerprint !== undefined &&
            fileAnalysis.boundFingerprint === boundFingerprint) {
            return { fileAnalysis, effectiveContent, boundFingerprint, reuseExisting: true };
        }
        if (fileAnalysis.boundFingerprint !== undefined &&
            fileAnalysis.boundFingerprint !== boundFingerprint) {
            fileAnalysis.parsedTemplates.clear();
            fileAnalysis.preparedTcbData = undefined;
            fileAnalysis.tcb = undefined;
        }
        return { fileAnalysis, effectiveContent, boundFingerprint, reuseExisting: false };
    }
    /**
     * Asynchronously ensures that the targets for the given file are bound.
     * This is used in sidecar/async mode to avoid blocking CPU tasks.
     */
    async ensureBound(filePath) {
        const cached = this.fileCache.get(filePath);
        if (cached && cached.preparedTcbData !== undefined && this.metadataByFile.has(filePath)) {
            return cached;
        }
        const result = await this.getCachedMetadata(filePath);
        if (!result) {
            return unanalyzedFile(filePath);
        }
        return this.ensureBoundWithMetadata(result);
    }
    /** Asynchronously binds template targets using a pre-fetched `AnalysisResult`. */
    async ensureBoundWithMetadata(result, content, knownMetadata) {
        const { fileAnalysis, effectiveContent, boundFingerprint, reuseExisting } = this.prepareFileAnalysisForBinding(result, content, knownMetadata);
        if (reuseExisting) {
            return fileAnalysis;
        }
        const fileContent = effectiveContent !== undefined
            ? effectiveContent
            : await this.analyzer.getFileContent(result.filePath);
        // Binding is synchronous; read the templates of dependencies declared in other files here,
        // where the analyzer can be awaited (the sidecar analyzer has no synchronous lookups).
        const dependencyTemplates = this.dependencyTemplates(knownMetadata);
        await dependencyTemplates.prefetch(result, (metadata) => this.recordMetadata(metadata));
        const finalFingerprint = boundFingerprint ??
            this.computeBoundFingerprint(result.filePath, fileContent, result, knownMetadata);
        return this.populateBoundData(result.filePath, fileAnalysis, result, fileContent, dependencyTemplates, finalFingerprint);
    }
    dependencyTemplates(knownMetadata) {
        return new DependencyTemplates(this.analyzer, this.fileCache, this.templateParseOptions, knownMetadata, this.tracer);
    }
    computeBoundFingerprint(filePath, content, result, knownMetadata) {
        if (content === undefined || !this.incrementalEnabled) {
            return undefined;
        }
        const pieces = [
            content,
            this.serializeCached(result),
            this.serializeCached(this.tcbConfig),
            this.serializeCached(this.templateParseOptions),
        ];
        for (const cls of result.classes) {
            if (!cls.className || !cls.component) {
                continue;
            }
            const depInputs = this.dependencyTemplateInputs(filePath, cls.component, knownMetadata);
            if (depInputs === null) {
                return undefined;
            }
            pieces.push(...depInputs);
        }
        return fingerprintOf(pieces);
    }
    /**
     * Helper that populates template parsing options and runs template target binding.
     */
    populateBoundData(filePath, fileAnalysis, result, content, dependencyTemplates, boundFingerprint) {
        const templatesByClass = fileAnalysis.parsedTemplates;
        const tcbTargets = buildTcbTargets(filePath, content, result.classes, templatesByClass, this.templateParseOptions, this.tcbConfig, dependencyTemplates, this.tracer);
        const prepared = this.tracer.slice(SpanKind.PrepareTcbTargets, () => prepareTcbTargets(filePath, tcbTargets, content, this.tcbConfig, result.classes, this.tracer));
        if (prepared) {
            fileAnalysis.preparedTcbData = prepared;
        }
        else {
            fileAnalysis.preparedTcbData = null;
        }
        fileAnalysis.sourceContent = content;
        fileAnalysis.boundFingerprint = boundFingerprint;
        return fileAnalysis;
    }
    /** Generates and caches the Type Check Block (TCB) for `filePath` on demand. */
    async ensureTcb(filePath) {
        const fileAnalysis = await this.ensureBound(filePath);
        if (fileAnalysis.tcb !== undefined) {
            return fileAnalysis;
        }
        if (!this.optimize || !fileAnalysis.preparedTcbData) {
            fileAnalysis.tcb = null;
            return fileAnalysis;
        }
        const normPath = fileAnalysis.filePath;
        const result = await this.getCachedMetadata(normPath);
        if (!result) {
            fileAnalysis.tcb = null;
            return fileAnalysis;
        }
        const tcbResult = generateTcbCode(normPath, fileAnalysis.preparedTcbData, this.tcbConfig, result.namespaceAliasConflicts);
        if (!tcbResult) {
            fileAnalysis.tcb = null;
            return fileAnalysis;
        }
        let inlineTcbInfo = { sourceContent: '', classes: [] };
        if (tcbResult.isInline) {
            const content = fileAnalysis.sourceContent ?? (await this.analyzer.getFileContent(normPath));
            inlineTcbInfo = {
                sourceContent: content,
                classes: result.classes,
            };
        }
        const tcbCode = combineTcbContent(tcbResult, normPath, inlineTcbInfo);
        fileAnalysis.tcb = tcbCode;
        return fileAnalysis;
    }
    async getParsedTemplate(filePath, classKey) {
        const parsed = (await this.ensureBound(filePath)).parsedTemplates.get(classKey);
        return parsed ? { ...parsed, nodes: parsed.diagNodes } : null;
    }
    async getHostElement(filePath, classKey) {
        return ((await this.ensureBound(filePath)).preparedTcbData?.hostElementsMap.get(classKey) ?? null);
    }
    async getTypeCheckIdMap(filePath) {
        return (await this.ensureBound(filePath)).preparedTcbData?.typeCheckIdMap ?? null;
    }
    async getClassMetadata(filePath) {
        return this.analyzer.getMetadataForFile(filePath);
    }
    /** `fileId` is the file's trace id from `Tracer.newFileId`, or 0 when untraced. */
    async processFile(filePath, content, metadata, chunkContext, fileId = 0) {
        const result = metadata || (await this.analyzer.getMetadataForFile(filePath));
        if (result) {
            this.recordMetadata(result);
        }
        const normPath = result ? result.filePath : filePath;
        let processed;
        try {
            const boundFingerprint = result
                ? this.computeBoundFingerprint(normPath, content, result, chunkContext?.metadataMap)
                : undefined;
            const fingerprint = this.processingFingerprint(normPath, result, chunkContext, boundFingerprint);
            const reused = this.reusableOutput(normPath, fingerprint);
            if (!reused && result) {
                this.invalidateStaleFileAnalysis(normPath, content, boundFingerprint, chunkContext);
            }
            processed = reused
                ? this.adoptReused(normPath, reused)
                : this.rememberProcessed(normPath, fingerprint, await processFile(this, normPath, content, result || undefined, chunkContext, fileId));
            this.recordProcessedDiagnostics(normPath, processed);
            return processed;
        }
        catch (e) {
            this.processedFiles.delete(normPath);
            throw e;
        }
        finally {
            this.recordForIncrementalEmit(result, chunkContext, processed);
        }
    }
    invalidateStaleFileAnalysis(filePath, content, nextFingerprint, chunkContext) {
        const existing = this.fileCache.get(filePath);
        if (!existing) {
            return;
        }
        // Without incremental compilation the binding has no fingerprint to be validated against.
        // `prepareChunk` binds the files of a chunk afresh, but outside of a chunk the cached binding
        // may predate a change to a dependency's metadata, so it can't be trusted.
        const unverifiable = !this.incrementalEnabled && chunkContext === undefined;
        if (unverifiable ||
            existing.sourceContent !== content ||
            (existing.boundFingerprint !== undefined && existing.boundFingerprint !== nextFingerprint)) {
            existing.parsedTemplates.clear();
            existing.preparedTcbData = undefined;
            existing.tcb = undefined;
        }
        existing.boundFingerprint = nextFingerprint;
        existing.sourceContent = content;
    }
    /**
     * The output `filePath` can reuse instead of being processed, if any. In verification mode
     * there is none, but the would-be reused output is kept so `rememberProcessed` can compare it
     * with what processing actually produces.
     */
    reusableOutput(filePath, fingerprint) {
        const reused = fingerprint !== null ? this.processedFiles.get(filePath, fingerprint) : undefined;
        if (reused !== undefined && this.verifyReusedProcessedFiles) {
            this.pendingVerification.set(filePath, reused);
            return undefined;
        }
        return reused;
    }
    /** Repeats what processing `filePath` does besides returning its output. */
    adoptReused(filePath, reused) {
        this.tracer.count(Counter.FilesReused);
        if (reused.tcb) {
            getOrCreateFileAnalysis(this.fileCache, filePath).tcb = reused.tcb.code;
        }
        return reused;
    }
    rememberProcessed(filePath, fingerprint, processed) {
        const reusable = this.pendingVerification.get(filePath);
        if (reusable !== undefined) {
            this.pendingVerification.delete(filePath);
            assertSameProcessedOutput(filePath, reusable, processed);
        }
        if (processed.referencedStyleFiles && processed.referencedStyleFiles.length > 0) {
            this.templateStyleUrlsByFile.set(filePath, processed.referencedStyleFiles);
            for (const styleFile of processed.referencedStyleFiles) {
                this.knownResources.add(styleFile);
            }
        }
        else {
            this.templateStyleUrlsByFile.delete(filePath);
        }
        if (fingerprint === null) {
            this.processedFiles.delete(filePath);
        }
        else {
            this.processedFiles.set(filePath, fingerprint, processed);
        }
        return processed;
    }
    /**
     * Fingerprints everything processing `filePath` reads besides the compiler's own options, or
     * `null` when the output must not be reused:
     *
     * - `boundFingerprint`, which covers the file's content, `AnalysisResult` (including external
     *   templates/styles and resolved dependencies), `tcbConfig`, `templateParseOptions`, and the
     *   `<ng-content>` tags of the cross-file component templates read for `ngContentSelectors`;
     * - from the chunk: whether each of its components is remotely scoped, and for each of its
     *   NgModules, which components it remotely scopes with which dependencies.
     *
     * Stylesheets a template links (`<link rel="stylesheet">`) are read during processing and are
     * not fingerprinted; a change to a non-TS file that is no known resource drops every reusable
     * output instead (see `recordCanonicalInvalidations`).
     */
    processingFingerprint(filePath, result, chunkContext, boundFingerprint) {
        if (!this.reuseProcessedFiles || !result || boundFingerprint === undefined) {
            return null;
        }
        const pieces = [boundFingerprint];
        const remoteScoped = chunkContext?.remoteScopedClasses;
        for (const cls of result.classes) {
            if (!cls.className) {
                continue;
            }
            if (cls.component) {
                pieces.push(`remote:${remoteScoped?.has(`${filePath}#${cls.className}`) ?? false}`);
            }
            if (cls.ngModule) {
                pieces.push(...remoteScopeInputs(filePath, cls, chunkContext));
            }
        }
        return pieces.length === 1 ? boundFingerprint : fingerprintOf(pieces);
    }
    /**
     * What `DependencyTemplates` would read off the cross-file component dependencies of
     * `component` (the `<ng-content>` tags of their templates, see `ngContentSignature`), or `null`
     * if one of them can't be read.
     */
    dependencyTemplateInputs(filePath, component, knownMetadata) {
        const inputs = [];
        const declarations = [
            ...(component.resolvedDeclarations ?? []),
            ...(component.resolvedDeferredDeclarations ?? []),
            ...Object.values(component.resolvedDeferredDeclarationsByBlock ?? {}).flat(),
        ];
        for (const decl of declarations) {
            if (decl.declarationType !== 'component' ||
                decl.ngContentSelectors != null ||
                !decl.filePath ||
                decl.filePath === filePath) {
                continue;
            }
            const metadata = knownMetadata?.get(decl.filePath) ?? this.metadataByFile.get(decl.filePath);
            if (metadata === undefined) {
                return null;
            }
            const declaring = metadata?.classes.find((c) => c.className === decl.name && c.nameSpan?.start === decl.nameSpan.start);
            inputs.push(`dep:${decl.filePath}#${decl.name}`, declaring?.component ? this.ngContentSignatureOf(declaring.component) : 'null');
        }
        return inputs;
    }
    serializeCached(value) {
        if (value === null || value === undefined) {
            return 'null';
        }
        let cached = this.serializedObjects.get(value);
        if (cached === undefined) {
            cached = JSON.stringify(value);
            this.serializedObjects.set(value, cached);
        }
        return cached;
    }
    /** `ngContentSignature` of `component`'s template, computed once per metadata object. */
    ngContentSignatureOf(component) {
        let cached = this.ngContentSignatures.get(component);
        if (cached === undefined) {
            cached = ngContentSignature(component.template ?? '');
            this.ngContentSignatures.set(component, cached);
        }
        return cached;
    }
    /**
     * Records what `result` contributes to incremental re-emit decisions. Runs even when processing
     * throws (`processed` is `undefined` then), so the file's previous semantics never outlive it.
     */
    recordForIncrementalEmit(result, chunkContext, processed) {
        if (!this.incrementalEnabled || !result) {
            return;
        }
        this.incremental.recordFile(result, this.fileCache.get(result.filePath)?.preparedTcbData?.boundTargetMap, chunkContext?.remoteScopedClasses, this.templateStyleUrlsByFile.get(result.filePath), processed);
    }
    recordProcessedDiagnostics(normPath, processed) {
        this.replaceDiagnostics(this.processedDiagnosticsBySource, normPath, (processed.diagnostics ?? []).map((diag) => ({
            target: diag.filePath || normPath,
            diag: withErrorGuide(diag),
        })));
    }
    async emitHmrUpdateModule(filePath, className) {
        if (!this.enableHmr) {
            return null;
        }
        const result = await this.analyzer.getMetadataForFile(filePath);
        if (!result) {
            return null;
        }
        const content = await this.analyzer.getFileContent(result.filePath);
        const processed = await processFile({ ...this, hmrUpdateTarget: className }, result.filePath, content, result);
        return processed.hmrUpdateModule ?? null;
    }
    async getBoundTarget(filePath, classKey) {
        return (await this.ensureBound(filePath)).preparedTcbData?.boundTargetMap.get(classKey) || null;
    }
    async getIndexedComponents() {
        // Drain any remaining items from the analyzer queue first.
        const iterator = this.optimize ? this.analyzer.analyzeOptimized() : this.analyzer.analyze();
        for await (const chunk of iterator) {
            for (const result of chunk.files) {
                await this.ensureBoundWithMetadata(result);
            }
        }
        return getIndexedComponents(this);
    }
    async getTsFileForTemplate(templatePath) {
        const res = await this.analyzer.getTsFileForTemplate(templatePath);
        return res?.[0] ?? null;
    }
    async getFileContent(filePath) {
        return this.analyzer.getFileContent(filePath);
    }
}
/** The chunk's files keyed by path, as `ChunkContext.metadataMap`. */
function chunkMetadataMap(chunk) {
    const metadataMap = new Map();
    for (const file of chunk.files) {
        metadataMap.set(file.filePath, file);
    }
    return metadataMap;
}
/** Uncached empty analysis for a file the analyzer has no metadata for. */
function unanalyzedFile(filePath) {
    return { filePath, parsedTemplates: new Map(), preparedTcbData: null };
}
export function hasGraphPath(graph, start, target) {
    if (start === target)
        return true;
    const visited = new Set([start]);
    const stack = [start];
    while (stack.length > 0) {
        const current = stack.pop();
        const neighbors = graph.get(current);
        if (!neighbors)
            continue;
        for (const neighbor of neighbors) {
            if (neighbor === target)
                return true;
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                stack.push(neighbor);
            }
        }
    }
    return false;
}
export function findCyclicNodes(graph) {
    const cyclic = new Set();
    const index = new Map();
    const lowLink = new Map();
    const onStack = new Set();
    const stack = [];
    let nextIndex = 0;
    for (const root of graph.keys()) {
        if (index.has(root)) {
            continue;
        }
        const frames = [];
        const enter = (node) => {
            index.set(node, nextIndex);
            lowLink.set(node, nextIndex);
            nextIndex++;
            stack.push(node);
            onStack.add(node);
            frames.push({ node, edges: (graph.get(node) ?? new Set())[Symbol.iterator]() });
        };
        enter(root);
        while (frames.length > 0) {
            const frame = frames[frames.length - 1];
            const step = frame.edges.next();
            if (!step.done) {
                const neighbor = step.value;
                if (neighbor === frame.node) {
                    // A one-node cycle, which an SCC of size one cannot express.
                    cyclic.add(neighbor);
                }
                else if (!index.has(neighbor)) {
                    enter(neighbor);
                }
                else if (onStack.has(neighbor)) {
                    lowLink.set(frame.node, Math.min(lowLink.get(frame.node), index.get(neighbor)));
                }
                continue;
            }
            frames.pop();
            const caller = frames[frames.length - 1];
            if (caller !== undefined) {
                lowLink.set(caller.node, Math.min(lowLink.get(caller.node), lowLink.get(frame.node)));
            }
            if (lowLink.get(frame.node) !== index.get(frame.node)) {
                continue;
            }
            // The node roots a strongly connected component: itself and everything stacked above it.
            const component = [];
            for (;;) {
                const member = stack.pop();
                onStack.delete(member);
                component.push(member);
                if (member === frame.node) {
                    break;
                }
            }
            if (component.length > 1) {
                for (const member of component) {
                    cyclic.add(member);
                }
            }
        }
    }
    return cyclic;
}
function formatSerializedDiagnostic(d) {
    return {
        filePath: d.filePath,
        category: d.category === 1 ? 'error' : 'warning',
        code: d.code,
        messageText: flattenNgDiagnosticMessage(d),
        span: d.span,
        ...(d.relatedInformation && d.relatedInformation.length > 0
            ? { relatedInformation: d.relatedInformation }
            : {}),
    };
}
/**
 * What processing the NgModule `ngModule` of `filePath` reads from the chunk: the components of
 * the chunk it declares, whether each is remotely scoped, and the dependencies it would scope
 * them with (`ɵɵsetComponentScope`).
 */
function remoteScopeInputs(filePath, ngModule, chunkContext) {
    const inputs = [];
    for (const [declaringPath, fileMeta] of chunkContext?.metadataMap ?? []) {
        for (const cls of fileMeta.classes) {
            const owner = cls.component?.declaringNgModule;
            if (!cls.className || owner?.filePath !== filePath || owner.symbolId !== ngModule.symbolId) {
                continue;
            }
            const key = `${declaringPath}#${cls.className}`;
            inputs.push(`scope:${key}`, String(chunkContext.remoteScopedClasses.has(key)), JSON.stringify(chunkContext.eagerlyUsedDeclarations.get(key) ?? null));
        }
    }
    return inputs;
}
/** Throws unless `fresh`, just produced by processing `filePath`, matches the `reused` output. */
function assertSameProcessedOutput(filePath, reused, fresh) {
    const parts = (processed) => ({
        code: processed.magicString.toString(),
        tcb: processed.tcb?.code ?? null,
        diagnostics: JSON.stringify(processed.diagnostics ?? []),
        hmrUpdateModule: processed.hmrUpdateModule ?? null,
    });
    const expected = parts(fresh);
    const actual = parts(reused);
    const stale = Object.keys(expected).filter((part) => expected[part] !== actual[part]);
    if (stale.length > 0) {
        throw new Error(`The reused processed output of ${filePath} is stale (${stale.join(', ')}): processing ` +
            `read an input its fingerprint does not cover.`);
    }
}
