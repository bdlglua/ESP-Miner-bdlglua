/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import { SourceMap } from 'magic-string';
/**
 * Produces the source map of a processed file, covering both the original text that MagicString
 * carried over and the compiled definitions spliced into it.
 *
 * MagicString can't map inside inserted text, so all compiled text must be inserted through
 * this builder. It claims the mapped snippets the printer produced since the previous insertion
 * (see `ExpressionPrinter.takePendingSnippets`), locates them in the inserted text, and when the
 * map is generated finds where the inserted text landed in the output.
 */
export class OutputSourceMapBuilder {
    s;
    printer;
    filePath;
    content;
    insertions = [];
    constructor(s, printer, filePath, content) {
        this.s = s;
        this.printer = printer;
        this.filePath = filePath;
        this.content = content;
    }
    appendLeft(position, text) {
        this.s.appendLeft(position, text);
        this.record(position, 'left', text);
    }
    appendRight(position, text) {
        this.s.appendRight(position, text);
        this.record(position, 'right', text);
    }
    /** Generates the source map of `s.toString()`. */
    generateMap(options = {}) {
        const output = this.s.toString();
        const sourceName = options.source ?? this.filePath;
        const decoded = this.s.generateDecodedMap({
            ...options,
            // Disable high resolution source maps, because they use a lot of memory.
            hires: 'boundary',
        });
        const sources = [...decoded.sources];
        const sourcesContent = decoded.sourcesContent === undefined ? undefined : [...decoded.sourcesContent];
        const mappings = decoded.mappings;
        const sourceIndex = (url, content) => {
            const name = url === this.filePath ? sourceName : url;
            let index = sources.indexOf(name);
            if (index === -1) {
                index = sources.push(name) - 1;
                sourcesContent?.push(content);
            }
            return index;
        };
        const outputLineStarts = computeLineStarts(output);
        const touchedLines = new Set();
        for (const insertion of this.insertions) {
            const start = this.locate(output, insertion);
            if (start === -1) {
                continue;
            }
            for (const { offset, snippet } of insertion.snippets) {
                for (const mapping of snippet.mappings) {
                    const generatedOffset = start + offset + mapping.offset;
                    const line = lineOf(outputLineStarts, generatedOffset);
                    const column = generatedOffset - outputLineStarts[line];
                    const { line: sourceLine, column: sourceColumn } = this.sourcePosition(mapping);
                    while (mappings.length <= line) {
                        mappings.push([]);
                    }
                    mappings[line].push([
                        column,
                        sourceIndex(mapping.source, mapping.sourceContent),
                        sourceLine,
                        sourceColumn,
                    ]);
                    touchedLines.add(line);
                }
            }
        }
        for (const line of touchedLines) {
            // Stable sort keeps insertion order for equal columns, and the later segment wins below.
            const segments = mappings[line].sort((a, b) => a[0] - b[0]);
            const deduped = [];
            for (const segment of segments) {
                const last = deduped[deduped.length - 1];
                if (last !== undefined && last[0] === segment[0]) {
                    deduped[deduped.length - 1] = segment;
                }
                else {
                    deduped.push(segment);
                }
            }
            mappings[line] = deduped;
        }
        return new SourceMap({
            file: decoded.file,
            sources,
            sourcesContent: sourcesContent,
            names: decoded.names,
            mappings,
        });
    }
    record(position, side, text) {
        const snippets = [];
        let cursor = 0;
        for (const snippet of this.printer.takePendingSnippets()) {
            // Snippets are normally concatenated in the order they were printed.
            let offset = text.indexOf(snippet.text, cursor);
            if (offset === -1) {
                offset = text.indexOf(snippet.text);
            }
            if (offset === -1) {
                // Printed for something other than this insertion (e.g. an HMR update module).
                continue;
            }
            snippets.push({ offset, snippet });
            cursor = offset + snippet.text.length;
        }
        if (snippets.length > 0) {
            this.insertions.push({ position, side, text, snippets });
        }
    }
    /** Finds where an insertion's text starts in the output, or -1 if it was edited away. */
    locate(output, { position, side, text }) {
        // `slice(0, position)` is the output up to and including everything appended to the left
        // of `position`, so a left insertion ends at or before it and a right one starts at or
        // after it.
        let anchor = null;
        if (position === 0) {
            anchor = 0;
        }
        else {
            try {
                anchor = this.s.slice(0, position).length;
            }
            catch {
                // `position` ended up inside a replaced range.
            }
        }
        if (anchor !== null) {
            if (side === 'left') {
                const start = output.lastIndexOf(text, anchor - text.length);
                if (start !== -1 && start + text.length <= anchor) {
                    return start;
                }
            }
            else {
                const start = output.indexOf(text, anchor);
                if (start !== -1) {
                    return start;
                }
            }
        }
        return output.indexOf(text);
    }
    /**
     * The line and column of a mapping in its source. Spans the compiler builds from a bare
     * offset (e.g. host bindings) carry no usable line/column, so recompute them from the file
     * content when it is available.
     */
    sourcePosition(mapping) {
        const content = mapping.source === this.filePath ? this.content : (mapping.sourceContent ?? null);
        if (content === null || mapping.sourceOffset > content.length) {
            return { line: mapping.line, column: mapping.column };
        }
        const lineStarts = this.lineStartsOf(content);
        const line = lineOf(lineStarts, mapping.sourceOffset);
        return { line, column: mapping.sourceOffset - lineStarts[line] };
    }
    lineStartsCache = new Map();
    lineStartsOf(content) {
        let lineStarts = this.lineStartsCache.get(content);
        if (lineStarts === undefined) {
            lineStarts = computeLineStarts(content);
            this.lineStartsCache.set(content, lineStarts);
        }
        return lineStarts;
    }
}
function computeLineStarts(text) {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10 /* \n */) {
            lineStarts.push(i + 1);
        }
    }
    return lineStarts;
}
/** Index of the line containing `offset`, given the sorted line start offsets. */
function lineOf(lineStarts, offset) {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (lineStarts[mid] <= offset) {
            low = mid;
        }
        else {
            high = mid - 1;
        }
    }
    return low;
}
