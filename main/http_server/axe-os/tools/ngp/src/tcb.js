/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import { generateTypeCheckBlock, isUnsafeObjectKey, R3Identifiers, TcbExpr, } from '@angular/compiler';
import { RegistryDomSchemaChecker } from './dom_schema_checker.js';
import { runExtendedDiagnostics } from './extended_diagnostics.js';
import MagicString from 'magic-string';
import { makeClassKey } from './compiler-utils.js';
import { OutOfBandDiagnosticRecorderImpl } from './oob.js';
import { allocateNamespaceAlias } from './output_ast_printer.js';
import { NOOP_TRACER } from './perf.js';
import { adaptTcbInput } from './tcb_adapter.js';
import { requiresInlineDeclaration, requiresInlineTypeCheckBlock } from './tcb_util.js';
import { getTemplateSemanticsDiagnostics } from './template_semantics.js';
/**
 * Prefix of the block comment appended to a generated `.ngtypecheck.ts` file, followed by the JSON
 * of `TcbResult.templateSources`. It lets tools that only see the type-check file (e.g. a
 * TypeScript compiler plugin, or a TypeScript 7 compilation outside of this process) map TCB
 * diagnostics back to template locations. It is omitted if `templateSources` is empty.
 */
export const TCB_TEMPLATE_SOURCES_COMMENT_PREFIX = 'ngp-tcb-template-sources:';
function getTcbTemplateSource(component) {
    if (!component) {
        return null;
    }
    // Same classification as the processor's `templateDiagnosticLocation`.
    if (component.templateUrl != null) {
        return {
            ...(component.className ? { className: component.className } : {}),
            templateFile: component.templateUrl.resolvedPath,
            ...(component.templateUrlSpan
                ? {
                    templateUrlExpression: {
                        start: component.templateUrlSpan.start,
                        end: component.templateUrlSpan.end,
                    },
                }
                : {}),
        };
    }
    const expressionSpan = component.templateSpan;
    if (component.templateContentSpan != null || expressionSpan == null) {
        return null;
    }
    return {
        ...(component.className ? { className: component.className } : {}),
        templateExpression: { start: expressionSpan.start, end: expressionSpan.end },
    };
}
function serializeTcbTemplateSources(templateSources) {
    if (Object.keys(templateSources).length === 0) {
        return '';
    }
    // `*/` would terminate the comment; `\/` is an equivalent JSON escape of `/`.
    const json = JSON.stringify(templateSources).split('*/').join('*\\/');
    return `\n/*${TCB_TEMPLATE_SOURCES_COMMENT_PREFIX}${json}*/\n`;
}
export function buildTypeCheckingConfig(options = {}, enableTemplateTypeChecker = false, usePoisonedData = false) {
    enableTemplateTypeChecker =
        enableTemplateTypeChecker || Boolean(options._enableTemplateTypeChecker);
    const strictTemplates = options.strictTemplates !== false;
    let typeCheckingConfig;
    if (strictTemplates) {
        typeCheckingConfig = {
            applyTemplateContextGuards: true,
            checkTemplateBodies: true,
            alwaysCheckSchemaInTemplateBodies: true,
            checkTypeOfInputBindings: true,
            honorAccessModifiersForInputBindings: false,
            checkControlFlowBodies: true,
            strictNullInputBindings: true,
            checkTypeOfAttributes: true,
            checkTypeOfDomBindings: false,
            checkTypeOfOutputEvents: true,
            checkTypeOfAnimationEvents: true,
            checkTypeOfDomEvents: true,
            checkTypeOfDomReferences: true,
            checkTypeOfNonDomReferences: true,
            checkTypeOfPipes: true,
            strictSafeNavigationTypes: true,
            useContextGenericType: true,
            strictLiteralTypes: true,
            enableTemplateTypeChecker,
            useInlineTypeConstructors: false,
            controlFlowPreventingContentProjection: options.extendedDiagnostics?.checks?.controlFlowPreventingContentProjection ??
                options.extendedDiagnostics?.defaultCategory ??
                'warning',
            unusedStandaloneImports: options.unusedStandaloneImports ??
                options.extendedDiagnostics?.checks?.unusedStandaloneImports ??
                options.extendedDiagnostics?.defaultCategory ??
                'warning',
            // These are actually set via version check in ngtsc (ngtsc/core/src/compiler.ts).
            // Since we don't have any of that here we just default to true.
            allowSignalsInTwoWayBindings: true,
            allowDomEventAssertion: true,
            checkUnclaimedEventNames: false,
            checkUnknownElements: false,
            checkTypeOfNgTemplateBindings: false,
        };
    }
    else {
        typeCheckingConfig = {
            applyTemplateContextGuards: false,
            checkTemplateBodies: false,
            checkControlFlowBodies: false,
            alwaysCheckSchemaInTemplateBodies: !!options.annotateForClosureCompiler,
            checkTypeOfInputBindings: false,
            strictNullInputBindings: false,
            honorAccessModifiersForInputBindings: false,
            checkTypeOfAttributes: false,
            checkTypeOfDomBindings: false,
            checkTypeOfOutputEvents: false,
            checkTypeOfAnimationEvents: false,
            checkTypeOfDomEvents: false,
            checkTypeOfDomReferences: false,
            checkTypeOfNonDomReferences: false,
            checkTypeOfPipes: false,
            strictSafeNavigationTypes: false,
            useContextGenericType: false,
            strictLiteralTypes: false,
            enableTemplateTypeChecker,
            useInlineTypeConstructors: false,
            controlFlowPreventingContentProjection: options.extendedDiagnostics?.checks?.controlFlowPreventingContentProjection ??
                options.extendedDiagnostics?.defaultCategory ??
                'warning',
            unusedStandaloneImports: options.unusedStandaloneImports ??
                options.extendedDiagnostics?.checks?.unusedStandaloneImports ??
                options.extendedDiagnostics?.defaultCategory ??
                'warning',
            // These are actually set via version check in ngtsc (ngtsc/core/src/compiler.ts).
            // Since we don't have any of that here we just default to true.
            allowSignalsInTwoWayBindings: true,
            allowDomEventAssertion: true,
            checkUnclaimedEventNames: false,
            checkUnknownElements: false,
            checkTypeOfNgTemplateBindings: false,
        };
    }
    if (options.strictInputTypes !== undefined) {
        typeCheckingConfig.checkTypeOfInputBindings = options.strictInputTypes;
        typeCheckingConfig.applyTemplateContextGuards = options.strictInputTypes;
    }
    if (options.strictInputAccessModifiers !== undefined) {
        typeCheckingConfig.honorAccessModifiersForInputBindings = options.strictInputAccessModifiers;
    }
    if (options.strictNullInputTypes !== undefined) {
        typeCheckingConfig.strictNullInputBindings = options.strictNullInputTypes;
    }
    if (options.strictOutputEventTypes !== undefined) {
        typeCheckingConfig.checkTypeOfOutputEvents = options.strictOutputEventTypes;
        typeCheckingConfig.checkTypeOfAnimationEvents = options.strictOutputEventTypes;
    }
    if (options.strictDomEventTypes !== undefined) {
        typeCheckingConfig.checkTypeOfDomEvents = options.strictDomEventTypes;
    }
    if (options.strictSafeNavigationTypes !== undefined) {
        typeCheckingConfig.strictSafeNavigationTypes = options.strictSafeNavigationTypes;
    }
    if (options.strictDomLocalRefTypes !== undefined) {
        typeCheckingConfig.checkTypeOfDomReferences = options.strictDomLocalRefTypes;
    }
    if (options.strictAttributeTypes !== undefined) {
        typeCheckingConfig.checkTypeOfAttributes = options.strictAttributeTypes;
    }
    if (options.strictContextGenerics !== undefined) {
        typeCheckingConfig.useContextGenericType = options.strictContextGenerics;
    }
    if (options.strictLiteralTypes !== undefined) {
        typeCheckingConfig.strictLiteralTypes = options.strictLiteralTypes;
    }
    if (options.strictUnclaimedEventNames !== undefined) {
        typeCheckingConfig.checkUnclaimedEventNames = options.strictUnclaimedEventNames;
    }
    if (options.strictUnknownElements !== undefined) {
        typeCheckingConfig.checkUnknownElements = options.strictUnknownElements;
    }
    if (options.strictNgTemplateTypes !== undefined) {
        typeCheckingConfig.checkTypeOfNgTemplateBindings = options.strictNgTemplateTypes;
    }
    typeCheckingConfig.typeCheckHostBindings = options.typeCheckHostBindings ?? true;
    typeCheckingConfig.usePoisonedData =
        usePoisonedData || Boolean(options._compilePoisonedComponents);
    typeCheckingConfig.extendedDiagnostics = options.extendedDiagnostics;
    return typeCheckingConfig;
}
function printStatements(expressions) {
    let result = '';
    for (const expr of expressions) {
        result += `${expr.print()};\n`;
    }
    return result;
}
export class TcbImportManager {
    namespaceAliasConflicts;
    imports = new Map();
    nextIndex = 0;
    constructor(namespaceAliasConflicts = new Set()) {
        this.namespaceAliasConflicts = namespaceAliasConflicts;
    }
    addImport(moduleSpecifier) {
        let alias = this.imports.get(moduleSpecifier);
        if (alias === undefined) {
            alias = allocateNamespaceAlias(this.nextIndex++, this.namespaceAliasConflicts);
            this.imports.set(moduleSpecifier, alias);
        }
        return alias;
    }
    generateImportStatements() {
        let result = '';
        for (const [moduleSpecifier, alias] of this.imports) {
            result += `import * as ${alias} from '${moduleSpecifier}';\n`;
        }
        return result;
    }
}
export function qualifyTypeParameters(params, env, defaultModuleSpecifier) {
    if (!params || params.length === 0) {
        return params ? [] : undefined;
    }
    return params.map((param) => {
        const typeRefs = param.typeRefs;
        if (!typeRefs || typeRefs.length === 0) {
            return param;
        }
        // Sort descending by start offset so replacing back-to-front preserves earlier offsets
        const sortedRefs = [...typeRefs].sort((a, b) => (b.span?.start ?? 0) - (a.span?.start ?? 0));
        let representation = param.representation;
        let representationWithDefault = param.representationWithDefault;
        for (const ref of sortedRefs) {
            const mod = ref.moduleSpecifier || defaultModuleSpecifier;
            if (!mod || !ref.span)
                continue;
            const qualified = env.referenceExternalSymbol(mod, ref.symbol).print();
            const { start, end } = ref.span;
            if (start <= representation.length && end <= representation.length) {
                representation = representation.slice(0, start) + qualified + representation.slice(end);
            }
            if (start <= representationWithDefault.length && end <= representationWithDefault.length) {
                representationWithDefault =
                    representationWithDefault.slice(0, start) +
                        qualified +
                        representationWithDefault.slice(end);
            }
        }
        return {
            ...param,
            representation,
            representationWithDefault,
        };
    });
}
function generateGenericArgs(typeParameters) {
    if (typeParameters === undefined || typeParameters.length === 0) {
        return '';
    }
    return `<${typeParameters.map((param) => param.name).join(', ')}>`;
}
function typeParametersWithDefaultTypes(params) {
    if (params === undefined || params.length === 0) {
        return '';
    }
    return `<${params.map((param) => param.representationWithDefault).join(', ')}>`;
}
function constructTypeCtorParameter(env, meta, typeRef, typeRefWithGenerics) {
    let initType = null;
    const plainKeys = [];
    const coercedKeys = [];
    const signalInputKeys = [];
    for (const { classPropertyName, transformType, isSignal } of meta.fields.inputs) {
        if (isSignal) {
            signalInputKeys.push(TcbExpr.quoteAndEscape(classPropertyName));
        }
        else if (!meta.coercedInputFields.has(classPropertyName)) {
            plainKeys.push(TcbExpr.quoteAndEscape(classPropertyName));
        }
        else {
            const propName = `ngAcceptInputType_${classPropertyName}`;
            const isUnsafe = isUnsafeObjectKey(classPropertyName);
            const access = isUnsafe ? `[${TcbExpr.quoteAndEscape(propName)}]` : `.${propName}`;
            const coercionType = transformType !== undefined ? transformType : `typeof ${typeRef}${access}`;
            coercedKeys.push(`${isUnsafe ? TcbExpr.quoteAndEscape(classPropertyName) : classPropertyName}: ${coercionType}`);
        }
    }
    if (plainKeys.length > 0) {
        initType = `Pick<${typeRefWithGenerics}, ${plainKeys.join(' | ')}>`;
    }
    if (coercedKeys.length > 0) {
        let coercedLiteral = '{\n';
        for (const key of coercedKeys) {
            coercedLiteral += `${key};\n`;
        }
        coercedLiteral += '}';
        initType = initType !== null ? `${initType} & ${coercedLiteral}` : coercedLiteral;
    }
    if (signalInputKeys.length > 0) {
        const keyTypeUnion = signalInputKeys.join(' | ');
        const unwrapRef = env.referenceExternalSymbol(R3Identifiers.UnwrapDirectiveSignalInputs.moduleName, R3Identifiers.UnwrapDirectiveSignalInputs.name);
        const unwrapExpr = `${unwrapRef.print()}<${typeRefWithGenerics}, ${keyTypeUnion}>`;
        initType = initType !== null ? `${initType} & ${unwrapExpr}` : unwrapExpr;
    }
    if (initType === null) {
        initType = '{}';
    }
    return `init: ${initType}`;
}
export function generateTypeCtorDeclarationFn(env, meta, nodeTypeRef, typeParams) {
    const typeArgs = generateGenericArgs(typeParams);
    const typeRefWithGenerics = `${nodeTypeRef.print()}${typeArgs}`;
    const initParam = constructTypeCtorParameter(env, meta, nodeTypeRef.print(), typeRefWithGenerics);
    const typeParameters = typeParametersWithDefaultTypes(typeParams);
    let source;
    if (meta.body) {
        const fnType = `${typeParameters}(${initParam}) => ${typeRefWithGenerics}`;
        source = `const ${meta.fnName}: ${fnType} = null!`;
    }
    else {
        source = `declare function ${meta.fnName}${typeParameters}(${initParam}): ${typeRefWithGenerics}`;
    }
    return new TcbExpr(source);
}
export class TcbEnvironmentImpl {
    config;
    importManager;
    isInline;
    nextIds = {
        pipeInst: 1,
        typeCtor: 1,
    };
    typeCtors = new Map();
    typeCtorStatements = [];
    pipeInsts = new Map();
    pipeInstStatements = [];
    constructor(config, importManager, isInline = false) {
        this.config = config;
        this.importManager = importManager;
        this.isInline = isInline;
    }
    referenceTcbValue(ref) {
        if (ref.unexportedDiagnostic !== null || ref.isLocal || ref.moduleName === null) {
            if (ref.unexportedDiagnostic !== null) {
                throw new Error(`Unable to import symbol ${ref.name}: ${ref.unexportedDiagnostic}`);
            }
            return new TcbExpr(ref.name);
        }
        return this.referenceExternalSymbol(ref.moduleName, ref.name);
    }
    referenceExternalSymbol(moduleName, name) {
        const alias = this.importManager.addImport(moduleName);
        return new TcbExpr(`${alias}.${name}`);
    }
    typeCtorFor(dir) {
        if (this.typeCtors.has(dir.ref.key)) {
            return new TcbExpr(this.typeCtors.get(dir.ref.key));
        }
        if (dir.requiresInlineTypeCtor) {
            const typeCtorExpr = `${this.referenceTcbValue(dir.ref).print()}.ngTypeCtor`;
            this.typeCtors.set(dir.ref.key, typeCtorExpr);
            return new TcbExpr(typeCtorExpr);
        }
        else {
            const fnName = `_ctor${this.nextIds.typeCtor++}`;
            const nodeTypeRef = this.referenceTcbValue(dir.ref);
            const meta = {
                fnName,
                body: true,
                fields: {
                    inputs: dir.inputs,
                },
                coercedInputFields: dir.coercedInputFields,
            };
            const typeParams = dir.typeParameters
                ? qualifyTypeParameters(dir.typeParameters, this, dir.ref.moduleName)
                : undefined;
            const typeCtor = generateTypeCtorDeclarationFn(this, meta, nodeTypeRef, typeParams);
            this.typeCtorStatements.push(typeCtor);
            this.typeCtors.set(dir.ref.key, fnName);
            return new TcbExpr(fnName);
        }
    }
    pipeInst(pipe) {
        if (this.pipeInsts.has(pipe.ref.key)) {
            return new TcbExpr(this.pipeInsts.get(pipe.ref.key));
        }
        const pipeType = this.referenceTcbValue(pipe.ref);
        const pipeInstId = `_pipe${this.nextIds.pipeInst++}`;
        this.pipeInsts.set(pipe.ref.key, pipeInstId);
        this.pipeInstStatements.push(new TcbExpr(`var ${pipeInstId} = null! as ${pipeType.print()}`));
        return new TcbExpr(pipeInstId);
    }
    getPreludeStatements() {
        if (this.isInline) {
            return [...this.pipeInstStatements, ...this.typeCtorStatements];
        }
        return [];
    }
    getFileLevelStatements() {
        return [...this.pipeInstStatements, ...this.typeCtorStatements];
    }
}
export function prepareTcbTargets(filePath, tcbTargets, content, config, classes, tracer = NOOP_TRACER) {
    if (tcbTargets.length === 0)
        return null;
    const localClasses = new Map();
    if (classes) {
        for (const cls of classes) {
            if (cls.className)
                localClasses.set(cls.className, cls);
        }
    }
    else {
        for (const target of tcbTargets) {
            if (target.className)
                localClasses.set(target.className, target.classMeta);
        }
    }
    let requiresInline = tcbTargets.some((target) => requiresInlineDeclaration(target.classMeta));
    const intermediateTargets = [];
    for (let i = 0; i < tcbTargets.length; i++) {
        const comp = tcbTargets[i];
        const typeCheckId = `tcb${i + 1}`;
        const adaptedWithInline = requiresInline;
        const adapted = adaptTcbInput(comp, typeCheckId, filePath, config, adaptedWithInline, content, tracer);
        intermediateTargets.push({ comp, typeCheckId, ...adapted, adaptedWithInline });
        if (!requiresInline &&
            requiresInlineTypeCheckBlock(comp, adapted.tcbMeta.boundTarget, localClasses)) {
            requiresInline = true;
        }
    }
    const boundTargetMap = new Map();
    const hostElementsMap = new Map();
    const typeCheckIdMap = new Map();
    const targets = [];
    for (let i = 0; i < tcbTargets.length; i++) {
        const { comp, typeCheckId, adaptedWithInline } = intermediateTargets[i];
        const { tcbMeta, targetMeta, hostElement } = requiresInline && !adaptedWithInline
            ? adaptTcbInput(comp, typeCheckId, filePath, config, true, content, tracer)
            : intermediateTargets[i];
        const classKey = makeClassKey(comp.className, comp.classMeta.span.start);
        boundTargetMap.set(classKey, tcbMeta.boundTarget);
        hostElementsMap.set(classKey, hostElement);
        typeCheckIdMap.set(classKey, typeCheckId);
        targets.push({ comp, typeCheckId, tcbMeta, targetMeta });
    }
    return { targets, boundTargetMap, hostElementsMap, typeCheckIdMap, requiresInline };
}
export function generateTcbCode(filePath, preparedData, config, namespaceAliasConflicts) {
    const { targets, requiresInline } = preparedData;
    if (targets.length === 0)
        return null;
    // Inline TCBs share file scope with the copied source content, so generated imports must avoid
    // any alias-shaped bindings in the file (`AnalysisResult.namespaceAliasConflicts`).
    const importManager = new TcbImportManager(requiresInline && namespaceAliasConflicts ? new Set(namespaceAliasConflicts) : undefined);
    const oobRecorder = new OutOfBandDiagnosticRecorderImpl();
    const domSchemaChecker = new RegistryDomSchemaChecker();
    const semanticsDiagnostics = [];
    const extendedDiagnostics = [];
    let code = '';
    let functionStrings = '';
    const tcbMap = new Map();
    const templateSources = {};
    const sharedEnv = !requiresInline ? new TcbEnvironmentImpl(config, importManager, false) : null;
    for (const target of targets) {
        const { comp, typeCheckId, tcbMeta, targetMeta } = target;
        const env = sharedEnv || new TcbEnvironmentImpl(config, importManager, true);
        const targetTypeParams = targetMeta.typeParameters
            ? (qualifyTypeParameters(targetMeta.typeParameters, env, targetMeta.ref.moduleName) ?? null)
            : null;
        const qualifiedTargetMeta = targetTypeParams
            ? { ...targetMeta, typeParameters: targetTypeParams }
            : targetMeta;
        let tcbString = '';
        try {
            tcbString = generateTypeCheckBlock(env, qualifiedTargetMeta, `_${typeCheckId}`, tcbMeta, domSchemaChecker, oobRecorder);
        }
        catch (e) {
            oobRecorder.error(typeCheckId, `Error generating TCB for ${comp.className}: ${e?.message || e}`, { start: comp.classMeta.span.start, end: comp.classMeta.span.end });
            continue;
        }
        if (!config.disabledExtendedDiagnostics) {
            semanticsDiagnostics.push(...getTemplateSemanticsDiagnostics(typeCheckId, comp.templateNodes, tcbMeta.boundTarget));
            extendedDiagnostics.push(...runExtendedDiagnostics(typeCheckId, comp, tcbMeta.boundTarget, filePath, config.extendedDiagnostics, undefined, config.checkTemplateBodies, config.unusedStandaloneImports));
        }
        functionStrings += tcbString + '\n\n';
        const classKey = makeClassKey(comp.className, comp.classMeta.span.start);
        tcbMap.set(classKey, tcbString);
        const templateSource = getTcbTemplateSource(comp.classMeta.component);
        if (templateSource !== null) {
            templateSources[typeCheckId] = templateSource;
        }
    }
    if (!requiresInline) {
        const preludeStatements = sharedEnv.getFileLevelStatements();
        const preludeStr = printStatements(preludeStatements);
        code += preludeStr + '\n' + functionStrings;
        // Mirrors ngtsc's `ensureTypeCheckFilePreparationImports`: signal input checking adds an
        // `@angular/core` import on demand, which would change the TypeScript import graph (and so
        // defeat complete program reuse) the first time a signal input appears. Seeded after the TCBs
        // are generated so it never shifts the aliases they already use.
        importManager.addImport(R3Identifiers.InputSignalBrandWriteType.moduleName);
    }
    else {
        code += functionStrings;
    }
    const importsStr = importManager.generateImportStatements();
    return {
        code: code,
        imports: importsStr,
        tcbMap,
        templateSources,
        diagnostics: [
            ...domSchemaChecker.diagnostics,
            ...oobRecorder.diagnostics,
            ...semanticsDiagnostics,
            ...extendedDiagnostics,
        ],
        isInline: requiresInline,
    };
}
export function combineTcbContent(tcbResult, filePath, inlineInfo) {
    const generatedComment = `/**\n * TCB for ${filePath}\n * @generated\n */\n\n`;
    const importsStr = tcbResult.imports || '';
    const separator = importsStr ? '\n' : '';
    const tcbHeader = generatedComment + importsStr + separator;
    const tcbFooter = serializeTcbTemplateSources(tcbResult.templateSources);
    if (tcbResult.isInline) {
        const { sourceContent, classes } = inlineInfo;
        const s = new MagicString(sourceContent);
        for (const classMeta of classes) {
            const classKey = makeClassKey(classMeta.className || '', classMeta.span.start);
            const tcbCode = tcbResult.tcbMap.get(classKey);
            if (tcbCode) {
                s.appendLeft(classMeta.span.end, '\n\n' + tcbCode);
            }
        }
        return tcbHeader + s.toString() + tcbFooter;
    }
    else {
        return tcbHeader + tcbResult.code + tcbFooter;
    }
}
