import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  ConversionCanceledError,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny';
import { fixAv1FrameSize } from './av1-fix.js';
import { BUDGET_MARGIN, formatMB } from './plan.js';

export { ConversionCanceledError };

const openInput = (file) => new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

/** Reads what the planner needs to know about a clip. */
export async function probe(file) {
  const input = openInput(file);
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('No video track found in this file.');
    const audio = await input.getPrimaryAudioTrack();
    const [duration, width, height, codec, canDecode, stats] = await Promise.all([
      input.computeDuration(),
      video.getDisplayWidth(),
      video.getDisplayHeight(),
      video.getCodec(),
      video.canDecode(),
      video.computePacketStats(300),
    ]);
    return {
      duration,
      width,
      height,
      codec,
      canDecode,
      fps: stats.averagePacketRate || 30,
      videoBitrate: stats.averageBitrate,
      hasAudio: !!audio,
      audioCodec: audio ? await audio.getCodec() : null,
      audioBitrate: audio ? (await audio.computePacketStats(300)).averageBitrate : 0,
    };
  } finally {
    input.dispose();
  }
}

export const CODEC_NAMES = { avc: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8' };

/**
 * True when the GPU can encode AV1. Chrome answers 'prefer-hardware' queries
 * honestly: on an NVIDIA card it reports AV1/H.264 as supported but VP8/VP9
 * (which NVENC lacks) as not.
 */
export async function detectAv1Hardware() {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    const { supported } = await VideoEncoder.isConfigSupported({
      codec: 'av01.0.08M.08', // Main profile, level 4.0, 8-bit: enough for 1080p60
      width: 1920,
      height: 1080,
      bitrate: 5_000_000,
      framerate: 60,
      hardwareAcceleration: 'prefer-hardware',
    });
    return !!supported;
  } catch {
    return false;
  }
}

let aacReady;
/** Firefox and some Linux builds can't encode AAC natively; pull in the WASM encoder only then. */
function ensureAac() {
  aacReady ??= (async () => {
    if (await canEncodeAudio('aac')) return;
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
    registerAacEncoder();
  })();
  return aacReady;
}

/**
 * Trims + re-encodes to fit plan.targetBytes, or stream-copies when allowed and
 * the copy already fits. Returns { blob, copied, plan }.
 */
export function exportClip(file, info, trim, plan, { allowCopy, onProgress, onStatus }) {
  let current = null;
  let canceled = false;

  const run = async (options) => {
    if (canceled) throw new ConversionCanceledError();
    const input = openInput(file);
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });
    try {
      const conversion = await Conversion.init({
        input,
        output,
        tracks: 'primary',
        trim,
        showWarnings: false,
        ...options,
      });
      if (!conversion.isValid) throw new Error(describeDiscarded(conversion.discardedTracks));
      const lostAudio = conversion.discardedTracks.some(
        (d) => d.track.isAudioTrack() && d.reason !== 'discarded_by_user',
      );
      current = conversion;
      conversion.onProgress = onProgress;
      await conversion.execute();
      return { buffer: output.target.buffer, conversion, lostAudio };
    } finally {
      current = null;
      input.dispose();
    }
  };

  const promise = (async () => {
    const duration = trim.end - trim.start;

    // Fast path: no resize/fps change wanted and the source stream already fits
    // the cap. Copies packets untouched; the start snaps back to a keyframe.
    const sameGeometry =
      plan.width === even(info.width) && plan.height === even(info.height) && plan.fps >= info.fps - 0.5;
    const estimate = ((info.videoBitrate + (plan.audioKbps > 0 ? info.audioBitrate : 0)) / 8) * duration;
    if (allowCopy && sameGeometry && info.codec === plan.codec && estimate <= plan.targetBytes * BUDGET_MARGIN) {
      onStatus('Copying without re-encoding…');
      const res = await run({
        audio: plan.audioKbps > 0 ? undefined : { discard: true },
        copy: { mode: 'forced', boundaryPolicy: 'expand', shiftTolerance: Infinity },
      });
      const cannotCopy = res.conversion.discardedTracks.some((d) => d.reason === 'cannot_copy');
      if (!cannotCopy && res.buffer.byteLength <= plan.targetBytes) {
        return { blob: toBlob(res.buffer), copied: true, plan, lostAudio: res.lostAudio };
      }
      onStatus('Copy did not fit, re-encoding…');
    }

    if (plan.audioKbps > 0) await ensureAac();
    // Software AV1 stalls around 1 Mbps at 1080p whatever it's asked for, so
    // AV1 is hardware-only (the UI only offers it when detectAv1Hardware passes).
    const hardwareAcceleration = plan.codec === 'av1' ? 'prefer-hardware' : 'no-preference';
    const encodable = await canEncodeVideo(plan.codec, {
      width: plan.width,
      height: plan.height,
      frameRate: plan.fps,
      quality: new Quality({ bitrate: plan.videoKbps * 1000 }),
      hardwareAcceleration,
    });
    if (!encodable) {
      throw new Error(`This browser can't encode ${CODEC_NAMES[plan.codec]} at ${plan.width}x${plan.height}.`);
    }

    // Hardware encoders have no 2-pass mode, so correct against the measured
    // size instead: shrink on overshoot, and spend leftover budget on a big
    // undershoot. Keep the largest result that fits.
    let videoKbps = plan.videoKbps;
    let best = null;
    let prevSize = 0;
    let reason = '';
    for (let attempt = 1; attempt <= MAX_PASSES; attempt++) {
      onStatus(attempt === 1 ? 'Encoding…' : `${reason}, re-encoding at ${videoKbps} kbps (pass ${attempt})…`);
      const res = await run({
        copy: false,
        video: {
          codec: plan.codec,
          width: plan.width,
          height: plan.height,
          fit: 'fill',
          frameRate: plan.fps < info.fps - 0.5 ? plan.fps : undefined,
          hardwareAcceleration,
          // Not 'constant': Chrome's Windows hardware H.264 and AV1 encoders
          // pin CBR output around 1.2 Mbps whatever bitrate is asked for,
          // while VBR tracks the request (missing by a fair margin, which the
          // passes below correct).
          quality: new Quality({ bitrate: videoKbps * 1000, bitrateMode: 'variable' }),
        },
        audio:
          plan.audioKbps > 0
            ? { codec: 'aac', numberOfChannels: 2, quality: new Quality({ bitrate: plan.audioKbps * 1000 }) }
            : { discard: true },
      });
      const size = res.buffer.byteLength;
      const fits = size <= plan.targetBytes;
      if (fits && (!best || size > best.buffer.byteLength)) best = { ...res, videoKbps };

      if (fits && size >= plan.targetBytes * 0.85) break;
      if (!fits && best) break; // a boost overshot; the earlier pass is the keeper
      // The encoder hit its own ceiling (e.g. a software encoder's cap or an
      // easy scene); more bitrate won't buy anything.
      if (fits && size < prevSize * 1.05) break;
      prevSize = size;

      const nextKbps = Math.floor(videoKbps * ((plan.targetBytes * 0.93) / size));
      if (nextKbps < 100) break;
      reason = fits ? `Came in small at ${formatMB(size)}` : `Overshot at ${formatMB(size)}`;
      videoKbps = nextKbps;
    }

    if (!best) throw new Error(`Could not fit the clip under ${formatMB(plan.targetBytes)}. Trim it or lower the resolution.`);
    // See av1-fix.js: the hardware encoder declares the wrong frame size.
    if (plan.codec === 'av1') fixAv1FrameSize(best.buffer, plan.width, plan.height);
    return { blob: toBlob(best.buffer), copied: false, plan: { ...plan, videoKbps: best.videoKbps }, lostAudio: best.lostAudio };
  })();

  return {
    promise,
    cancel() {
      canceled = true;
      current?.cancel();
    },
  };
}

const MAX_PASSES = 4;
const even = (x) => Math.round(x / 2) * 2;
const toBlob = (buffer) => new Blob([buffer], { type: 'video/mp4' });

function describeDiscarded(discarded) {
  const video = discarded.find((d) => d.track.isVideoTrack());
  switch (video?.reason) {
    case 'undecodable_source_codec':
      return "This browser can't decode the clip's video codec. Try Chrome or Edge.";
    case 'no_encodable_target_codec':
      return "This browser can't encode the chosen video codec. Try H.264, or Chrome or Edge.";
    case 'cannot_copy':
      return 'The video could not be copied without re-encoding.';
    default:
      return `Conversion failed (${video?.reason ?? 'no usable tracks'}).`;
  }
}
