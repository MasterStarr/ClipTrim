// Chrome's Windows hardware AV1 encoder (seen on an RTX 5080) writes a sequence
// header whose max frame size is some fixed size (1920x1088 headless, the
// screen size headed) and gives every frame that same render size, regardless
// of the configured encode size. ffmpeg ignores both, but hardware-decoding
// players size their surface from them and show the real frame in the top-left
// corner of a green canvas.
//
// fixAv1FrameSize() rewrites those fields in a finished MP4 to the real size.
// Every patched field keeps its bit width, so it's an in-place overwrite: no
// sizes change and nothing needs remuxing.

const OBU_SEQUENCE_HEADER = 1;
const OBU_FRAME_HEADER = 3;
const OBU_FRAME = 6;
const OBU_REDUNDANT_FRAME_HEADER = 7;

const KEY_FRAME = 0;
const INTRA_ONLY_FRAME = 2;
const SWITCH_FRAME = 3;
const SELECT = 2; // SELECT_SCREEN_CONTENT_TOOLS / SELECT_INTEGER_MV

class Bits {
  constructor(bytes, start) {
    this.bytes = bytes;
    this.pos = start * 8;
  }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[this.pos >> 3];
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  /** Overwrites the n bits starting at the current position, advancing past them. */
  write(n, value) {
    for (let i = n - 1; i >= 0; i--) {
      const bit = Math.floor(value / 2 ** i) & 1;
      const mask = 1 << (7 - (this.pos & 7));
      if (bit) this.bytes[this.pos >> 3] |= mask;
      else this.bytes[this.pos >> 3] &= ~mask;
      this.pos++;
    }
  }
  uvlc() {
    let leadingZeros = 0;
    while (!this.read(1)) leadingZeros++;
    return leadingZeros >= 32 ? 2 ** 32 - 1 : this.read(leadingZeros) + 2 ** leadingZeros - 1;
  }
}

/** Parses (and patches) a sequence header OBU payload. Returns what frame headers need. */
function patchSequenceHeader(bytes, start, width, height, stats) {
  const b = new Bits(bytes, start);
  const seq = { decoderModelInfo: false, equalPictureInterval: false, opPoints: [] };
  b.read(3); // seq_profile
  b.read(1); // still_picture
  seq.reduced = b.read(1);
  if (seq.reduced) {
    b.read(5); // seq_level_idx[0]
    seq.opPoints.push({ idc: 0, decoderModel: false });
  } else {
    if (b.read(1)) {
      // timing_info
      b.read(32);
      b.read(32);
      seq.equalPictureInterval = b.read(1);
      if (seq.equalPictureInterval) b.uvlc();
      seq.decoderModelInfo = b.read(1);
      if (seq.decoderModelInfo) {
        seq.bufferDelayLength = b.read(5) + 1;
        b.read(32);
        seq.bufferRemovalTimeLength = b.read(5) + 1;
        seq.framePresentationTimeLength = b.read(5) + 1;
      }
    }
    const initialDisplayDelay = b.read(1);
    const count = b.read(5) + 1;
    for (let i = 0; i < count; i++) {
      const op = { idc: b.read(12), decoderModel: false };
      if (b.read(5) > 7) b.read(1); // seq_level_idx, seq_tier
      if (seq.decoderModelInfo) {
        op.decoderModel = !!b.read(1);
        if (op.decoderModel) {
          b.read(seq.bufferDelayLength);
          b.read(seq.bufferDelayLength);
          b.read(1);
        }
      }
      if (initialDisplayDelay && b.read(1)) b.read(4);
      seq.opPoints.push(op);
    }
  }
  seq.frameWidthBits = b.read(4) + 1;
  seq.frameHeightBits = b.read(4) + 1;
  const maxW = b.read(seq.frameWidthBits) + 1;
  const maxH = b.read(seq.frameHeightBits) + 1;
  if (maxW !== width || maxH !== height) {
    b.pos -= seq.frameWidthBits + seq.frameHeightBits;
    b.write(seq.frameWidthBits, width - 1);
    b.write(seq.frameHeightBits, height - 1);
    stats.sequenceHeaders++;
  }
  seq.frameIdNumbers = seq.reduced ? 0 : b.read(1);
  if (seq.frameIdNumbers) {
    seq.deltaFrameIdLength = b.read(4) + 2;
    seq.frameIdLength = b.read(3) + 1 + seq.deltaFrameIdLength;
  }
  b.read(3); // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
  seq.forceScreenContentTools = SELECT;
  seq.forceIntegerMv = SELECT;
  seq.orderHintBits = 0;
  seq.enableOrderHint = 0;
  if (!seq.reduced) {
    b.read(4); // interintra_compound, masked_compound, warped_motion, dual_filter
    seq.enableOrderHint = b.read(1);
    if (seq.enableOrderHint) b.read(2); // jnt_comp, ref_frame_mvs
    seq.forceScreenContentTools = b.read(1) ? SELECT : b.read(1);
    if (seq.forceScreenContentTools > 0) seq.forceIntegerMv = b.read(1) ? SELECT : b.read(1);
    if (seq.enableOrderHint) seq.orderHintBits = b.read(3) + 1;
  }
  seq.enableSuperres = b.read(1);
  return seq;
}

/** Parses a frame header up to its size fields and points the render size at the real size. */
function patchFrameHeader(bytes, start, seq, temporalId, spatialId, width, height, stats) {
  const b = new Bits(bytes, start);
  let frameType = KEY_FRAME;
  let showFrame = 1;
  let errorResilient = 1;
  if (!seq.reduced) {
    if (b.read(1)) return; // show_existing_frame: no size info
    frameType = b.read(2);
    showFrame = b.read(1);
    if (showFrame && seq.decoderModelInfo && !seq.equalPictureInterval) b.read(seq.framePresentationTimeLength);
    if (!showFrame) b.read(1); // showable_frame
    errorResilient = frameType === SWITCH_FRAME || (frameType === KEY_FRAME && showFrame) ? 1 : b.read(1);
  }
  const intra = frameType === KEY_FRAME || frameType === INTRA_ONLY_FRAME;
  b.read(1); // disable_cdf_update
  const screenContent = seq.forceScreenContentTools === SELECT ? b.read(1) : seq.forceScreenContentTools;
  if (screenContent && seq.forceIntegerMv === SELECT) b.read(1); // force_integer_mv
  if (seq.frameIdNumbers) b.read(seq.frameIdLength);
  const sizeOverride = frameType === SWITCH_FRAME ? 1 : seq.reduced ? 0 : b.read(1);
  b.read(seq.orderHintBits);
  if (!intra && !errorResilient) b.read(3); // primary_ref_frame
  if (seq.decoderModelInfo && b.read(1)) {
    for (const op of seq.opPoints) {
      if (!op.decoderModel) continue;
      const inTemporal = (op.idc >> temporalId) & 1;
      const inSpatial = (op.idc >> (spatialId + 8)) & 1;
      if (op.idc === 0 || (inTemporal && inSpatial)) b.read(seq.bufferRemovalTimeLength);
    }
  }
  const refreshAll = frameType === SWITCH_FRAME || (frameType === KEY_FRAME && showFrame);
  const refreshFlags = refreshAll ? 0xff : b.read(8);
  if ((!intra || refreshFlags !== 0xff) && errorResilient && seq.enableOrderHint) {
    for (let i = 0; i < 8; i++) b.read(seq.orderHintBits);
  }

  const frameAndRenderSize = () => {
    if (sizeOverride) {
      b.read(seq.frameWidthBits);
      b.read(seq.frameHeightBits);
    }
    if (seq.enableSuperres && b.read(1)) b.read(3);
    if (b.read(1)) {
      // render_and_frame_size_different
      const rw = b.read(16) + 1;
      const rh = b.read(16) + 1;
      if (rw !== width || rh !== height) {
        b.pos -= 32;
        b.write(16, width - 1);
        b.write(16, height - 1);
        stats.frameHeaders++;
      }
    }
  };

  if (intra) {
    frameAndRenderSize();
    return;
  }
  const shortSignaling = seq.enableOrderHint ? b.read(1) : 0;
  if (shortSignaling) b.read(6);
  for (let i = 0; i < 7; i++) {
    if (!shortSignaling) b.read(3);
    if (seq.frameIdNumbers) b.read(seq.deltaFrameIdLength);
  }
  if (sizeOverride && !errorResilient) {
    for (let i = 0; i < 7; i++) if (b.read(1)) return; // found_ref: size + render size come from that ref
  }
  frameAndRenderSize();
}

function readLeb128(bytes, pos) {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = bytes[pos + i];
    value += (byte & 0x7f) * 2 ** (7 * i);
    if (!(byte & 0x80)) return [value, pos + i + 1];
  }
  throw new Error('Bad leb128');
}

/** Walks the OBUs in [start, end) and patches them. Returns the latest sequence header state. */
function patchObus(bytes, start, end, seq, width, height, stats) {
  let pos = start;
  while (pos < end) {
    const header = bytes[pos];
    const type = (header >> 3) & 0xf;
    const hasExtension = (header >> 2) & 1;
    const hasSize = (header >> 1) & 1;
    let temporalId = 0;
    let spatialId = 0;
    pos++;
    if (hasExtension) {
      temporalId = bytes[pos] >> 5;
      spatialId = (bytes[pos] >> 3) & 3;
      pos++;
    }
    let size = end - pos;
    if (hasSize) [size, pos] = readLeb128(bytes, pos);
    if (type === OBU_SEQUENCE_HEADER) {
      seq = patchSequenceHeader(bytes, pos, width, height, stats);
    } else if (seq && (type === OBU_FRAME_HEADER || type === OBU_FRAME || type === OBU_REDUNDANT_FRAME_HEADER)) {
      patchFrameHeader(bytes, pos, seq, temporalId, spatialId, width, height, stats);
    }
    pos += size;
  }
  return seq;
}

// --- MP4 ---------------------------------------------------------------------

function* boxes(view, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      view.getUint8(pos + 4),
      view.getUint8(pos + 5),
      view.getUint8(pos + 6),
      view.getUint8(pos + 7),
    );
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    yield { type, start: pos, body: pos + header, end: pos + size };
    pos += size;
  }
}

const child = (view, box, type) => {
  for (const b of boxes(view, box.body, box.end)) if (b.type === type) return b;
  return null;
};

/** Finds the AV1 video track and returns { av1C, sampleRanges } or null. */
function findAv1Track(view) {
  const moov = [...boxes(view, 0, view.byteLength)].find((b) => b.type === 'moov');
  if (!moov) return null;
  for (const trak of boxes(view, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const stbl = ['mdia', 'minf', 'stbl'].reduce((box, t) => box && child(view, box, t), trak);
    const stsd = stbl && child(view, stbl, 'stsd');
    if (!stsd) continue;
    const entry = boxes(view, stsd.body + 8, stsd.end).next().value; // skip version/flags + entry_count
    if (entry?.type !== 'av01') continue;
    // VisualSampleEntry fields take 78 bytes before the child boxes.
    const av1C = [...boxes(view, entry.body + 78, entry.end)].find((b) => b.type === 'av1C');
    return { av1C, sampleRanges: sampleRanges(view, stbl) };
  }
  return null;
}

function sampleRanges(view, stbl) {
  const stsz = child(view, stbl, 'stsz');
  const stsc = child(view, stbl, 'stsc');
  const stco = child(view, stbl, 'stco') ?? child(view, stbl, 'co64');
  const fixedSize = view.getUint32(stsz.body + 4);
  const sampleCount = view.getUint32(stsz.body + 8);
  const sizeOf = (i) => fixedSize || view.getUint32(stsz.body + 12 + 4 * i);

  const chunkCount = view.getUint32(stco.body + 4);
  const chunkOffset = (i) =>
    stco.type === 'co64' ? Number(view.getBigUint64(stco.body + 8 + 8 * i)) : view.getUint32(stco.body + 8 + 4 * i);

  const runs = [];
  const runCount = view.getUint32(stsc.body + 4);
  for (let i = 0; i < runCount; i++) {
    runs.push({
      firstChunk: view.getUint32(stsc.body + 8 + 12 * i),
      perChunk: view.getUint32(stsc.body + 12 + 12 * i),
    });
  }

  const ranges = [];
  let sample = 0;
  for (let chunk = 1; chunk <= chunkCount && sample < sampleCount; chunk++) {
    const run = runs.findLast((r) => r.firstChunk <= chunk);
    let offset = chunkOffset(chunk - 1);
    for (let i = 0; i < run.perChunk && sample < sampleCount; i++, sample++) {
      const size = sizeOf(sample);
      ranges.push([offset, offset + size]);
      offset += size;
    }
  }
  return ranges;
}

/**
 * Rewrites the AV1 max frame size and per-frame render size in an MP4 (in place)
 * to width x height. Returns counts of what was changed, or null if the file has
 * no AV1 track.
 */
export function fixAv1FrameSize(buffer, width, height) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const track = findAv1Track(view);
  if (!track) return null;
  const stats = { sequenceHeaders: 0, frameHeaders: 0 };
  let seq = null;
  if (track.av1C) seq = patchObus(bytes, track.av1C.body + 4, track.av1C.end, seq, width, height, stats);
  for (const [start, end] of track.sampleRanges) seq = patchObus(bytes, start, end, seq, width, height, stats);
  return stats;
}
