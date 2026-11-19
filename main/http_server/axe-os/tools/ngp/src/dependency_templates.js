/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import { getOrParseComponentTemplate } from './compiler-utils.js';
import { getOrCreateFileAnalysis, } from './file_analysis.js';
import { NOOP_TRACER } from './perf.js';
/**
 * Fills in template-derived metadata of the components a template depends on.
 *
 * The analyzer does not parse templates, so the only `DeclarationMetadata` that carry a
 * component's `ngContentSelectors` are those it read off a `.d.ts` (the `NgContentSelectors` type
 * argument of `ɵɵComponentDeclaration`). For a component declared in a source file of the
 * compilation they are missing, and the type-check block then cannot tell whether a control flow
 * block keeps a node out of the slot it targets (`controlFlowPreventingContentProjection`,
 * NG8011). ngtsc has them because `ComponentDecoratorHandler.analyze` registers the parsed
 * template's selectors in its metadata registry.
 *
 * They are recovered from the dependency's own parsed template. The template is parsed at most
 * once: it is cached in the dependency file's `FileAnalysis.parsedTemplates` under the same key
 * the processing of that file uses, so whichever of the two runs first parses and the other
 * reuses. A dependency file is read once per call, however many of its components are needed.
 *
 * TODO(ngp): remove once the analyzer parses templates and reports `ngContentSelectors` itself.
 */
export class DependencyTemplates {
    analyzer;
    fileCache;
    templateParseOptions;
    knownMetadata;
    tracer;
    /**
     * @param knownMetadata Metadata already at hand (e.g. the files of the chunk being
     *     processed), preferred to a round trip to the analyzer.
     */
    constructor(analyzer, fileCache, templateParseOptions, knownMetadata, tracer = NOOP_TRACER) {
        this.analyzer = analyzer;
        this.fileCache = fileCache;
        this.templateParseOptions = templateParseOptions;
        this.knownMetadata = knownMetadata;
        this.tracer = tracer;
    }
    /**
     * Returns `declarations` with `ngContentSelectors` filled in for every source-file component
     * that lacks them. Cross-file dependencies must be pre-fetched via `prefetch` before calling
     * this method. The input array and its entries are not mutated; it is returned as is when
     * nothing had to change.
     */
    withNgContentSelectors(declarations, consumer) {
        let result = null;
        for (let i = 0; i < declarations.length; i++) {
            const decl = declarations[i];
            if (!needsNgContentSelectors(decl)) {
                continue;
            }
            const parsed = this.getTemplate(decl, consumer);
            if (parsed === null) {
                continue;
            }
            result ??= [...declarations];
            result[i] = { ...decl, ngContentSelectors: parsed.ngContentSelectors };
        }
        return result ?? declarations;
    }
    /**
     * Parses and caches the templates of the cross-file component dependencies of every component
     * in `consumer` so `withNgContentSelectors` can read their `ngContentSelectors` synchronously
     * during template target binding. The dependency files are read concurrently.
     */
    async prefetch(consumer, onMetadata) {
        const missing = new Map();
        for (const cls of consumer.classes) {
            this.collectMissing(cls.component?.resolvedDeclarations ?? [], consumer.filePath, missing);
        }
        await Promise.all(Array.from(missing, async ([filePath, classIds]) => {
            const metadata = this.knownMetadata?.get(filePath) ?? (await this.analyzer.getMetadataForFile(filePath));
            if (metadata == null) {
                return;
            }
            onMetadata?.(metadata);
            const content = await this.analyzer.getFileContent(filePath);
            this.parseTemplates(filePath, metadata.classes, content, classIds.values());
        }));
    }
    /**
     * Adds to `missing` the components among `declarations` that are declared in a file other than
     * `consumerPath` and whose template is not cached yet. Same-file dependencies are parsed from
     * the consumer's own content, which the caller already has.
     */
    collectMissing(declarations, consumerPath, missing) {
        for (const decl of declarations) {
            const filePath = decl.filePath ?? consumerPath;
            if (!needsNgContentSelectors(decl) || filePath === consumerPath) {
                continue;
            }
            const id = classIdOf(decl);
            if (findParsedTemplate(this.getParsedTemplates(filePath), id) !== null) {
                continue;
            }
            let classIds = missing.get(filePath);
            if (classIds === undefined) {
                classIds = new Map();
                missing.set(filePath, classIds);
            }
            classIds.set(id.nameStart, id);
        }
    }
    /** Parses the templates of `classIds` into `filePath`'s cache, if not there already. */
    parseTemplates(filePath, classes, content, classIds) {
        const templatesByClass = this.getParsedTemplates(filePath);
        for (const id of classIds) {
            this.getOrParseTemplate(id, classes, filePath, content, templatesByClass);
        }
    }
    getTemplate(decl, consumer) {
        const filePath = decl.filePath ?? consumer.filePath;
        const id = classIdOf(decl);
        if (filePath === consumer.filePath) {
            return this.getOrParseTemplate(id, consumer.classes, consumer.filePath, consumer.content, consumer.templatesByClass);
        }
        return findParsedTemplate(this.getParsedTemplates(filePath), id);
    }
    getParsedTemplates(filePath) {
        return getOrCreateFileAnalysis(this.fileCache, filePath).parsedTemplates;
    }
    getOrParseTemplate(id, classes, filePath, content, templatesByClass) {
        const classMeta = classes.find((c) => c.nameSpan?.start === id.nameStart && c.className === id.name && c.component != null);
        if (classMeta?.component == null) {
            return null;
        }
        return getOrParseComponentTemplate(templatesByClass, classMeta, classMeta.component, filePath, content, this.templateParseOptions, this.tracer);
    }
}
function needsNgContentSelectors(decl) {
    return decl.declarationType === 'component' && decl.ngContentSelectors == null;
}
function classIdOf(decl) {
    return { name: decl.name, nameStart: decl.nameSpan.start };
}
/**
 * Fingerprints what `template` contributes to the components that use its component: its
 * `<ng-content>` tags, in order, which are all that `withNgContentSelectors` reads off it. Two
 * templates with the same signature yield the same `ngContentSelectors`, so a consumer only
 * has to be re-bound when a dependency's signature changes, not on every edit to its template.
 *
 * This scans the text rather than parsing it, as it runs for every analyzed component. The scan
 * skips HTML comments and honors quoted attribute values, so a `>` inside `select="div > span"`
 * does not end the tag early. It may still pick up an `<ng-content>` that the parser would not
 * treat as one (e.g. inside a `<script>`), which only costs a spurious re-binding.
 */
export function ngContentSignature(template) {
    const tags = [];
    const length = template.length;
    let i = 0;
    while (i < length) {
        const start = template.indexOf('<', i);
        if (start === -1) {
            break;
        }
        if (template.startsWith('<!--', start)) {
            const end = template.indexOf('-->', start + 4);
            i = end === -1 ? length : end + 3;
            continue;
        }
        if (!isNgContentTagStart(template, start)) {
            i = start + 1;
            continue;
        }
        // Scan to the `>` closing the tag, skipping quoted attribute values.
        let end = start + NG_CONTENT_TAG.length;
        let quote = null;
        while (end < length) {
            const char = template[end];
            if (quote !== null) {
                if (char === quote) {
                    quote = null;
                }
            }
            else if (char === '"' || char === "'") {
                quote = char;
            }
            else if (char === '>') {
                break;
            }
            end++;
        }
        tags.push(template.slice(start, end + 1));
        i = end + 1;
    }
    return tags.join('\n');
}
const NG_CONTENT_TAG = '<ng-content';
/** Whether an `<ng-content` tag starts at `index`, rather than e.g. `<ng-container`. */
function isNgContentTagStart(template, index) {
    const end = index + NG_CONTENT_TAG.length;
    if (template.slice(index, end).toLowerCase() !== NG_CONTENT_TAG) {
        return false;
    }
    if (end >= template.length) {
        return true;
    }
    return /[\s/>]/.test(template[end]);
}
/**
 * The cached template of the class `id`, without needing its class span (which is what the cache
 * is keyed by, through `makeClassKey(className, span.start)`, but is not known before the
 * declaring file's metadata is). Entries are matched on the name span start recorded when they
 * were cached instead.
 */
function findParsedTemplate(templatesByClass, id) {
    const prefix = `${id.name}@`;
    for (const [key, parsed] of templatesByClass) {
        if (key.startsWith(prefix) && parsed.classNameStart === id.nameStart) {
            return parsed;
        }
    }
    return null;
}
