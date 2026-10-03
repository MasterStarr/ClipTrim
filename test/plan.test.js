import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planEncode } from '../src/plan.js';

const base = {
  srcW: 1920,
  srcH: 1080,
  srcFps: 60,
  hasAudio: true,
  targetMB: 10,
  maxHeight: 720,
  maxFps: 60,
  audioKbps: 96,
  allowFpsDrop: false,
};

test('short clip keeps 720p60', () => {
  const p = planEncode({ ...base, duration: 10 });
  assert.equal(p.height, 720);
  assert.equal(p.width, 1280);
  assert.equal(p.fps, 60);
  assert.equal(p.videoKbps, 7873); // 10 MiB * 0.95 * 8 / 10s - 96
});

test('thin budget steps down the ladder before touching fps', () => {
  const p = planEncode({ ...base, duration: 30 });
  assert.equal(p.videoKbps, 2560);
  assert.equal(p.height, 600);
  assert.equal(p.width, 1066);
  assert.equal(p.fps, 60);
});

test('AV1 needs fewer bits per pixel, so it holds a higher resolution', () => {
  const p = planEncode({ ...base, duration: 30, maxHeight: 1080, codec: 'av1' });
  assert.equal(p.codec, 'av1');
  assert.equal(p.height, 720); // H.264 drops to 600p on the same budget
  assert.equal(p.belowFloor, false);
});

test('allowFpsDrop halves fps at 720p instead', () => {
  const p = planEncode({ ...base, duration: 30, allowFpsDrop: true });
  assert.equal(p.height, 720);
  assert.equal(p.fps, 30);
});

test('lockResolution holds the height and thins the bitrate instead', () => {
  const p = planEncode({ ...base, duration: 30, maxHeight: 1080, lockResolution: true });
  assert.equal(p.height, 1080);
  assert.equal(p.width, 1920);
  assert.equal(p.fps, 60);
  assert.equal(p.videoKbps, 2560);
  assert.equal(p.belowFloor, true);
});

test('lockResolution still allows the opt-in fps drop, at any height', () => {
  const p = planEncode({ ...base, duration: 30, maxHeight: 1080, lockResolution: true, allowFpsDrop: true });
  assert.equal(p.height, 1080);
  assert.equal(p.fps, 30);
});

test('lockResolution never upscales past the source', () => {
  const p = planEncode({ ...base, srcW: 1280, srcH: 720, duration: 10, maxHeight: 1080, lockResolution: true });
  assert.equal(p.height, 720);
});

test('never upscales past the source', () => {
  const p = planEncode({ ...base, srcW: 854, srcH: 480, duration: 5, maxHeight: 1080 });
  assert.equal(p.height, 480);
  assert.equal(p.width, 854);
});

test('clip with no audio track gives audio budget to video', () => {
  const p = planEncode({ ...base, duration: 10, hasAudio: false });
  assert.equal(p.audioKbps, 0);
  assert.equal(p.videoKbps, 7969);
});

test('too long for the cap is an error', () => {
  const p = planEncode({ ...base, duration: 900 });
  assert.match(p.error, /Trim it shorter/);
});
