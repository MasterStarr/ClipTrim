import { ConversionCanceledError, exportClip, probe } from './encode.js';
import { formatMB, planEncode } from './plan.js';

const $ = (sel) => document.querySelector(sel);
const els = {
  drop: $('#drop'),
  file: $('#file'),
  loadError: $('#load-error'),
  editor: $('#editor'),
  fileName: $('#file-name'),
  fileInfo: $('#file-info'),
  change: $('#change'),
  video: $('#video'),
  previewError: $('#preview-error'),
  timeline: $('#timeline'),
  sel: $('#sel'),
  hStart: $('#h-start'),
  hEnd: $('#h-end'),
  head: $('#head'),
  start: $('#start'),
  end: $('#end'),
  setStart: $('#set-start'),
  setEnd: $('#set-end'),
  selLen: $('#sel-len'),
  playSel: $('#play-sel'),
  grab: $('#grab'),
  target: $('#target'),
  customWrap: $('#custom-wrap'),
  customMb: $('#custom-mb'),
  maxHeight: $('#max-height'),
  maxFps: $('#max-fps'),
  audio: $('#audio'),
  fpsDrop: $('#fps-drop'),
  lockRes: $('#lock-res'),
  resLabel: $('#res-label'),
  allowCopy: $('#allow-copy'),
  plan: $('#plan'),
  export: $('#export'),
  cancel: $('#cancel'),
  progress: $('#progress'),
  status: $('#status'),
  result: $('#result'),
  download: $('#download'),
  resultInfo: $('#result-info'),
};

const MIN_LEN = 0.1;

const state = {
  file: null,
  info: null,
  start: 0,
  end: 0,
  job: null,
  playingSel: false,
  videoUrl: null,
  resultUrl: null,
};

// --- loading ---------------------------------------------------------------

els.drop.addEventListener('click', () => els.file.click());
els.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') els.file.click();
});
els.change.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => {
  if (els.file.files[0]) loadFile(els.file.files[0]);
  els.file.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (e) => {
    e.preventDefault();
    els.drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  document.addEventListener(type, (e) => {
    e.preventDefault();
    els.drop.classList.remove('over');
  });
}
document.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files[0];
  if (file && !state.job) loadFile(file);
});

async function loadFile(file) {
  els.loadError.hidden = true;
  clearResult();
  let info;
  try {
    info = await probe(file);
  } catch (err) {
    showLoadError(`Couldn't read "${file.name}": ${err.message ?? err}`);
    return;
  }
  if (!info.canDecode) {
    showLoadError(
      `This browser can't decode ${codecName(info.codec)} video. Try Chrome or Edge` +
        (info.codec === 'hevc' ? ' on a PC with a GPU that supports HEVC.' : '.'),
    );
    return;
  }

  state.file = file;
  state.info = info;
  state.start = 0;
  state.end = info.duration;

  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = URL.createObjectURL(file);
  els.previewError.hidden = true;
  els.video.src = state.videoUrl;

  els.fileName.textContent = file.name;
  els.fileInfo.textContent =
    `${info.width}x${info.height} @ ${Math.round(info.fps)} fps · ${codecName(info.codec)}` +
    ` · ${fmtTime(info.duration)} · ${formatMB(file.size)}`;
  els.drop.hidden = true;
  els.editor.hidden = false;
  syncTrimInputs();
  render();
}

function showLoadError(msg) {
  els.loadError.textContent = msg;
  els.loadError.hidden = false;
}

els.video.addEventListener('error', () => {
  if (els.video.src) els.previewError.hidden = false;
});

// --- trimming --------------------------------------------------------------

function setStart(t) {
  state.start = clamp(t, 0, state.end - MIN_LEN);
  syncTrimInputs();
  render();
}

function setEnd(t) {
  state.end = clamp(t, state.start + MIN_LEN, state.info.duration);
  syncTrimInputs();
  render();
}

function syncTrimInputs() {
  els.start.value = state.start.toFixed(2);
  els.end.value = state.end.toFixed(2);
}

els.start.addEventListener('change', () => setStart(Number(els.start.value) || 0));
els.end.addEventListener('change', () => setEnd(Number(els.end.value) || state.info.duration));
els.setStart.addEventListener('click', () => setStart(els.video.currentTime));
els.setEnd.addEventListener('click', () => setEnd(els.video.currentTime));

document.addEventListener('keydown', (e) => {
  if (!state.info || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, select, textarea')) return;
  const key = e.key.toLowerCase();
  if (key === 'i') setStart(els.video.currentTime);
  else if (key === 'o') setEnd(els.video.currentTime);
});

els.timeline.addEventListener('pointerdown', (e) => {
  if (!state.info) return;
  const drag = e.target.dataset.handle; // 'start' | 'end' | undefined (seek)
  els.timeline.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const rect = els.timeline.getBoundingClientRect();
    const t = clamp((ev.clientX - rect.left) / rect.width, 0, 1) * state.info.duration;
    if (drag === 'start') setStart(t);
    else if (drag === 'end') setEnd(t);
    seek(drag === 'start' ? state.start : drag === 'end' ? state.end : t);
  };
  move(e);
  els.timeline.onpointermove = move;
  els.timeline.onpointerup = els.timeline.onpointercancel = () => {
    els.timeline.onpointermove = null;
  };
});

function seek(t) {
  state.playingSel = false;
  els.video.currentTime = t;
  renderHead();
}

els.playSel.addEventListener('click', () => {
  els.video.currentTime = state.start;
  state.playingSel = true;
  els.video.play();
});

els.video.addEventListener('pause', () => (state.playingSel = false));
els.video.addEventListener('play', tick);
els.video.addEventListener('seeked', renderHead);

function tick() {
  if (state.playingSel && els.video.currentTime >= state.end) {
    els.video.pause();
    els.video.currentTime = state.end;
  }
  renderHead();
  if (!els.video.paused) requestAnimationFrame(tick);
}

// --- frame grab ------------------------------------------------------------

els.grab.addEventListener('click', () => {
  const v = els.video;
  if (!v.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  canvas.getContext('2d').drawImage(v, 0, 0);
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName(state.file.name)}_${v.currentTime.toFixed(2)}s.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
});

// --- settings + plan -------------------------------------------------------

for (const el of [els.target, els.customMb, els.maxHeight, els.maxFps, els.audio, els.fpsDrop, els.lockRes]) {
  el.addEventListener('change', render);
}
els.lockRes.addEventListener('change', () => {
  els.resLabel.textContent = els.lockRes.checked ? 'Resolution' : 'Max resolution';
});
els.target.addEventListener('change', () => {
  els.customWrap.hidden = els.target.value !== 'custom';
});

function targetMB() {
  return els.target.value === 'custom' ? clamp(Number(els.customMb.value) || 20, 1, 500) : Number(els.target.value);
}

function currentPlan() {
  const { info } = state;
  return planEncode({
    srcW: info.width,
    srcH: info.height,
    srcFps: info.fps,
    duration: state.end - state.start,
    hasAudio: info.hasAudio,
    targetMB: targetMB(),
    maxHeight: Number(els.maxHeight.value),
    maxFps: Number(els.maxFps.value),
    audioKbps: Number(els.audio.value),
    allowFpsDrop: els.fpsDrop.checked,
    lockResolution: els.lockRes.checked,
  });
}

function render() {
  if (!state.info) return;
  const d = state.info.duration;
  const pct = (t) => `${(t / d) * 100}%`;
  els.sel.style.left = pct(state.start);
  els.sel.style.width = pct(state.end - state.start);
  els.hStart.style.left = pct(state.start);
  els.hEnd.style.left = pct(state.end);
  els.selLen.textContent = `${fmtTime(state.end - state.start)} selected`;
  renderHead();

  const plan = currentPlan();
  if (plan.error) {
    els.plan.textContent = plan.error;
    els.plan.className = 'plan error';
    els.export.disabled = true;
    return;
  }
  const { info } = state;
  els.plan.className = plan.belowFloor ? 'plan warn' : 'plan';
  els.plan.textContent =
    `${info.width}x${info.height}@${Math.round(info.fps)} → ${plan.width}x${plan.height}@${Math.round(plan.fps)}` +
    ` · ${plan.videoKbps.toLocaleString()} kbps video` +
    (plan.audioKbps ? ` + ${plan.audioKbps} kbps audio` : ', no audio') +
    ` · ${fmtTime(state.end - state.start)}` +
    (plan.belowFloor ? ' · low bitrate for this resolution, expect blocky motion' : '');
  els.export.disabled = !!state.job;
}

function renderHead() {
  if (!state.info) return;
  els.head.style.left = `${(els.video.currentTime / state.info.duration) * 100}%`;
}

// --- export ----------------------------------------------------------------

els.export.addEventListener('click', async () => {
  const plan = currentPlan();
  if (plan.error) return;
  clearResult();
  setBusy(true);

  const job = exportClip(state.file, state.info, { start: state.start, end: state.end }, plan, {
    allowCopy: els.allowCopy.checked,
    onProgress: (p) => (els.progress.value = p),
    onStatus: (msg) => {
      els.status.textContent = msg;
      els.progress.value = 0;
    },
  });
  state.job = job;
  const t0 = performance.now();

  try {
    const res = await job.promise;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    state.resultUrl = URL.createObjectURL(res.blob);
    els.download.href = state.resultUrl;
    els.download.download = `${baseName(state.file.name)}_trim.mp4`;
    const p = res.plan;
    els.resultInfo.innerHTML = '';
    els.resultInfo.append(
      span(`${formatMB(res.blob.size)}`, 'fits'),
      ` (${Math.round((100 * res.blob.size) / p.targetBytes)}% of cap) · `,
      res.copied ? 'copied without re-encoding' : `${p.width}x${p.height}@${Math.round(p.fps)}, ${p.videoKbps} kbps`,
      ` · took ${secs}s`,
    );
    els.status.textContent = res.lostAudio ? "Done, but the audio couldn't be converted and was dropped." : 'Done.';
    els.result.hidden = false;
  } catch (err) {
    els.status.textContent = err instanceof ConversionCanceledError ? 'Canceled.' : `Failed: ${err.message ?? err}`;
    if (!(err instanceof ConversionCanceledError)) console.error(err);
  } finally {
    state.job = null;
    setBusy(false);
  }
});

els.cancel.addEventListener('click', () => state.job?.cancel());

function setBusy(busy) {
  els.export.disabled = busy;
  els.cancel.hidden = !busy;
  els.progress.hidden = !busy;
  els.progress.value = 0;
  els.change.disabled = busy;
  for (const el of els.editor.querySelectorAll('.settings input, .settings select')) el.disabled = busy;
  if (!busy) render();
}

function clearResult() {
  els.result.hidden = true;
  els.status.textContent = '';
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
}

// --- helpers ---------------------------------------------------------------

function clamp(x, lo, hi) {
  return Math.min(Math.max(x, lo), hi);
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s - m * 60).toFixed(1);
  return m ? `${m}:${sec.padStart(4, '0')}` : `${sec}s`;
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '');
}

function codecName(codec) {
  return { avc: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8' }[codec] ?? codec ?? 'unknown';
}

function span(text, cls) {
  const el = document.createElement('span');
  el.textContent = text;
  el.className = cls;
  return el;
}
