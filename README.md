# ClipTrim

Available at https://masterstarr.github.io/ClipTrim/

Trim a gaming clip and squeeze it under a size cap (Discord's 20 MB by default), entirely in the browser. Nothing is uploaded — decoding and encoding run locally through WebCodecs (hardware accelerated) via [Mediabunny](https://mediabunny.dev/).

- Drag the timeline handles, or press **I** / **O** to set start/end at the playhead
- Pick a size cap, max resolution, max FPS and audio bitrate
- Export → H.264 + AAC MP4 with fast-start, which Discord plays inline
- **Save frame** grabs the current frame as a full-resolution PNG

## How sizing works

Same logic as `CompressForDiscord.ps1` (`src/plan.js`):

1. Budget = cap × 0.95, divided by the trimmed duration, minus audio → video bitrate.
2. Keep the source framerate (up to Max FPS) and cap at 720p by default. If the budget is under 0.065 bits/pixel/frame, step down the ladder 1080 → 900 → 720 → 600 → 540 → 480 → 360 until it isn't (or halve the FPS first, if *Allow FPS drop* is on).
   With *Lock resolution* on, the chosen resolution is kept as-is (never upscaled past the source) and the bitrate simply thins out to fit; the plan line warns when it drops below the 0.065 floor.
3. Hardware encoders have no 2-pass mode, so the encoder checks the real output size: on overshoot it re-encodes at a scaled-down bitrate, and if it lands under 85% of the cap it re-encodes once at a higher bitrate. It keeps the largest result that fits, up to 4 passes. (Encoding uses variable bitrate: Chrome's Windows hardware encoder ignores the requested bitrate in constant-bitrate mode.)

If no resize is needed and the source H.264 stream already fits, it is copied without re-encoding (*Skip re-encode if it fits*). The start then snaps back to the previous keyframe.

## Browser support

| Source codec | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| H.264 | ✅ | ✅ | ✅ |
| HEVC | ✅ with a GPU that decodes HEVC | ⚠️ patchy | ✅ |
| AV1 | ✅ | ✅ | recent Apple hardware |

When the browser can't encode AAC natively (e.g. Firefox), a WASM AAC encoder (`@mediabunny/aac-encoder`, ~1 MB) is loaded on demand.

## Develop

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # planner unit tests
npm run build   # static site in dist/
```
