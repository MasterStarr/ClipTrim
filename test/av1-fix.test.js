import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fixAv1FrameSize } from '../src/av1-fix.js';

// 8 synthetic canvas frames (flat colour + a white square) encoded at 1280x720
// by Chrome's hardware AV1 encoder via raw WebCodecs, which declared a
// 1920x1088 max frame size and render size. Muxed with `ffmpeg -c:v copy`.
const fixture = () => {
  const file = readFileSync(new URL('./fixtures/av1-720-wrong-size.mp4', import.meta.url));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
};

test('rewrites the sequence header and every frame render size', () => {
  // One sequence header in av1C, one in-band on the key frame.
  const stats = fixAv1FrameSize(fixture(), 1280, 720);
  assert.equal(stats.sequenceHeaders, 2);
  assert.equal(stats.frameHeaders, 8);
});

test('a patched file reads back with the right sizes (nothing left to change)', () => {
  const buffer = fixture();
  fixAv1FrameSize(buffer, 1280, 720);
  assert.deepEqual(fixAv1FrameSize(buffer, 1280, 720), { sequenceHeaders: 0, frameHeaders: 0 });
});

test('only touches the patched fields', () => {
  const before = new Uint8Array(fixture());
  const after = new Uint8Array(fixture());
  fixAv1FrameSize(after.buffer, 1280, 720);
  let changed = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed++;
  assert.ok(changed > 0 && changed < 100, `bytes changed: ${changed}`);
});

test('ignores files without an AV1 track', () => {
  assert.equal(fixAv1FrameSize(new ArrayBuffer(64), 1280, 720), null);
});
