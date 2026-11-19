/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { performance, PerformanceObserver } from 'perf_hooks';
/**
 * Instrumented sections. A section is `ngp.<Name>` in the trace and the bare `<Name>` in the
 * summary, whose keys are a namespace of their own.
 */
export var SpanKind;
(function (SpanKind) {
    SpanKind[SpanKind["PrepareChunk"] = 0] = "PrepareChunk";
    SpanKind[SpanKind["PrepareTcbTargets"] = 1] = "PrepareTcbTargets";
    SpanKind[SpanKind["Compile"] = 2] = "Compile";
    SpanKind[SpanKind["SerializeOutput"] = 3] = "SerializeOutput";
    SpanKind[SpanKind["GenerateTcb"] = 4] = "GenerateTcb";
    SpanKind[SpanKind["SourceMap"] = 5] = "SourceMap";
    SpanKind[SpanKind["WriteOutput"] = 6] = "WriteOutput";
    SpanKind[SpanKind["WriteDiagnostics"] = 7] = "WriteDiagnostics";
    SpanKind[SpanKind["AwaitAnalysis"] = 8] = "AwaitAnalysis";
    /** The per-file async slice. */
    SpanKind[SpanKind["File"] = 9] = "File";
    /** Process start to the first instrumented code (module loading etc.). */
    SpanKind[SpanKind["Startup"] = 10] = "Startup";
    SpanKind[SpanKind["SpawnSidecar"] = 11] = "SpawnSidecar";
    /** The sidecar's `initialize` round trip. */
    SpanKind[SpanKind["InitializeRpc"] = 12] = "InitializeRpc";
    SpanKind[SpanKind["TakePerf"] = 13] = "TakePerf";
    SpanKind[SpanKind["Close"] = 14] = "Close";
    /** `JSON.parse` of an analysis result chunk from the sidecar. */
    SpanKind[SpanKind["ParseAnalysisResult"] = 15] = "ParseAnalysisResult";
    /** One `parseTemplate` call. A component template is parsed twice (normal and diagnostic). */
    SpanKind[SpanKind["TemplateParse"] = 16] = "TemplateParse";
    SpanKind[SpanKind["TemplateBind"] = 17] = "TemplateBind";
})(SpanKind || (SpanKind = {}));
export var Counter;
(function (Counter) {
    Counter[Counter["FilesAnalyzed"] = 0] = "FilesAnalyzed";
    Counter[Counter["FilesEmitted"] = 1] = "FilesEmitted";
    Counter[Counter["FilesReused"] = 2] = "FilesReused";
    Counter[Counter["UnchangedFilesEmitted"] = 3] = "UnchangedFilesEmitted";
    Counter[Counter["TcbFilesGenerated"] = 4] = "TcbFilesGenerated";
    Counter[Counter["EmptyTcbFilesWritten"] = 5] = "EmptyTcbFilesWritten";
    Counter[Counter["TemplatesParsed"] = 6] = "TemplatesParsed";
    Counter[Counter["ComponentsCompiled"] = 7] = "ComponentsCompiled";
    Counter[Counter["DirectivesCompiled"] = 8] = "DirectivesCompiled";
    Counter[Counter["PipesCompiled"] = 9] = "PipesCompiled";
    Counter[Counter["InjectablesCompiled"] = 10] = "InjectablesCompiled";
    Counter[Counter["NgModulesCompiled"] = 11] = "NgModulesCompiled";
    Counter[Counter["AnalysisResultBytes"] = 12] = "AnalysisResultBytes";
})(Counter || (Counter = {}));
const SPAN_KINDS = Object.keys(SpanKind).length / 2;
const COUNTERS = Object.keys(Counter).length / 2;
/** Trace event names, `ngp.` + the enum name, indexed by `SpanKind`. */
const SPAN_NAMES = [];
for (let kind = 0; kind < SPAN_KINDS; kind++) {
    SPAN_NAMES.push(`ngp.${SpanKind[kind]}`);
}
/**
 * Sections that contain driver-level awaits (nothing else runs meanwhile). They are wall time,
 * so they don't count towards `mainThreadBusyUs`. Only `sliceAsync` begins them, never inside a
 * synchronous section.
 */
const AWAITING_KINDS = new Uint8Array(SPAN_KINDS);
AWAITING_KINDS[SpanKind.PrepareChunk] = 1;
AWAITING_KINDS[SpanKind.WriteDiagnostics] = 1;
AWAITING_KINDS[SpanKind.AwaitAnalysis] = 1;
AWAITING_KINDS[SpanKind.Startup] = 1;
AWAITING_KINDS[SpanKind.InitializeRpc] = 1;
AWAITING_KINDS[SpanKind.TakePerf] = 1;
/**
 * Current time in µs from `process.hrtime()`, the clock `tsc_wrapped/perf_trace.ts` uses, so the
 * events share one timeline.
 */
export function nowMicros() {
    const [sec, nsec] = process.hrtime();
    return sec * 1e6 + nsec / 1e3;
}
/** When the process started, on the `nowMicros()` clock. */
export function processStartMicros() {
    return nowMicros() - performance.now() * 1e3;
}
function emptySummary(wallUs) {
    return {
        version: 1,
        wallUs,
        node: { spans: {}, async: {}, mainThreadBusyUs: 0, counters: {} },
    };
}
/** Track of GC pauses in the Node process. */
const GC_TID = 2;
/** `perf_hooks.constants.NODE_PERFORMANCE_GC_*`, the `detail.kind` of `gc` entries. */
const GC_KINDS = {
    1: 'minor',
    2: 'minor mark-sweep',
    4: 'major',
    8: 'incremental',
    16: 'weakcb',
};
function metadata(name, pid, tid, value) {
    return { name, ph: 'M', pid, tid, ts: 0, args: { name: value } };
}
export const NOOP_TRACER = Object.freeze({
    enabled: false,
    slice: (_kind, fn) => fn(),
    sliceAsync: (_kind, fn) => fn(),
    record: () => { },
    newFileId: () => 0,
    asyncBegin: () => { },
    asyncEnd: () => { },
    count: () => { },
    addAnalyzerPerf: () => { },
    take: () => ({ events: [], summary: emptySummary(0) }),
});
export function createTracer() {
    return new RecordingTracer(process.pid);
}
class RecordingTracer {
    pid;
    enabled = true;
    events = [];
    // Open synchronous sections, innermost last.
    openKind = [];
    openStart = [];
    openFile = [];
    openChildUs = [];
    openNonAwaiting = 0;
    spanCount = new Float64Array(SPAN_KINDS);
    spanInclusiveUs = new Float64Array(SPAN_KINDS);
    spanSelfUs = new Float64Array(SPAN_KINDS);
    asyncCount = new Float64Array(SPAN_KINDS);
    asyncWallUs = new Float64Array(SPAN_KINDS);
    /** Start of each open async slice, keyed `fileId * SPAN_KINDS + kind`. */
    asyncOpen = new Map();
    counters = new Float64Array(COUNTERS);
    busyUs = 0;
    startUs = nowMicros();
    nextFileId = 1;
    rust = undefined;
    gcObserver;
    gcCount = 0;
    gcUs = 0;
    constructor(pid) {
        this.pid = pid;
        // Only created when tracing. GC pauses go on their own track, since their timestamps come
        // from a different clock and could cross the main thread's slice boundaries by a few µs.
        this.gcObserver = new PerformanceObserver((list) => this.addGcEntries(list.getEntries()));
        this.gcObserver.observe({ entryTypes: ['gc'] });
    }
    addGcEntries(entries) {
        const origin = processStartMicros();
        for (const entry of entries) {
            const kind = entry.detail?.kind;
            const dur = entry.duration * 1e3;
            this.gcCount++;
            this.gcUs += dur;
            this.events.push({
                name: 'ngp.Gc',
                cat: 'ngp.gc',
                ph: 'X',
                pid: this.pid,
                tid: GC_TID,
                ts: origin + entry.startTime * 1e3,
                dur,
                args: { kind: GC_KINDS[kind ?? 0] ?? 'other' },
            });
        }
    }
    /** Opens a section and returns a token for `end()`. */
    begin(kind, fileId) {
        this.openKind.push(kind);
        this.openStart.push(nowMicros());
        this.openFile.push(fileId);
        this.openChildUs.push(0);
        if (!AWAITING_KINDS[kind]) {
            this.openNonAwaiting++;
        }
        return this.openKind.length;
    }
    /** Ends the section of `token`, and any section left open inside it. */
    end(token) {
        if (token < 1 || token > this.openKind.length) {
            return;
        }
        const now = nowMicros();
        while (this.openKind.length >= token) {
            this.close(now);
        }
    }
    record(kind, startUs) {
        if (!AWAITING_KINDS[kind]) {
            this.openNonAwaiting++;
        }
        this.finish(kind, startUs, nowMicros(), undefined, 0);
    }
    close(now) {
        const kind = this.openKind.pop();
        const start = this.openStart.pop();
        const fileId = this.openFile.pop();
        const childUs = this.openChildUs.pop();
        this.finish(kind, start, now, fileId, childUs);
    }
    finish(kind, start, now, fileId, childUs) {
        const dur = Math.max(0, now - start);
        this.spanCount[kind]++;
        this.spanInclusiveUs[kind] += dur;
        this.spanSelfUs[kind] += Math.max(0, dur - childUs);
        const depth = this.openChildUs.length;
        if (depth > 0) {
            this.openChildUs[depth - 1] += dur;
        }
        if (!AWAITING_KINDS[kind] && --this.openNonAwaiting === 0) {
            this.busyUs += dur;
        }
        const event = {
            name: SPAN_NAMES[kind],
            cat: 'ngp',
            ph: 'X',
            pid: this.pid,
            tid: 1,
            ts: start,
            dur,
        };
        if (fileId) {
            event.args = { f: fileId };
        }
        this.events.push(event);
    }
    slice(kind, fn, fileId) {
        const token = this.begin(kind, fileId);
        try {
            return fn();
        }
        finally {
            this.end(token);
        }
    }
    async sliceAsync(kind, fn, fileId) {
        const token = this.begin(kind, fileId);
        try {
            return await fn();
        }
        finally {
            this.end(token);
        }
    }
    newFileId(path) {
        const fileId = this.nextFileId++;
        this.asyncEvent('b', SpanKind.File, fileId, { path });
        return fileId;
    }
    asyncBegin(kind, fileId) {
        this.asyncEvent('b', kind, fileId);
    }
    asyncEnd(kind, fileId) {
        this.asyncEvent('e', kind, fileId);
    }
    asyncEvent(ph, kind, fileId, args) {
        const now = nowMicros();
        const key = fileId * SPAN_KINDS + kind;
        if (ph === 'b') {
            this.asyncOpen.set(key, now);
        }
        else {
            const start = this.asyncOpen.get(key);
            if (start === undefined) {
                return;
            }
            this.asyncOpen.delete(key);
            this.asyncCount[kind]++;
            this.asyncWallUs[kind] += Math.max(0, now - start);
        }
        const event = {
            name: SPAN_NAMES[kind],
            cat: 'ngp.file',
            ph,
            pid: this.pid,
            tid: 1,
            ts: now,
            id2: { local: fileId },
        };
        if (args !== undefined) {
            event.args = args;
        }
        this.events.push(event);
    }
    count(counter, n = 1) {
        this.counters[counter] += n;
    }
    addAnalyzerPerf(perf) {
        this.rust = perf.summary;
        const pid = perf.pid;
        // Rust clock to Node clock: `nowUs` was read about halfway through the `now` round trip.
        const base = (perf.requestUs + perf.responseUs) / 2 - perf.nowUs;
        for (const e of perf.events) {
            this.events.push({ ...e, pid, ts: e.ph === 'M' ? 0 : e.ts + base });
        }
        // The summary goes in the trace too: counters as a counter track, and the per-kind totals
        // (with the slowest executions) as a process-wide instant, whose args Perfetto shows when
        // it's selected.
        const ts = perf.nowUs + base;
        const { counters, ...summary } = perf.summary;
        const cat = 'ngp.rust';
        this.events.push({ name: 'ngp.rust.Counters', cat, ph: 'C', pid, tid: 0, ts, args: counters });
        this.events.push({
            name: 'ngp.rust.Summary',
            cat,
            ph: 'i',
            s: 'p',
            pid,
            tid: 0,
            ts,
            args: summary,
        });
    }
    take() {
        const now = nowMicros();
        const summary = emptySummary(Math.round(now - this.startUs));
        const node = summary.node;
        for (let kind = 0; kind < SPAN_KINDS; kind++) {
            if (this.spanCount[kind] > 0) {
                node.spans[SpanKind[kind]] = {
                    count: this.spanCount[kind],
                    selfUs: Math.round(this.spanSelfUs[kind]),
                    inclusiveUs: Math.round(this.spanInclusiveUs[kind]),
                };
            }
            if (this.asyncCount[kind] > 0) {
                node.async[SpanKind[kind]] = {
                    count: this.asyncCount[kind],
                    wallUs: Math.round(this.asyncWallUs[kind]),
                };
            }
        }
        node.mainThreadBusyUs = Math.round(this.busyUs);
        for (let counter = 0; counter < COUNTERS; counter++) {
            node.counters[Counter[counter]] = this.counters[counter];
        }
        if (this.gcObserver !== undefined) {
            // Entries are delivered a tick after the GC, so ones from the last tick may be missed.
            // `takeRecords` is missing from some @types/node versions.
            const observer = this.gcObserver;
            this.addGcEntries(observer.takeRecords?.() ?? []);
            this.gcObserver.disconnect();
            this.gcObserver = undefined;
        }
        node.gc = { count: this.gcCount, totalUs: Math.round(this.gcUs) };
        const { spans, async, ...nodeTotals } = node;
        if (this.rust !== undefined) {
            summary.rust = this.rust;
        }
        const pid = this.pid;
        const events = [
            metadata('process_name', pid, 0, 'ngp'),
            metadata('thread_name', pid, 1, 'main'),
            metadata('thread_name', pid, GC_TID, 'gc'),
            ...this.events,
            { name: 'ngp.Counters', cat: 'ngp', ph: 'C', pid, tid: 1, ts: now, args: { ...node.counters } },
            // Spans are left out; the timeline has them.
            { name: 'ngp.Summary', cat: 'ngp', ph: 'i', s: 'p', pid, tid: 1, ts: now, args: nodeTotals },
        ];
        // A section still open (a `sliceAsync` whose promise hasn't settled) is dropped.
        this.openKind.length = 0;
        this.openStart.length = 0;
        this.openFile.length = 0;
        this.openChildUs.length = 0;
        this.openNonAwaiting = 0;
        this.events = [];
        this.spanCount.fill(0);
        this.spanInclusiveUs.fill(0);
        this.spanSelfUs.fill(0);
        this.asyncCount.fill(0);
        this.asyncWallUs.fill(0);
        this.counters.fill(0);
        this.busyUs = 0;
        this.gcCount = 0;
        this.gcUs = 0;
        this.startUs = now;
        this.rust = undefined;
        return { events, summary };
    }
}
/** Writes `events` to `filePath` as a Chrome trace JSON array, overwriting it. */
export async function writeTraceFile(filePath, events) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(events), 'utf8');
}
/** Writes `summary` to `filePath` as JSON, overwriting it. */
export async function writeSummaryFile(filePath, summary) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(summary, null, 2), 'utf8');
}
