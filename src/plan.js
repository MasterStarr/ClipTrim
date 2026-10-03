// Bitrate budget + output geometry. A straight port of CompressForDiscord.ps1:
// hold the source framerate, cap at 720p by default, and only walk down the
// resolution ladder when the budget is too thin to feed the current size.

const MB = 1024 * 1024; // binary, matching how Discord counts

// Bits per pixel per frame below which fast camera motion starts smearing.
// Movement-shooter footage is about as hostile as encoding gets, so the H.264
// floor sits above the usual 0.05 rule of thumb. AV1 holds up at roughly
// 30-40% fewer bits; its floor is a starting point to tune by eye.
export const MIN_BPP = { avc: 0.065, av1: 0.04 };

// Container overhead + rate-control overshoot. Aim 5% under the hard cap.
export const BUDGET_MARGIN = 0.95;

const LADDER = [1080, 900, 720, 600, 540, 480, 360];

const even = (x) => Math.max(2, Math.round(x / 2) * 2);

/**
 * @param {object} p
 * @param {number} p.srcW
 * @param {number} p.srcH
 * @param {number} p.srcFps
 * @param {number} p.duration   trimmed length in seconds
 * @param {boolean} p.hasAudio
 * @param {number} p.targetMB
 * @param {number} p.maxHeight
 * @param {number} p.maxFps
 * @param {number} p.audioKbps  0 strips audio
 * @param {boolean} p.allowFpsDrop
 * @param {boolean} [p.lockResolution]  hold maxHeight (capped at source) and let
 *   the bitrate thin out instead of walking down the ladder
 * @param {'avc' | 'av1'} [p.codec]  output codec, default 'avc'
 */
export function planEncode(p) {
  const codec = p.codec ?? 'avc';
  const minBpp = MIN_BPP[codec];
  const targetBytes = Math.floor(p.targetMB * MB);
  const budgetBytes = Math.floor(targetBytes * BUDGET_MARGIN);
  const audioKbps = p.hasAudio ? p.audioKbps : 0;

  const totalKbps = (budgetBytes * 8) / 1000 / p.duration;
  const videoKbps = Math.floor(totalKbps - audioKbps);
  if (videoKbps < 100) {
    return {
      error: `A ${p.duration.toFixed(1)}s clip can't fit in ${p.targetMB} MB even at 100 kbps. Trim it shorter.`,
    };
  }

  let fps = Math.min(p.srcFps, p.maxFps);
  let height = Math.min(p.srcH, p.maxHeight);
  let droppedFps = false;
  for (;;) {
    const width = even((p.srcW * height) / p.srcH);
    const bpp = (videoKbps * 1000) / (width * height * fps);
    if (bpp >= minBpp) break;
    if (p.allowFpsDrop && !droppedFps && fps > 45 && (height <= 720 || p.lockResolution)) {
      // At 720p and below the resolution ladder costs more than the
      // framerate does; halve fps once, then keep descending. With the
      // resolution locked, the fps drop is the only lever left.
      fps /= 2;
      droppedFps = true;
      continue;
    }
    if (p.lockResolution) break;
    const next = LADDER.find((h) => h < height);
    if (!next) break;
    height = next;
  }
  height = even(height);
  const width = even((p.srcW * height) / p.srcH);
  const bpp = (videoKbps * 1000) / (width * height * fps);

  return { codec, targetBytes, videoKbps, audioKbps, width, height, fps, bpp, belowFloor: bpp < minBpp };
}

export const formatMB = (bytes) => `${(bytes / MB).toFixed(1)} MB`;
