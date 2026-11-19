/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import { MatchSource } from '@angular/compiler';
import { makeClassKey } from './compiler-utils.js';
import { fingerprintOf } from './processed_file_cache.js';
/**
 * Decides which files an incremental build has to re-emit, mirroring ngtsc's
 * `IncrementalCompilation` and `SemanticDepGraphUpdater`.
 *
 * Files are compared against the state of the last build whose output was emitted (the
 * *baseline*), not against the previous build, so changes made while the program was broken are
 * still emitted once it is fixed. A file is re-emitted when:
 *
 * - it changed since the baseline, or one of its dependencies or resources did
 *   (ngtsc: logically changed files);
 * - its processed output differs from the baseline's, whatever caused that;
 * - it is a component whose template dependencies, or their public API, changed, or which
 *   entered or left remote scoping (`ComponentSymbol.isEmitAffected`);
 * - it declares an NgModule whose set of remotely scoped components, or their dependencies,
 *   changed (`NgModuleSymbol.isEmitAffected`);
 * - it has not been emitted since the baseline (ngtsc's `priorState.emitted`).
 */
export class IncrementalEmitTracker {
    /** Semantics of every file as last processed. */
    current = new Map();
    /** `current` as of the last successful emit; `null` until then, or after a full invalidation. */
    baseline = null;
    /** Files whose output is up to date as of the baseline. */
    emitted = new Set();
    /** Source files and resources changed or deleted since the baseline. */
    changedSinceBaseline = new Set();
    /** Output fingerprints by `ProcessedFile`, so a reused output is not fingerprinted again. */
    outputFingerprints = new WeakMap();
    /**
     * Records that `paths` changed or were deleted. A change is a change even when the content is
     * identical, as with ngtsc, which compares source file identity rather than content.
     */
    recordChanges(changed, deleted = []) {
        for (const path of changed) {
            this.recordChange(path);
        }
        for (const path of deleted) {
            this.recordChange(path);
            this.current.delete(path);
            this.emitted.delete(path);
        }
    }
    recordChange(path) {
        // ngtsc starts a fresh compilation whenever a declaration file changes, as the change may
        // affect anything that consumes it (`IncrementalCompilation.incremental`).
        if (path.endsWith('.d.ts')) {
            this.baseline = null;
            this.emitted.clear();
        }
        this.changedSinceBaseline.add(path);
    }
    /**
     * Records the semantics of `result` as just processed, replacing what was recorded before.
     * `processed` is the file's output, or `undefined` if processing it failed.
     */
    recordFile(result, boundTargets, remoteScopedClasses, extraResources, processed) {
        const filePath = result.filePath;
        const previousFile = this.current.get(filePath);
        const resources = extraResources ? Array.from(extraResources) : [];
        const components = new Map();
        const ngModuleInjectorImports = new Map();
        for (const classMeta of result.classes) {
            if (classMeta.ngModule && classMeta.className) {
                // `ɵinj.imports` interleaves the resolved imports with elements kept verbatim, which an
                // element is when every reference in it survives, so a change can show in either.
                const { injectorImports, injectorImportRawSpans } = classMeta.ngModule;
                ngModuleInjectorImports.set(classMeta.className, JSON.stringify([injectorImports ?? null, injectorImportRawSpans ?? null]));
            }
            const component = classMeta.component;
            if (!component || !classMeta.className) {
                continue;
            }
            if (component.templateUrl) {
                resources.push(component.templateUrl.resolvedPath);
            }
            for (const styleUrl of component.styleUrls ?? []) {
                resources.push(styleUrl.resolvedPath);
            }
            const bound = boundTargets?.get(makeClassKey(classMeta.className, classMeta.span.start));
            const priorComponent = previousFile?.components.get(classMeta.className);
            const declarations = component.resolvedDeclarations ?? [];
            components.set(classMeta.className, {
                usedDirectives: bound
                    ? usedDirectivesOf(bound, declarations, filePath)
                    : (priorComponent?.usedDirectives ?? []),
                usedPipes: bound
                    ? usedPipesOf(bound, declarations, filePath)
                    : (priorComponent?.usedPipes ?? []),
                isRemotelyScoped: remoteScopedClasses?.has(`${filePath}#${classMeta.className}`) ?? false,
                declaringNgModule: component.declaringNgModule
                    ? `${component.declaringNgModule.filePath}#${component.declaringNgModule.symbolId}`
                    : null,
            });
        }
        this.current.set(filePath, {
            dependencies: result.staticDependencies ?? [],
            resources,
            components,
            ngModuleInjectorImports,
            output: processed ? this.outputFingerprintOf(processed) : null,
        });
    }
    outputFingerprintOf(processed) {
        let fingerprint = this.outputFingerprints.get(processed);
        if (fingerprint === undefined) {
            fingerprint = fingerprintOf([processed.magicString.toString()]);
            this.outputFingerprints.set(processed, fingerprint);
        }
        return fingerprint;
    }
    /**
     * Returns whether `filePath` has to be emitted by the current build. Only meaningful once every
     * file of the build has been recorded with `recordFile`.
     */
    createEmitFilter() {
        const baseline = this.baseline;
        if (baseline === null) {
            return () => true;
        }
        const needsEmit = this.determineFilesToReEmit(baseline);
        return (filePath) => !this.emitted.has(filePath) || needsEmit.has(filePath);
    }
    /**
     * Records that the current build's output was emitted, `emittedFiles` being the files written,
     * which makes the current state the baseline of the next build.
     */
    recordSuccessfulEmit(emittedFiles) {
        for (const filePath of emittedFiles) {
            this.emitted.add(filePath);
        }
        this.baseline = new Map(this.current);
        this.changedSinceBaseline.clear();
    }
    determineFilesToReEmit(baseline) {
        const changed = this.changedSinceBaseline;
        const needsEmit = new Set();
        for (const [filePath, semantics] of this.current) {
            const previous = baseline.get(filePath);
            if (changed.has(filePath) ||
                previous === undefined ||
                semantics.output !== previous.output ||
                semantics.dependencies.some((dep) => changed.has(dep)) ||
                previous.dependencies.some((dep) => changed.has(dep)) ||
                semantics.resources.some((resource) => changed.has(resource)) ||
                previous.resources.some((resource) => changed.has(resource)) ||
                isAnyComponentEmitAffected(semantics, previous) ||
                isAnyNgModuleEmitAffected(semantics, previous)) {
                needsEmit.add(filePath);
            }
        }
        const currentScopes = remoteScopesByNgModule(this.current);
        const previousScopes = remoteScopesByNgModule(baseline);
        for (const ngModule of new Set([...currentScopes.keys(), ...previousScopes.keys()])) {
            if (!isRemoteScopeEqual(currentScopes.get(ngModule), previousScopes.get(ngModule))) {
                needsEmit.add(ngModuleFile(ngModule));
            }
        }
        return needsEmit;
    }
}
/**
 * The directives `bound`'s template matches by selector, in scope order. Host directives and the
 * component's own host-element entry are left out: ngtsc reaches host directives through their
 * host, and a component is only in its own `usedDirectives` when its template matches its own
 * selector recursively.
 */
function usedDirectivesOf(bound, declarations, consumerPath) {
    const templateDirectives = bound.getTemplateUsedDirectives?.() ?? bound.getUsedDirectives();
    const used = new Set(templateDirectives
        .filter((dir) => dir.matchSource === MatchSource.Selector)
        .map((dir) => `${dir.ref.nodeFilePath ?? consumerPath}#${dir.name}`));
    if (used.size === 0) {
        return [];
    }
    return declarations
        .filter((decl) => (decl.declarationType === 'directive' || decl.declarationType === 'component') &&
        used.has(`${decl.filePath ?? consumerPath}#${decl.name}`))
        .map((decl) => toUsedDeclaration(decl, consumerPath));
}
/** The pipes `bound`'s template uses, in scope order. */
function usedPipesOf(bound, declarations, consumerPath) {
    const used = new Set(bound.getUsedPipes());
    if (used.size === 0) {
        return [];
    }
    return declarations
        .filter((decl) => decl.declarationType === 'pipe' && !!decl.pipeName && used.has(decl.pipeName))
        .map((decl) => toUsedDeclaration(decl, consumerPath));
}
function toUsedDeclaration(decl, consumerPath) {
    const consumerImport = decl.ref.consumerImport;
    return {
        identity: `${decl.filePath ?? consumerPath}#${decl.name}`,
        importPath: consumerImport ? `${consumerImport.specifier}$${consumerImport.symbol}` : null,
        publicApi: publicApiOf(decl),
    };
}
/**
 * The parts of a declaration whose change requires the components using it to be re-emitted,
 * mirroring `DirectiveSymbol.isPublicApiAffected` and `PipeSymbol.isPublicApiAffected`.
 *
 * A directive and a component share a public API (ngtsc lets one turn into the other without
 * affecting it), and neither whether an input is required, whether it is a signal, nor the class
 * property behind a binding is part of it: those only affect type-checking.
 */
function publicApiOf(decl) {
    if (decl.declarationType === 'pipe') {
        return JSON.stringify(['pipe', decl.pipeName ?? null]);
    }
    const inputs = new Set();
    const outputs = new Set();
    for (const field of decl.flattenedFields ?? decl.fields ?? []) {
        if (field.input) {
            inputs.add(field.input.alias || field.input.name);
        }
        if (field.output) {
            outputs.add(field.output.alias || field.output.name);
        }
    }
    return JSON.stringify([
        'directive',
        decl.selector ?? null,
        Array.from(inputs),
        Array.from(outputs),
        decl.exportAs ?? null,
    ]);
}
/** `ComponentSymbol.isEmitAffected` for every component in a file. */
function isAnyComponentEmitAffected(semantics, previous) {
    for (const [className, component] of semantics.components) {
        const prior = previous?.components.get(className);
        if (prior === undefined ||
            component.isRemotelyScoped !== prior.isRemotelyScoped ||
            !areUsedDeclarationsEqual(component.usedDirectives, prior.usedDirectives) ||
            !areUsedDeclarationsEqual(component.usedPipes, prior.usedPipes)) {
            return true;
        }
    }
    return false;
}
/**
 * Whether an NgModule in the file has to be re-emitted because its injector imports changed. ngtsc
 * re-emits an NgModule when the provider status of anything its imported standalone components
 * bring in changes (`transitiveImportsFromStandaloneComponents` in `NgModuleSymbol`), as that
 * decides which of them its injector imports. The analyzer resolves those imports, so this
 * compares the outcome rather than the inputs.
 */
function isAnyNgModuleEmitAffected(semantics, previous) {
    for (const [className, injectorImports] of semantics.ngModuleInjectorImports) {
        if (previous?.ngModuleInjectorImports.get(className) !== injectorImports) {
            return true;
        }
    }
    return false;
}
/**
 * Order matters, as it may affect directive instantiation order. A dependency whose public API
 * changed counts as changed (ngtsc's `isSymbolUnaffected`).
 */
function areUsedDeclarationsEqual(current, previous) {
    return (current.length === previous.length &&
        current.every((decl, i) => decl.identity === previous[i].identity &&
            decl.importPath === previous[i].importPath &&
            decl.publicApi === previous[i].publicApi));
}
/**
 * For each NgModule, the dependencies of the components it remotely scopes, keyed by component.
 * Mirrors `NgModuleSymbol.remotelyScopedComponents`, which records references only: an NgModule
 * names its components' dependencies but emits nothing that depends on their public API.
 */
function remoteScopesByNgModule(files) {
    const scopes = new Map();
    for (const [filePath, semantics] of files) {
        for (const [className, component] of semantics.components) {
            if (!component.isRemotelyScoped || component.declaringNgModule === null) {
                continue;
            }
            let scope = scopes.get(component.declaringNgModule);
            if (scope === undefined) {
                scope = new Map();
                scopes.set(component.declaringNgModule, scope);
            }
            const references = (decls) => decls.map((decl) => [decl.identity, decl.importPath]);
            scope.set(`${filePath}#${className}`, JSON.stringify([references(component.usedDirectives), references(component.usedPipes)]));
        }
    }
    return scopes;
}
function isRemoteScopeEqual(current, previous) {
    if (current === undefined || previous === undefined) {
        return current === previous;
    }
    if (current.size !== previous.size) {
        return false;
    }
    for (const [component, dependencies] of current) {
        if (previous.get(component) !== dependencies) {
            return false;
        }
    }
    return true;
}
/** The file declaring the NgModule a `filePath#symbolId` key refers to. */
function ngModuleFile(ngModuleKey) {
    return ngModuleKey.slice(0, ngModuleKey.lastIndexOf('#'));
}
