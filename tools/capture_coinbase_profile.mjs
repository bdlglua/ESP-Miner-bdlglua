// Read-only diagnostic collection. Requires Node >=22; no npm dependencies.
// Usage: node tools/capture_coinbase_profile.mjs URL OUTPUT_DIRECTORY [SECONDS] [WARMUP_SECONDS]
// Keeps only performance lines and public telemetry, never pool/Wi-Fi credentials.
import {mkdir, writeFile, appendFile} from 'node:fs/promises';
import {join} from 'node:path';

const [base, directory, secondsText = '300', warmupText = '60'] = process.argv.slice(2);
if (!base || !directory) throw new Error('Expected URL OUTPUT_DIRECTORY [SECONDS] [WARMUP_SECONDS]');
const url = new URL(base);
if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Expected HTTP(S) URL');
const seconds = Number(secondsText), warmup = Number(warmupText);
if (!Number.isFinite(seconds) || seconds < 1 || !Number.isFinite(warmup) || warmup < 0) {
  throw new Error('Invalid duration');
}
await mkdir(directory, {recursive: true});
const profilePath = join(directory, 'profile.log');
const telemetryPath = join(directory, 'telemetry.jsonl');
await writeFile(profilePath, '');
await writeFile(telemetryPath, '');
const keys = ['version', 'axeOSVersion', 'ASICModel', 'frequency', 'coreVoltage',
  'coreVoltageActual', 'temp', 'vrTemp', 'fanspeed', 'fanrpm', 'autofanspeed',
  'minFanSpeed', 'temptarget', 'hashRate', 'expectedHashrate', 'sharesAccepted',
  'sharesRejected', 'errorPercentage', 'uptimeSeconds', 'freeHeap', 'blockHeight',
  'coinbaseCurrency', 'coinbaseDecimals', 'coinbaseValueTotalSatoshis',
  'coinbaseValueUserSatoshis', 'stratumDecodeCoinbase', 'fallbackStratumDecodeCoinbase',
  'poolDifficulty', 'isUsingFallbackStratum', 'stratumCoin', 'fallbackStratumCoin', 'overheat_mode'];
const start = Date.now(), monotonicStart = performance.now();
const ready = monotonicStart + warmup * 1000, end = ready + seconds * 1000;
const state = {started: new Date(start).toISOString(), warmup_seconds: warmup,
  measurement_seconds: seconds, coinbase: 0, coinbase_errors: 0, work: 0,
  socket_connections: 0, socket_errors: 0, http_errors: 0, unexpected_reboots: 0,
  protocol_reports: 0, protocol_tx: 0, protocol_rx: 0,
  protocol_tx_mismatches: 0, protocol_rx_mismatches: 0, protocol_modes: [],
  benchmark_samples: 0, benchmark_complete: false,
  asic_crc_errors: 0, uart_errors: 0, invalid_nonces: 0,
  stale_job_responses: 0, job_id_samples: 0, job_id_max_bytes: 0,
  rejected_categories: {},
  job_store_resets: {}, job_store_reconnect_tests: 0, job_store_published: 0,
  job_store_errors: 0, job_store_stale_submissions: 0,
  firmware_versions: [], finished: false};
let socket, closing = false, previousUptime, pendingWrites = Promise.resolve();
let firstMeasured, lastMeasured, configuredSettings;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    state.aborted = `interrupted_${signal.toLowerCase()}`;
    closing = true;
  });
}
function save(path, text) {
  pendingWrites = pendingWrites.then(() => appendFile(path, text));
}
function connect() {
  if (closing) return;
  const wsUrl = new URL('/api/ws', url);
  wsUrl.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(wsUrl);
  socket.addEventListener('open', () => { state.socket_connections++; });
  socket.addEventListener('error', () => { state.socket_errors++; });
  socket.addEventListener('close', () => {
    if (!closing) setTimeout(connect, 1500);
  });
  socket.addEventListener('message', event => {
    if (performance.now() < ready) return;
    for (const line of String(event.data).replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
      if (line.includes('job_store:')) {
        const reset = line.match(/reset reason=(\w+)/);
        if (reset) state.job_store_resets[reset[1]] = (state.job_store_resets[reset[1]] ?? 0) + 1;
        const published = line.match(/published=(\d+)/);
        if (published) state.job_store_published = Number(published[1]);
        if (line.includes('test reconnect=')) state.job_store_reconnect_tests++;
        if (/rejected:/i.test(line)) state.job_store_errors++;
        if (line.includes('Discarded stale result')) state.job_store_stale_submissions++;
      } else if (line.includes('coinbase_profile:')) {
        state.coinbase++;
        if (!/\bstatus=0\b/.test(line)) state.coinbase_errors++;
      } else if (line.includes('work_profile:')) {
        state.work++;
      } else if (line.includes('protocol_bench:')) {
        if (line.includes('total_ns=')) state.benchmark_samples++;
        if (line.includes('complete=1')) state.benchmark_complete = true;
      } else if (line.includes('protocol_check mode=')) {
        const fields = Object.fromEntries([...line.matchAll(/(\w+)=([\w-]+)/g)].map(m => [m[1], m[2]]));
        state.protocol_reports++;
        if (!state.protocol_modes.includes(fields.mode)) state.protocol_modes.push(fields.mode);
        state.protocol_tx = Number(fields.tx);
        state.protocol_rx = Number(fields.rx);
        state.protocol_tx_mismatches = Number(fields.tx_mismatch);
        state.protocol_rx_mismatches = Number(fields.rx_mismatch);
        if (state.protocol_tx_mismatches || state.protocol_rx_mismatches) {
          state.aborted = 'protocol_mismatch';
          closing = true;
        }
      } else if (/common: Checksum failed/.test(line)) {
        state.asic_crc_errors++;
        save(profilePath, `diagnostic_event: kind=asic-crc at=${Date.now()}\n`);
        continue;
      } else if (/common: UART error/.test(line)) {
        state.uart_errors++;
        save(profilePath, `diagnostic_event: kind=uart at=${Date.now()}\n`);
        continue;
      } else if (/invalid nonce/i.test(line) && /bm1370:|asic_result:/.test(line)) {
        state.invalid_nonces++;
        save(profilePath, `diagnostic_event: kind=invalid-nonce at=${Date.now()}\n`);
        continue;
      } else if (/Invalid job nonce found/.test(line) && /bm1370:|asic_result:/.test(line)) {
        state.stale_job_responses++;
        continue;
      } else if (line.includes('asic_result: ID:')) {
        const match = line.match(/asic_result: ID: (.*), ASIC nr:/);
        if (match) {
          state.job_id_samples++;
          state.job_id_max_bytes = Math.max(state.job_id_max_bytes, Buffer.byteLength(match[1]));
        }
        continue;
      } else continue;
      save(profilePath, line + '\n');
    }
  });
}
connect();
async function telemetry() {
  try {
    const response = await fetch(new URL('/api/system/info', url), {signal: AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const settings = Object.fromEntries(['frequency', 'coreVoltage', 'temptarget',
      'autofanspeed', 'minFanSpeed', 'stratumDecodeCoinbase', 'stratumCoin', 'fallbackStratumCoin'].map(key => [key, body[key]]));
    configuredSettings ??= settings;
    if (JSON.stringify(configuredSettings) !== JSON.stringify(settings)) {
      state.aborted = 'configuration_changed';
      closing = true;
    }
    // Keep classifications/counts, never arbitrary pool error strings.
    state.rejected_categories = {};
    for (const reason of body.sharesRejectedReasons ?? []) {
      const message = String(reason.message ?? '').toLowerCase();
      const category = ['stale', 'duplicate', 'low difficulty', 'job not found', 'unauthorized']
        .find(category => message.includes(category)) ?? 'other';
      state.rejected_categories[category] = (state.rejected_categories[category] ?? 0) + Number(reason.count ?? 0);
    }
    const sample = {at: new Date().toISOString(), measured: performance.now() >= ready,
      ...Object.fromEntries(keys.filter(key => key in body).map(key => [key, body[key]]))};
    if (!state.firmware_versions.includes(body.version)) state.firmware_versions.push(body.version);
    if (previousUptime !== undefined && body.uptimeSeconds < previousUptime) {
      state.unexpected_reboots++;
      state.aborted = 'unexpected_reboot';
      closing = true;
    }
    previousUptime = body.uptimeSeconds;
    save(telemetryPath, JSON.stringify(sample) + '\n');
    if (sample.measured) { firstMeasured ??= sample; lastMeasured = sample; }
    console.log(JSON.stringify({elapsed_s: Math.round((performance.now() - monotonicStart) / 1000),
      measuring: sample.measured, version: body.version, coinbase: state.coinbase,
      coinbase_errors: state.coinbase_errors, work: state.work, accepted: body.sharesAccepted,
      protocol_reports: state.protocol_reports,
      protocol_mismatches: state.protocol_tx_mismatches + state.protocol_rx_mismatches,
      rejected: body.sharesRejected, temp: body.temp, vrTemp: body.vrTemp, heap: body.freeHeap}));
    if (body.overheat_mode) throw new Error('Device overheat mode is active');
  } catch (error) {
    state.http_errors++;
    console.log(JSON.stringify({telemetry_error: error.message}));
    if (error.message.includes('overheat')) {
      state.aborted = 'overheat';
      closing = true;
    }
  }
}
while (!closing && performance.now() < end) {
  await telemetry();
  await new Promise(resolve => setTimeout(resolve, Math.min(10000, Math.max(0, end - performance.now()))));
}
if (!closing) await telemetry();
closing = true;
socket?.close();
await pendingWrites;
state.finished = !state.aborted;
state.ended = new Date().toISOString();
state.actual_measured_seconds = Math.max(0, (performance.now() - ready) / 1000);
state.first = firstMeasured;
state.last = lastMeasured;
if (firstMeasured && lastMeasured && !state.unexpected_reboots) {
  state.accepted_delta = lastMeasured.sharesAccepted - firstMeasured.sharesAccepted;
  state.rejected_delta = lastMeasured.sharesRejected - firstMeasured.sharesRejected;
}
await writeFile(join(directory, 'collection.json'), JSON.stringify(state, null, 2) + '\n');
console.log(JSON.stringify({collection_complete: state}));
