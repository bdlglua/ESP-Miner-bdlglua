/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
export function getOrCreateFileAnalysis(cache, filePath) {
    let analysis = cache.get(filePath);
    if (!analysis) {
        analysis = { filePath, parsedTemplates: new Map() };
        cache.set(filePath, analysis);
    }
    return analysis;
}
