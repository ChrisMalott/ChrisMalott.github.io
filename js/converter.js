/*
 * converter.js — shared in-browser conversion engine for every tool page.
 *
 * - Uses ffmpeg.wasm, SINGLE-THREAD core only (no SharedArrayBuffer, so no
 *   COOP/COEP headers are needed and third-party ads keep working).
 * - The FFmpeg core (~31 MB) is self-hosted in /vendor and is only downloaded
 *   when the visitor presses Convert, never on page load.
 * - Each page embeds a JSON config in <script id="converter-config">, rendered
 *   by build.js from tools.json:
 *     {
 *       input:  { label, extensions[], mimeTypes[] },
 *       output: { label, extension, mimeType, preview: "image" | "video" },
 *       trim: true,                        // show start/end time fields
 *       settings: [{ id, options: [{ value, vars? }] }],  // width, fps, quality…
 *       passes: [[ "...ffmpeg args with {placeholders}..." ], ...],
 *       passWeights: [0.3, 0.7],           // optional, for the progress bar
 *       maxFileMB: 300
 *     }
 *   Placeholders: {input}, {output}, {trim} (expands to -ss/-t or nothing),
 *   {<settingId>} (the chosen value) and any key from the chosen option's "vars".
 * - Files never leave the device: the input is mounted read-only into the
 *   worker (WORKERFS) and the result is handed back as a Blob URL.
 */

const VENDOR = new URL('../vendor/', import.meta.url);
const CORE_JS = new URL('ffmpeg-core/ffmpeg-core.js', VENDOR).href;
const CORE_WASM = new URL('ffmpeg-core/ffmpeg-core.wasm', VENDOR).href;
const FFMPEG_MODULE = new URL('ffmpeg/index.js', VENDOR).href;
const STALL_TIMEOUT_MS = 90 * 1000; // no ffmpeg output for this long = treat as hung
const INPUT_DIR = '/input';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

function formatTime(sec) {
  if (!isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(s % 1 ? 1 : 0);
}

/** Parses "", "5", "5.5", "1:05", "01:02:03.5" into seconds. Returns null for empty, NaN for invalid. */
function parseTime(str) {
  str = String(str || '').trim();
  if (!str) return null;
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(str)) return NaN;
  return str.split(':').reduce((acc, part) => acc * 60 + parseFloat(part), 0);
}

function extOf(name) {
  const m = /\.([^.]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function baseName(name) {
  const b = (name || 'converted').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').trim();
  return b || 'converted';
}

/** HH:MM:SS.xx -> seconds */
function hmsToSec(h, m, s) {
  return (+h) * 3600 + (+m) * 60 + parseFloat(s);
}

/* ------------------------------------------------------------------ */
/* Engine loading (lazy)                                               */
/* ------------------------------------------------------------------ */

let ffmpeg = null;      // current FFmpeg instance (null until first Convert)
let wasmBlobURL = null; // cached Blob URL of the downloaded core, reused after a reset
let logListener = null; // routes ffmpeg log lines to the active job

/** Downloads the wasm core with a progress callback, returning a Blob URL. */
async function fetchCoreWasm(onProgress) {
  if (wasmBlobURL) return wasmBlobURL;
  const res = await fetch(CORE_WASM);
  if (!res.ok) throw new Error('core-download-failed: HTTP ' + res.status);
  const total = +res.headers.get('Content-Length') || 32 * 1024 * 1024;
  let blob;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(Math.min(received / total, 0.99), received);
    }
    blob = new Blob(chunks, { type: 'application/wasm' });
  } else {
    blob = new Blob([await res.arrayBuffer()], { type: 'application/wasm' });
  }
  onProgress(1, blob.size);
  wasmBlobURL = URL.createObjectURL(blob);
  return wasmBlobURL;
}

async function getFFmpeg(onProgress) {
  if (ffmpeg && ffmpeg.loaded) return ffmpeg;
  if (typeof WebAssembly !== 'object') throw new Error('no-wasm');
  let mod;
  try {
    mod = await import(FFMPEG_MODULE);
  } catch (e) {
    throw new Error('core-download-failed: ' + e.message);
  }
  const wasmURL = await fetchCoreWasm(onProgress);
  const inst = new mod.FFmpeg();
  inst.on('log', ({ message }) => logListener && logListener(message));
  try {
    await inst.load({ coreURL: CORE_JS, wasmURL });
  } catch (e) {
    inst.terminate();
    throw new Error('core-init-failed: ' + (e && e.message ? e.message : e));
  }
  ffmpeg = inst;
  return inst;
}

/** Kills the worker. The next conversion loads a fresh instance (the core stays cached). */
function resetEngine() {
  if (ffmpeg) {
    try { ffmpeg.terminate(); } catch (e) { /* already gone */ }
  }
  ffmpeg = null;
}

/* ------------------------------------------------------------------ */
/* Turning ffmpeg output into plain-language errors                    */
/* ------------------------------------------------------------------ */

class FriendlyError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail || '';
  }
}

function explainFailure(logText, cfg, err) {
  const L = logText || '';
  const errMsg = err ? String(err.message || err) : '';
  const what = cfg.input.label;
  if (/no-wasm/.test(errMsg)) {
    return 'Your browser doesn’t support WebAssembly, which this converter needs. Please update your browser or try a recent version of Chrome, Edge, Firefox or Safari.';
  }
  if (/core-download-failed/.test(errMsg)) {
    return 'The converter engine couldn’t be downloaded. Check your internet connection (or any content blocker) and try again.';
  }
  if (/core-init-failed/.test(errMsg)) {
    return 'The converter engine couldn’t start in this browser. Try closing other tabs to free up memory, or use a recent desktop version of Chrome, Edge, Firefox or Safari.';
  }
  if (/stalled/.test(errMsg)) {
    return 'The conversion stopped responding, so it was cancelled. The file may be damaged, or too demanding for this device. Try trimming a shorter section or choosing a smaller size.';
  }
  if (/moov atom not found|Invalid data found when processing input|could not find codec parameters|EBML header parsing failed|Error opening input|End of file/i.test(L)) {
    return 'This file couldn’t be read. It may be incomplete (still uploading or downloading?), damaged, or not actually in ' + what + ' format.';
  }
  const dec = /Decoder \(codec ([\w-]+)\) not found|codec not currently supported in container|Unsupported codec[^\n]*?(\w+)?/i.exec(L);
  if (dec) {
    return 'This file uses a video or audio format' + (dec[1] ? ' (' + dec[1] + ')' : '') + ' that the in-browser converter can’t decode.';
  }
  if (/matches no streams|does not contain any stream|Output file is empty|nothing was encoded/i.test(L) || /empty-output/.test(errMsg)) {
    return 'No video was produced. Check that the file actually contains a video track, and that the start time is before the end of the video.';
  }
  // Note: ffmpeg.wasm prints "Aborted()" after *every* failed run, so it is not a memory signal on its own.
  if (/Cannot allocate memory|out of memory|OOM|memory access out of bounds|Array buffer allocation failed/i.test(L + ' ' + errMsg)) {
    return 'Your browser ran out of memory while converting. Try a shorter clip (use the start/end times), a smaller width or resolution, or close other tabs and try again.';
  }
  return 'The conversion failed. The file may be damaged or use a format this tool doesn’t support. If it plays fine on your device, try trimming a shorter section.';
}

/* ------------------------------------------------------------------ */
/* Running a conversion                                                */
/* ------------------------------------------------------------------ */

function expandArgs(template, vars) {
  const out = [];
  for (const token of template) {
    if (token === '{trim}') {
      out.push(...vars.trimArgs);
      continue;
    }
    out.push(token.replace(/\{(\w+)\}/g, (m, key) => {
      if (vars[key] === undefined) throw new Error('Config error: missing value for {' + key + '}');
      return String(vars[key]);
    }));
  }
  return out;
}

/**
 * Converts `file` according to `cfg` and the chosen `options`.
 * ui = { onPhase(text), onProgress(fraction, text) }
 * Returns { blob, name }.
 */
async function convert(file, cfg, options, ui, job) {
  const logs = [];
  let lastActivity = Date.now();
  let inputDuration = null;
  let passIndex = 0;
  const weights = cfg.passWeights || cfg.passes.map(() => 1 / cfg.passes.length);
  const passStart = (i) => weights.slice(0, i).reduce((a, b) => a + b, 0);
  const target = () => {
    if (!inputDuration && !options.duration) return null;
    const avail = inputDuration ? Math.max(inputDuration - (options.start || 0), 0.001) : Infinity;
    return Math.min(options.duration || Infinity, avail);
  };

  logListener = (line) => {
    lastActivity = Date.now();
    logs.push(line);
    if (logs.length > 400) logs.splice(0, logs.length - 400);
    const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(line);
    if (d && inputDuration === null) inputDuration = hmsToSec(d[1], d[2], d[3]);
    const t = /time=\s*(\d+):(\d+):([\d.]+)/.exec(line);
    const total = target();
    if (t && total) {
      const frac = Math.min(hmsToSec(t[1], t[2], t[3]) / total, 1);
      const overall = passStart(passIndex) + weights[passIndex] * frac;
      ui.onProgress(overall, 'Converting… ' + Math.round(overall * 100) + '%');
    }
  };

  // Watchdog: ffmpeg.exec is synchronous inside the worker, so the only way out
  // of a hang is to terminate the worker from here.
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > STALL_TIMEOUT_MS) {
      job.stalled = true;
      resetEngine();
    }
  }, 2000);

  const inExt = cfg.input.extensions.includes(extOf(file.name)) ? extOf(file.name) : cfg.input.extensions[0];
  const outName = 'output.' + cfg.output.extension;
  let mounted = false;
  let inputPath;

  try {
    ui.onPhase('Loading the converter engine (one-time download, about 31 MB)…');
    const ff = await getFFmpeg((frac, bytes) => {
      lastActivity = Date.now();
      ui.onProgress(frac, 'Downloading converter engine… ' + formatBytes(bytes));
    });
    if (job.cancelled) throw new Error('cancelled');
    lastActivity = Date.now();
    ui.onPhase('Reading your file…');
    ui.onProgress(0, 'Starting…');

    // Mount the File read-only into the worker instead of copying it into wasm memory.
    const localFile = new File([file], 'source.' + inExt, { type: file.type });
    try {
      await ff.createDir(INPUT_DIR).catch(() => {});
      mounted = await ff.mount('WORKERFS', { files: [localFile] }, INPUT_DIR);
      inputPath = INPUT_DIR + '/' + localFile.name;
    } catch (e) {
      mounted = false;
    }
    if (!mounted) {
      inputPath = localFile.name;
      await ff.writeFile(inputPath, new Uint8Array(await file.arrayBuffer()));
    }

    const vars = Object.assign({}, options.vars, {
      input: inputPath,
      output: outName,
      trimArgs: [
        ...(options.start ? ['-ss', String(options.start)] : []),
        ...(options.duration ? ['-t', String(options.duration)] : []),
      ],
    });

    ui.onPhase('Converting to ' + cfg.output.label + '…');
    for (passIndex = 0; passIndex < cfg.passes.length; passIndex++) {
      const args = expandArgs(cfg.passes[passIndex], vars);
      ui.onProgress(passStart(passIndex), cfg.passes.length > 1
        ? 'Pass ' + (passIndex + 1) + ' of ' + cfg.passes.length + '…'
        : 'Converting…');
      const code = await ff.exec(args);
      if (job.cancelled) throw new Error('cancelled');
      if (code !== 0) throw new Error('ffmpeg-exit-' + code);
    }

    const data = await ff.readFile(outName);
    if (!data || !data.length) throw new Error('empty-output');
    ui.onProgress(1, 'Done');

    // Clean up the in-memory files so the next conversion starts fresh.
    await ff.deleteFile(outName).catch(() => {});
    await ff.deleteFile('palette.png').catch(() => {});
    if (mounted) await ff.unmount(INPUT_DIR).catch(() => {});
    else await ff.deleteFile(inputPath).catch(() => {});

    return {
      blob: new Blob([data.buffer], { type: cfg.output.mimeType }),
      name: baseName(file.name) + '.' + cfg.output.extension,
    };
  } catch (err) {
    resetEngine(); // a failed/aborted core is not reliable; start fresh next time
    if (job.cancelled) throw new Error('cancelled');
    const e = job.stalled ? new Error('stalled') : err;
    const tail = logs.filter((l) => !/^\s*(frame=|size=)/.test(l)).slice(-12).join('\n');
    throw new FriendlyError(explainFailure(logs.join('\n'), cfg, e), tail || String(e && e.message || e));
  } finally {
    clearInterval(watchdog);
    logListener = null;
  }
}

/* ------------------------------------------------------------------ */
/* Page UI                                                             */
/* ------------------------------------------------------------------ */

function init() {
  const root = $('converter');
  const cfgEl = $('converter-config');
  if (!root || !cfgEl) return;
  const cfg = JSON.parse(cfgEl.textContent);
  const maxBytes = (cfg.maxFileMB || 300) * 1024 * 1024;

  const els = {
    drop: $('cv-drop'),
    input: $('cv-file'),
    fileInfo: $('cv-file-info'),
    fileName: $('cv-file-name'),
    fileMeta: $('cv-file-meta'),
    settings: $('cv-settings'),
    start: $('cv-start'),
    end: $('cv-end'),
    convert: $('cv-convert'),
    progress: $('cv-progress'),
    phase: $('cv-phase'),
    bar: $('cv-bar'),
    status: $('cv-status'),
    cancel: $('cv-cancel'),
    error: $('cv-error'),
    errorMsg: $('cv-error-msg'),
    errorDetail: $('cv-error-detail'),
    result: $('cv-result'),
    preview: $('cv-preview'),
    resultInfo: $('cv-result-info'),
    download: $('cv-download'),
    reset: $('cv-reset'),
    change: $('cv-change'),
  };

  let file = null;
  let fileDuration = null;
  let resultURL = null;
  let job = null;

  function setState(state) {
    root.dataset.state = state;
    const working = state === 'working';
    els.drop.hidden = state !== 'idle';
    els.fileInfo.hidden = state === 'idle' || state === 'done';
    els.settings.hidden = state === 'idle' || state === 'done';
    els.convert.hidden = state === 'done' || working;
    els.convert.disabled = !file;
    els.progress.hidden = !working;
    els.result.hidden = state !== 'done';
    els.change.disabled = working;
    if (els.settings) for (const c of els.settings.elements) c.disabled = working;
  }

  function showError(msg, detail) {
    els.errorMsg.textContent = msg;
    els.errorDetail.textContent = detail || '';
    els.errorDetail.parentElement.hidden = !detail;
    els.error.hidden = false;
  }

  function clearError() {
    els.error.hidden = true;
    els.errorMsg.textContent = '';
  }

  function acceptsFile(f) {
    const ext = extOf(f.name);
    if (cfg.input.extensions.includes(ext)) return true;
    return !ext && cfg.input.mimeTypes.includes(f.type);
  }

  function pickFile(f) {
    clearError();
    if (!f) return;
    if (!acceptsFile(f)) {
      showError('This tool converts ' + cfg.input.label + ' files (' + cfg.input.extensions.map((e) => '.' + e).join(', ') +
        '), and “' + f.name + '” is a different type of file.');
      return;
    }
    if (f.size > maxBytes) {
      showError('This file is ' + formatBytes(f.size) + '. The limit is ' + cfg.maxFileMB +
        ' MB, because the whole conversion happens in your browser’s memory. Try a shorter recording, or trim it on your device first.');
      return;
    }
    if (f.size === 0) {
      showError('This file is empty (0 bytes). Please choose a different file.');
      return;
    }
    file = f;
    fileDuration = null;
    els.fileName.textContent = f.name;
    els.fileMeta.textContent = formatBytes(f.size);
    setState('ready');
    readDuration(f);
  }

  // Best effort: read the duration with the browser's own player (local Blob URL, no upload).
  function readDuration(f) {
    const v = document.createElement('video');
    const url = URL.createObjectURL(f);
    const done = () => { URL.revokeObjectURL(url); v.removeAttribute('src'); };
    const timer = setTimeout(done, 5000);
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => {
      clearTimeout(timer);
      if (file === f && isFinite(v.duration) && v.duration > 0) {
        fileDuration = v.duration;
        els.fileMeta.textContent = formatBytes(f.size) + ' · ' + formatTime(v.duration) +
          (v.videoWidth ? ' · ' + v.videoWidth + '×' + v.videoHeight : '');
        if (els.end) els.end.placeholder = formatTime(v.duration) + ' (end)';
      }
      done();
    };
    v.onerror = () => { clearTimeout(timer); done(); };
    v.src = url;
  }

  function readOptions() {
    const opts = { vars: {}, start: 0, duration: null };
    for (const s of cfg.settings || []) {
      const el = els.settings.querySelector('[data-setting="' + s.id + '"]');
      const value = el ? el.value : s.default;
      const opt = s.options.find((o) => o.value === value) || s.options[0];
      opts.vars[s.id] = opt.value;
      Object.assign(opts.vars, opt.vars || {});
    }
    if (cfg.trim) {
      const start = parseTime(els.start.value);
      const end = parseTime(els.end.value);
      if (Number.isNaN(start) || Number.isNaN(end)) {
        throw new FriendlyError('Please enter times as seconds (e.g. 12.5) or minutes:seconds (e.g. 1:05).');
      }
      if (start !== null && end !== null && end <= start) {
        throw new FriendlyError('The end time must be after the start time.');
      }
      if (fileDuration && start !== null && start >= fileDuration) {
        throw new FriendlyError('The start time is after the end of the video (' + formatTime(fileDuration) + ').');
      }
      opts.start = start || 0;
      if (end !== null) opts.duration = +(end - opts.start).toFixed(3);
    }
    return opts;
  }

  async function run() {
    if (!file) return;
    clearError();
    let options;
    try {
      options = readOptions();
    } catch (e) {
      showError(e.message);
      return;
    }
    job = { cancelled: false, stalled: false };
    const thisJob = job;
    const started = Date.now();
    setState('working');
    els.bar.style.width = '0%';
    try {
      const out = await convert(file, cfg, options, {
        onPhase: (t) => { els.phase.textContent = t; },
        onProgress: (f, t) => {
          els.bar.style.width = (f * 100).toFixed(1) + '%';
          els.progress.setAttribute('aria-valuenow', Math.round(f * 100));
          if (t) els.status.textContent = t;
        },
      }, thisJob);
      if (thisJob.cancelled) return;
      showResult(out, Date.now() - started);
    } catch (e) {
      if (thisJob.cancelled || e.message === 'cancelled') return;
      setState('ready');
      showError(e instanceof FriendlyError ? e.message : explainFailure('', cfg, e), e.detail || '');
    } finally {
      if (job === thisJob) job = null;
    }
  }

  function showResult(out, ms) {
    if (resultURL) URL.revokeObjectURL(resultURL);
    resultURL = URL.createObjectURL(out.blob);
    els.preview.textContent = '';
    let media;
    if (cfg.output.preview === 'video') {
      media = document.createElement('video');
      media.controls = true;
      media.playsInline = true;
      media.preload = 'metadata';
    } else {
      media = document.createElement('img');
      media.alt = 'Preview of the converted ' + cfg.output.label;
    }
    media.src = resultURL;
    els.preview.appendChild(media);
    els.download.href = resultURL;
    els.download.download = out.name;
    els.resultInfo.textContent = out.name + ' · ' + formatBytes(out.blob.size) +
      ' · converted in ' + Math.max(1, Math.round(ms / 1000)) + ' s';
    setState('done');
    els.download.focus();
  }

  function resetAll() {
    if (resultURL) URL.revokeObjectURL(resultURL);
    resultURL = null;
    els.preview.textContent = '';
    file = null;
    fileDuration = null;
    els.input.value = '';
    if (els.start) els.start.value = '';
    if (els.end) { els.end.value = ''; els.end.placeholder = 'end of video'; }
    clearError();
    setState('idle');
  }

  // --- wiring ---
  els.input.addEventListener('change', () => pickFile(els.input.files[0]));
  ['dragenter', 'dragover'].forEach((t) => els.drop.addEventListener(t, (e) => {
    e.preventDefault();
    els.drop.classList.add('is-dragover');
  }));
  ['dragleave', 'drop'].forEach((t) => els.drop.addEventListener(t, () => els.drop.classList.remove('is-dragover')));
  els.drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) pickFile(files[0]);
  });
  // Dropping a file anywhere else on the page shouldn't navigate away from it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (root.dataset.state === 'idle' && e.dataTransfer && e.dataTransfer.files.length) pickFile(e.dataTransfer.files[0]);
  });

  els.convert.addEventListener('click', run);
  els.settings.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  els.cancel.addEventListener('click', () => {
    if (!job) return;
    job.cancelled = true;
    resetEngine();
    setState('ready');
    showError('Conversion cancelled.');
  });
  els.reset.addEventListener('click', resetAll);
  els.change.addEventListener('click', resetAll);
  window.addEventListener('beforeunload', (e) => {
    if (job) { e.preventDefault(); e.returnValue = ''; }
  });

  setState('idle');
  root.classList.add('is-ready');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

// Exposed for testing/debugging only.
export { parseTime, expandArgs, explainFailure };
