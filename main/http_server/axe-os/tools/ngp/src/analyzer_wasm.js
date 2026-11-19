/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
export class WasmAnalyzer {
    inner;
    streams = new Map();
    isPumping = false;
    constructor(inner) {
        this.inner = inner;
    }
    schedulePump() {
        if (this.isPumping) {
            return;
        }
        this.isPumping = true;
        setTimeout(this.pumpLoop, 0);
    }
    pumpLoop = () => {
        if (this.streams.size === 0) {
            this.isPumping = false;
            return;
        }
        const start = Date.now();
        let idleCount = 0;
        while (this.streams.size > 0 && Date.now() - start < 15) {
            const eventStr = this.inner.pump();
            if (!eventStr) {
                idleCount++;
                if (idleCount > 1000) {
                    break;
                }
                continue;
            }
            idleCount = 0;
            try {
                const event = JSON.parse(eventStr);
                const stream = this.streams.get(event.id);
                if (stream) {
                    if (event.event === 'analysisResult' && event.data) {
                        stream.queue.push(event.data);
                    }
                    else if (event.event === 'analysisComplete') {
                        stream.queue.push(null);
                    }
                    else if (event.event === 'analysisError' && event.error) {
                        stream.error = new Error(event.error);
                    }
                    if (stream.nextResolve) {
                        const resolve = stream.nextResolve;
                        stream.nextResolve = null;
                        resolve(null);
                    }
                }
            }
            catch (e) {
                console.error('Failed to parse WASM pump event', e);
            }
        }
        if (this.streams.size > 0) {
            setTimeout(this.pumpLoop, 0);
        }
        else {
            this.isPumping = false;
        }
    };
    analyze() {
        return this.consumeStream(() => this.invoke(this.inner.analyze, 'analyze'));
    }
    analyzeOptimized() {
        return this.consumeStream(() => this.invoke(this.inner.analyze_optimized ?? this.inner.analyzeOptimized, 'analyzeOptimized'));
    }
    analyzeDelta() {
        return this.consumeStream(() => this.invoke(this.inner.analyze_delta ?? this.inner.analyzeDelta, 'analyzeDelta'));
    }
    analyzeOptimizedDelta() {
        return this.consumeStream(() => this.invoke(this.inner.analyze_optimized_delta ?? this.inner.analyzeOptimizedDelta, 'analyzeOptimizedDelta'));
    }
    /**
     * Calls the engine export `fn` with `args`; `name` identifies it when an older engine build
     * does not have it.
     *
     * The engine's fallible exports return `Result<_, String>`, which wasm-bindgen throws across
     * the boundary as a bare string rather than an `Error`. The N-API adapter receives
     * `napi::Error`s and the sidecar adapter constructs `Error`s from the RPC payload, so this is
     * the one backend whose failures would otherwise reach `IAnalyzer` consumers as non-`Error`
     * values. Anything thrown is wrapped in an `Error` here; `Error` instances (wasm-bindgen's own
     * `TypeError`s, Rust panics surfacing as `RuntimeError`) pass through unchanged.
     */
    invoke(fn, name, ...args) {
        if (!fn) {
            throw new Error(`WasmInner does not support ${name}`);
        }
        try {
            return fn.apply(this.inner, args);
        }
        catch (e) {
            throw e instanceof Error ? e : new Error(String(e));
        }
    }
    /**
     * Opens an engine stream with `start` and yields its chunks until the engine ends it.
     *
     * `start` runs on the first `next()`, not when the generator is created. The `finally`
     * releases the stream however iteration ends: completion, an engine error, or a consumer
     * that stops early with `break`, `return()` or a throw. Without it an abandoned stream
     * would stay registered, and `pumpLoop`, which runs while any stream is registered,
     * would never stop.
     */
    async *consumeStream(start) {
        const id = start();
        const stream = { queue: [], nextResolve: null };
        this.streams.set(id, stream);
        this.schedulePump();
        try {
            while (true) {
                // TODO(wasm): deliver queued chunks before throwing on stream error to match N-API.
                if (stream.error) {
                    throw stream.error;
                }
                const item = stream.queue.shift();
                if (item === undefined) {
                    await new Promise((resolve) => {
                        stream.nextResolve = () => resolve();
                    });
                    continue;
                }
                if (item === null) {
                    return;
                }
                yield item;
            }
        }
        finally {
            this.releaseStream(id);
        }
    }
    /**
     * Unregisters stream `id` and drops the engine's receiver for it. Once a stream has ended
     * the engine has already dropped the receiver, so `close_stream` does nothing then. Older
     * engine builds do not export `close_stream`; for those only the JS side is released.
     */
    releaseStream(id) {
        this.streams.delete(id);
        const close = this.inner.close_stream ?? this.inner.closeStream;
        close?.call(this.inner, id);
    }
    async getMetadataForFile(filePath) {
        const res = this.invoke(this.inner.getMetadataForFile ?? this.inner.get_metadata_for_file, 'getMetadataForFile', filePath);
        return res ? JSON.parse(res) : null;
    }
    async updateFileContent(updates) {
        const res = this.invoke(this.inner.updateFileContent ?? this.inner.update_file_content, 'updateFileContent', JSON.stringify(updates));
        return JSON.parse(res);
    }
    async invalidateFiles(updates) {
        const stringNames = ['Created', 'Deleted', 'Changed'];
        const mapped = updates.map((u) => ({
            filePath: u.filePath,
            updateType: typeof u.updateType === 'number'
                ? (stringNames[u.updateType] ?? u.updateType)
                : u.updateType,
        }));
        const res = this.invoke(this.inner.invalidateFiles ?? this.inner.invalidate_files, 'invalidateFiles', JSON.stringify(mapped));
        return JSON.parse(res);
    }
    async setEntryPoints(entryPoints) {
        const res = this.invoke(this.inner.setEntryPoints ?? this.inner.set_entry_points, 'setEntryPoints', JSON.stringify(entryPoints));
        return JSON.parse(res);
    }
    async getTsFileForTemplate(templatePath) {
        const res = this.invoke(this.inner.getTsFileForTemplate ?? this.inner.get_ts_file_for_template, 'getTsFileForTemplate', templatePath);
        return res ? JSON.parse(res) : null;
    }
    async getFileContent(filePath) {
        return this.invoke(this.inner.getFileContent ?? this.inner.get_file_content, 'getFileContent', filePath);
    }
    async readResource(containingFile, url) {
        const res = this.invoke(this.inner.readResource ?? this.inner.read_resource, 'readResource', containingFile, url);
        return res ? JSON.parse(res) : null;
    }
    async canonicalPaths(paths) {
        const res = this.invoke(this.inner.canonicalPaths ?? this.inner.canonical_paths, 'canonicalPaths', JSON.stringify(paths));
        return JSON.parse(res);
    }
    getCompilerOptions() {
        const fn = this.inner.getCompilerOptions ?? this.inner.get_compiler_options;
        if (!fn) {
            return {};
        }
        const raw = fn.call(this.inner);
        return raw ? JSON.parse(raw) : {};
    }
    close() {
        try {
            this.inner.free();
        }
        catch {
            // Ignore if already freed.
        }
    }
}
