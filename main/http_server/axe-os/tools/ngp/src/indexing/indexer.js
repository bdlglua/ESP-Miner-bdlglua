/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import { IndexerVisitor, TmplAstElement, TmplAstTemplate, } from '@angular/compiler';
import { makeClassKey } from '../compiler-utils.js';
import { createInputPropertyMapping, createOutputPropertyMapping } from '../tcb_adapter.js';
export class IndexerBoundTemplate {
    boundTarget;
    pipes;
    classEntityCache = new Map();
    constructor(boundTarget, pipes) {
        this.boundTarget = boundTarget;
        this.pipes = pipes;
    }
    getDirectivesOfNode(node) {
        return (this.boundTarget?.getDirectivesOfNode(node)?.map((dir) => this.toDirectiveRef(dir)) || null);
    }
    getReferenceTarget(node) {
        const target = this.boundTarget?.getReferenceTarget(node);
        if (!target) {
            return null;
        }
        if (target instanceof TmplAstElement || target instanceof TmplAstTemplate) {
            return target;
        }
        return { node: target.node, directive: this.toDirectiveRef(target.directive) };
    }
    getConsumerOfBinding(binding) {
        const consumer = this.boundTarget?.getConsumerOfBinding(binding);
        if (!consumer) {
            return null;
        }
        if (consumer instanceof TmplAstElement || consumer instanceof TmplAstTemplate) {
            return consumer;
        }
        return this.toDirectiveRef(consumer);
    }
    getExpressionTarget(ast) {
        return this.boundTarget?.getExpressionTarget(ast) ?? null;
    }
    getUsedDirectives() {
        const directives = this.boundTarget?.getUsedDirectives() ?? [];
        return directives.map((dir) => ({ ...this.toDirectiveRef(dir), isComponent: dir.isComponent }));
    }
    getTemplateAst() {
        return this.boundTarget?.target.template;
    }
    getPipe(name) {
        const pipe = this.pipes?.get(name);
        return pipe ? { ref: { node: pipe } } : null;
    }
    getClassEntity(dir) {
        const cacheKey = dir.ref || dir;
        if (this.classEntityCache.has(cacheKey)) {
            return this.classEntityCache.get(cacheKey);
        }
        let name = dir.name ?? '';
        let filePath = '';
        if (dir.ref) {
            name = dir.ref.name || name;
            filePath = dir.ref.nodeFilePath || '';
            if (!filePath && typeof dir.ref.key === 'string') {
                const parts = dir.ref.key.split('#');
                if (parts.length > 1) {
                    filePath = parts[0];
                }
            }
        }
        const entity = { name, filePath };
        this.classEntityCache.set(cacheKey, entity);
        return entity;
    }
    toDirectiveRef(dir) {
        return { ref: { node: this.getClassEntity(dir) }, selector: dir.selector };
    }
}
export async function getIndexedComponents(compiler) {
    const indexedComponents = new Map();
    for (const [filePath, fileAnalysis] of compiler.fileCache.entries()) {
        const result = await compiler.getCachedMetadata(filePath);
        if (!result)
            continue;
        const boundAnalysis = fileAnalysis.preparedTcbData !== undefined
            ? fileAnalysis
            : await compiler.ensureBoundWithMetadata(result);
        indexFileComponents(filePath, boundAnalysis, result, indexedComponents);
    }
    return indexedComponents;
}
function indexFileComponents(filePath, fileAnalysis, result, indexedComponents) {
    const templatesByClass = fileAnalysis.parsedTemplates;
    const boundTargetsByClass = fileAnalysis.preparedTcbData?.boundTargetMap;
    for (const cls of result.classes) {
        if (!cls.className || !cls.component)
            continue;
        const classKey = makeClassKey(cls.className, cls.span.start);
        const parsedTemplate = templatesByClass.get(classKey);
        if (!parsedTemplate)
            continue;
        const boundTarget = boundTargetsByClass?.get(classKey);
        const target = fileAnalysis.preparedTcbData?.targets.find((t) => t.comp.className === cls.className &&
            (!t.comp.classMeta || t.comp.classMeta.span.start === cls.span.start));
        const pipeMap = new Map();
        if (target?.comp.pipeRegistry) {
            for (const [name, pipeMeta] of target.comp.pipeRegistry.entries()) {
                pipeMap.set(name, {
                    name: pipeMeta.className,
                    filePath: pipeMeta.filePath || '',
                });
            }
        }
        const visitor = new IndexerVisitor(new IndexerBoundTemplate(boundTarget, pipeMap));
        parsedTemplate.diagNodes.forEach((node) => node.visit(visitor));
        const identifiers = new Set();
        for (const id of visitor.identifiers) {
            identifiers.add(id);
        }
        let templateUrl = undefined;
        if (cls.component.templateUrl && cls.component.templateUrl.stringLiteralSpan) {
            const span = cls.component.templateUrl.stringLiteralSpan;
            templateUrl = {
                url: cls.component.templateUrl.url,
                span: {
                    start: span.start + 1,
                    end: span.end - 1,
                },
                resolvedPath: cls.component.templateUrl.resolvedPath,
            };
        }
        const styleUrls = [];
        if (cls.component.styleUrls) {
            for (const s of cls.component.styleUrls) {
                if (s.stringLiteralSpan) {
                    styleUrls.push({
                        url: s.url,
                        span: {
                            start: s.stringLiteralSpan.start + 1,
                            end: s.stringLiteralSpan.end - 1,
                        },
                        resolvedPath: s.resolvedPath,
                    });
                }
            }
        }
        const inputMapping = createInputPropertyMapping(cls.inputs);
        const outputMapping = createOutputPropertyMapping(cls.outputs);
        const inputs = Array.from(inputMapping).map((m) => ({
            directiveProperty: m.classPropertyName,
            bindingName: m.bindingPropertyName,
        }));
        const outputs = Array.from(outputMapping).map((m) => ({
            directiveProperty: m.classPropertyName,
            bindingName: m.bindingPropertyName,
        }));
        const templatePath = templateUrl?.resolvedPath || filePath;
        indexedComponents.set(cls.className, {
            name: cls.className,
            selector: cls.component.selector || null,
            fileUrl: filePath,
            template: {
                identifiers,
                fileUrl: templatePath,
            },
            errors: visitor.errors,
            templateUrl,
            styleUrls,
            inputs,
            outputs,
        });
    }
}
