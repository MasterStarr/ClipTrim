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
    if (allowCopy && sameGeometry && info.codec === 'avc' && estimate <= plan.targetBytes * BUDGET_MARGIN) {
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
    const encodable = await canEncodeVideo('avc', {
      width: plan.width,
      height: plan.height,
      frameRate: plan.fps,
      quality: new Quality({ bitrate: plan.videoKbps * 1000 }),
    });
    if (!encodable) throw new Error(`This browser can't encode H.264 at ${plan.width}x${plan.height}.`);

    // Hardware encoders have no 2-pass mode, so correct against the measured
    // size instead: shrink on overshoot, and spend leftover budget on a big
    // undershoot. Keep the largest result that fits.
    let videoKbps = plan.videoKbps;
    let best = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      onStatus(attempt === 1 ? 'Encoding…' : `Encoding (pass ${attempt}, ${videoKbps} kbps)…`);
      const res = await run({
        copy: false,
        video: {
          codec: 'avc',
          width: plan.width,
          height: plan.height,
          fit: 'fill',
          frameRate: plan.fps < info.fps - 0.5 ? plan.fps : undefined,
          quality: new Quality({ bitrate: videoKbps * 1000, bitrateMode: 'constant' }),
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

      const nextKbps = Math.floor(videoKbps * ((plan.targetBytes * 0.93) / size));
      if (nextKbps < 100) break;
      onStatus(
        fits
          ? `Came in small at ${formatMB(size)}, re-encoding at ${nextKbps} kbps…`
          : `Overshot at ${formatMB(size)}, re-encoding at ${nextKbps} kbps…`,
      );
      videoKbps = nextKbps;
    }

    if (!best) throw new Error(`Could not fit the clip under ${formatMB(plan.targetBytes)}. Trim it or lower the resolution.`);
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

const even = (x) => Math.round(x / 2) * 2;
const toBlob = (buffer) => new Blob([buffer], { type: 'video/mp4' });

function describeDiscarded(discarded) {
  const video = discarded.find((d) => d.track.isVideoTrack());
  switch (video?.reason) {
    case 'undecodable_source_codec':
      return "This browser can't decode the clip's video codec. Try Chrome or Edge.";
    case 'no_encodable_target_codec':
      return "This browser can't encode H.264 video. Try Chrome or Edge.";
    case 'cannot_copy':
      return 'The video could not be copied without re-encoding.';
    default:
      return `Conversion failed (${video?.reason ?? 'no usable tracks'}).`;
  }
}
