/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
export class NapiAnalyzer {
    analyzer;
    constructor(analyzer) {
        this.analyzer = analyzer;
    }
    /**
     * Creates an analyzer, resolving whichever engine is available.
     *
     * Retained for compatibility; prefer `loadAnalyzer` from `./analyzer_loader.js`,
     * whose options are richer and whose return type reflects that the result may be
     * wasm-backed rather than N-API-backed.
     *
     * The loader is reached through a dynamic `import()` so that merely importing this
     * module does not pull engine resolution into module evaluation.
     */
    static async create(tsconfigPath, options = {}) {
        const { loadAnalyzer } = await import('./analyzer_loader.js');
        return loadAnalyzer(tsconfigPath, options);
    }
    async *consumeIterator(iterator) {
        while (true) {
            const res = await iterator.next();
            if (res === null || res === undefined) {
                break;
            }
            yield res;
        }
    }
    analyze() {
        return this.consumeIterator(this.analyzer.analyze());
    }
    analyzeOptimized() {
        return this.consumeIterator(this.analyzer.analyzeOptimized());
    }
    analyzeDelta() {
        return this.consumeIterator(this.analyzer.analyzeDelta());
    }
    analyzeOptimizedDelta() {
        return this.consumeIterator(this.analyzer.analyzeOptimizedDelta());
    }
    async getMetadataForFile(filePath) {
        return this.analyzer.getMetadataForFile(filePath) ?? null;
    }
    async updateFileContent(updates) {
        return this.analyzer.updateFileContent(updates);
    }
    async invalidateFiles(updates) {
        return this.analyzer.invalidateFiles(updates);
    }
    async setEntryPoints(entryPoints) {
        return this.analyzer.setEntryPoints(entryPoints);
    }
    async getTsFileForTemplate(templatePath) {
        return this.analyzer.getTsFileForTemplate(templatePath);
    }
    async getFileContent(filePath) {
        return this.analyzer.getFileContent(filePath);
    }
    async readResource(containingFile, url) {
        return this.analyzer.readResource(containingFile, url) ?? null;
    }
    async canonicalPaths(paths) {
        return this.analyzer.canonicalPaths(paths);
    }
    getCompilerOptions() {
        const raw = this.analyzer.getCompilerOptions?.();
        return raw ? JSON.parse(raw) : {};
    }
    close() { }
}
