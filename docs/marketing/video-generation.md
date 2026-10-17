# Videos of agents at work, generated from the map

Codiluce already draws every connected agent session as a pixel character on the map: it hops to the files it reads and
edits, splits into copies when it works on several at once, and steps beside the map to think, run commands or wait.
A finished session can be replayed from its saved transcript. This note proposes turning that into **video
generation**: short, reproducible clips of agents working, for marketing, and the same pipeline for documentation
(pull requests, onboarding, release notes).

Status: idea, 2026-10-17. Nothing below is built yet except the inputs listed under
[What we already have](#what-we-already-have).

## Why videos

**Marketing**

- A landing-page and README loop: three or four sessions working at once on a real open-source repository, in 3D or
  in the 2D plan. The scripted demo on codiluce.com imitates this; a generated clip would show the real thing.
- Social clips: "Watch Claude Code and Codex fix the same bug", "A day of agents on BookStack in 60 seconds", vertical
  9:16 versions for short-video feeds.
- Launch videos for each release: the new feature shown on a real repository, rendered the same way every time.

**Documentation**

- **Pull requests:** a 30-second replay of the agent session that produced a pull request, attached to it. Reviewers
  see which files the agent read before editing, which it never opened, and where it ran tests.
- **Onboarding:** explanation tours (scenes on the map) exported as videos for people who will not open the app.
- **Release notes and retrospectives:** the history time-lapse of the release, with the agents' sessions over it.
- **Bug reports:** "here is what the agent did" as a clip instead of a transcript.

The point for both: videos are generated from data Codiluce already has, so they are honest (no hand-animated
claims) and cheap to regenerate when the product or the code changes.

## What a video shows

| Scene | Data | Exists in the app |
| --- | --- | --- |
| Live agents | Activity snapshot from hooks (in memory, 500 events) | Yes: characters on the map |
| Session replay | Saved transcript: prompts, replies, tool calls with timestamps and paths | Yes: **Replay on the map** |
| Several sessions at once | Several transcripts on one clock | No: one session per replay today |
| Explanation tour | Explanation scenes (map, diagram, flow) | Yes, in the Explain column |
| History time-lapse | Git file evolution, architecture snapshots | Yes, History playback |
| Flow | A request from page to table | Yes, Flows |
| Titles and captions | The video script | No |

## What we already have

- **A deterministic cast.** `web/lib/crew.ts` turns observations into actors on a clock it is given; it has no timers
  and no DOM. `sessionReplay()` turns a saved session into events on a compressed clock (at most 90 seconds, runs of
  commands with no file go by quickly, calls made together split the character).
- **A replay endpoint.** `GET /api/conversations/<id>/replay` returns a session's latest 1,000 prompts, replies and
  tool calls, each call with its paths resolved against the current map.
- **A canvas renderer** for the map and the characters (`web/lib/renderer.ts`, `web/lib/crew-map.ts`), in both
  projections, with every theme.
- **Virtual time in tests.** The site's animations are already checked with Playwright's `page.clock.install()`,
  `pauseAt` and `runFor`: frames can be produced at exact times without waiting for real time.

What is missing is a clock the map controller takes from outside (today it follows `requestAnimationFrame` and
`performance.now()`), a way to wait until every block a scene needs is loaded, and a sink that turns frames into a file.

## Approaches

### A. Record the screen with Playwright

Open the app in headless Chromium, start a replay, and let Playwright record the page (`recordVideo` on the browser
context).

- **For:** works today with no code in the app; shows the panels too.
- **Against:** WebM only, a frame rate we do not choose, dropped frames under load, real-time only (a 90-second
  replay takes 90 seconds), and the browser chrome of the app around the map.
- **Use it for:** a first marketing clip this week, and for checking that replays look right.

### B. Record the canvas in the browser (`MediaRecorder`)

`canvas.captureStream(60)` piped into a `MediaRecorder`, behind a **Record** button.

- **For:** no dependency, runs on the user's machine, the file downloads directly.
- **Against:** real-time only and dependent on the machine keeping up; WebM/VP9 in Chromium and Firefox, MP4 only
  in Safari; only the canvas (panels and captions must be drawn onto it).
- **Use it for:** a quick "record what I see" button, as the fallback of approach C.

### C. Render frame by frame in the browser (`WebCodecs` + an MP4 muxer)

The map draws each frame at an exact time from a virtual clock (1/60 s steps), and each frame goes to a
`VideoEncoder` (H.264) and into an MP4 container with a small muxer library such as Mediabunny (the successor of
`mp4-muxer`).

- **For:** smooth and reproducible; faster than real time on a fast machine and never dropping frames on a slow
  one; any size (1080 × 1920 vertical, 4K); MP4 that plays everywhere.
- **Against:** needs the injectable clock and preloading above; WebCodecs support differs by browser and codec
  (detect it with `VideoEncoder.isConfigSupported` and fall back to approach B).
- **Use it for:** the **Export video** button in the app. This is the core of the proposal.

### D. A command-line renderer (`codiluce record`)

The same frame-by-frame rendering in headless Chromium driven from the CLI: the page renders a video script, the CLI
collects frames (WebCodecs output, or PNG frames piped to `ffmpeg`) and writes MP4, WebM or GIF.

- **For:** runs in CI, so documentation videos are regenerated on each release or attached to pull requests; no
  person needs to open the app; the panels can be included because the whole page is captured.
- **Against:** heavy dependencies (a Chromium build, optionally ffmpeg). They must stay optional: installed on first
  use or as an optional package, never in the base `npx codiluce` install.
- **Use it for:** generated docs and release assets, and the GitHub Action for pull requests.

### E. Edited marketing pieces with Remotion

Remotion composes videos as React components rendered frame by frame (`useCurrentFrame()`). The map's canvas
renderer can draw inside a composition, with titles, captions, transitions, music and voice-over around it.

- **For:** real editing (cuts, titles, zooms on a character, side-by-side sessions) in code we can version.
- **Against:** another framework, and a license: Remotion is free for individuals and small teams, but larger
  companies need a paid company license. Check the current terms before adopting it.
- **Use it for:** launch videos and campaign pieces, not for the in-app export.

### Comparison

| | Fidelity | Reproducible | Runs | New dependencies | Effort |
| --- | --- | --- | --- | --- | --- |
| A. Playwright recording | Medium, drops frames | No | Dev machine | None (Playwright is a dev dependency) | Hours |
| B. MediaRecorder | Medium | No | User's browser | None | Days |
| C. WebCodecs frames | High | Yes | User's browser | MP4 muxer (small) | 1–2 weeks |
| D. `codiluce record` | High | Yes | CLI, CI | Chromium, optional ffmpeg | 1–2 weeks after C |
| E. Remotion | High, edited | Yes | Dev machine | Remotion (licensed) | Per piece |

## Recommended architecture

One pipeline, four parts, so the in-app button, the CLI and the marketing renders share everything:

1. **Video script.** A small JSON document: size, frame rate, theme, projection (3D or 2D plan), and a list of scenes
   with durations and camera moves.

   ```json
   {
     "size": [1920, 1080], "fps": 60, "theme": "dusk", "projection": "iso",
     "scenes": [
       { "kind": "title", "text": "Three agents, one afternoon", "ms": 2500 },
       { "kind": "replay", "sessions": ["claude-code:8f3a…", "codex:019a…"], "align": "real-time", "maxMs": 45000 },
       { "kind": "tour", "explanation": "how-checkout-works", "ms": 20000 },
       { "kind": "history", "from": "v0.2.0", "to": "v0.3.0", "ms": 15000 }
     ],
     "captions": true, "redact": { "paths": false, "titles": true }
   }
   ```

2. **Clock.** The map controller and the cast take time from an injected clock instead of `requestAnimationFrame`.
   In the app the clock is real time; when rendering it advances by exactly one frame after each frame is captured.
   Before a scene starts, every block it will use is loaded (the cast already knows its targets).

3. **Renderer.** The existing map renderer and characters, plus a caption layer drawn on the canvas (session squares
   and titles, the current tool, a timestamp), so exports do not depend on DOM panels.

4. **Sink.** WebCodecs + MP4 muxer (default), MediaRecorder (fallback), PNG frames for the CLI (piped to ffmpeg when
   GIF or a specific codec is asked for).

Multi-session replays need one change in the cast: replay several transcripts on one clock, aligned on their real
timestamps (`"align": "real-time"`) or started together (`"align": "start"`). The cast already handles many actors;
only `sessionReplay()` and `CrewOnMap.startReplay()` take one session today.

## In the frontend

- **Agents → session reader:** next to **Replay on the map**, **Export video…** renders that replay.
- **Explain → a tour:** **Export tour as video**.
- **History → playback:** **Export time-lapse**.
- **The export dialog:** size presets (1920 × 1080, 1080 × 1080, 1080 × 1920), theme, 3D or 2D plan, length cap,
  captions on or off, **redact paths** (show folder names only) and **hide session titles**; a progress bar with the
  frame count; the file downloads when done. Rendering happens in a hidden canvas so the visible map stays usable.
- **Reproducible links:** the dialog can copy the video script; `#video=<script>` opens the same render, and
  `codiluce record --script video.json` renders it from the command line.

## On the command line and in CI

```bash
codiluce record --session claude-code:8f3a1c2e --out replay.mp4 --size 1920x1080 --projection plan
codiluce record --script docs/videos/launch.json --out launch.mp4
```

- **Release assets:** `npm run videos` renders the scripts in `docs/videos/` on the example repositories in
  `examples/` (BookStack, as for the screenshots), for the site and the README.
- **Pull requests:** a GitHub Action indexes the branch, imports the session named in the pull request (or the
  newest one that touched its files), renders a 30-second replay and posts it as a comment or an artifact.

## Dependencies

| Need | Option | Notes |
| --- | --- | --- |
| Frame encoding in the browser | WebCodecs `VideoEncoder` | Built into the browser; feature-detect and fall back |
| MP4 container | Mediabunny (or `mp4-muxer`) | Small, no native code; MPL-2.0 or MIT, check before adding |
| Real-time fallback | `MediaRecorder`, `canvas.captureStream` | Built in |
| Headless rendering | Playwright with Chromium | Already a dev dependency; optional at runtime |
| GIF, other codecs | ffmpeg (for example `ffmpeg-static`) | Optional, large; only for the CLI |
| Animated GIF without ffmpeg | `gifenc` | For README loops under a few MB |
| Edited marketing videos | Remotion | Licensed for companies; not part of the app |

Nothing here may become a dependency of the base package: the app's export uses browser APIs plus one small muxer;
the CLI renderer and ffmpeg are optional.

## Privacy

Videos show paths, file names and session titles, and they are made to be shared. The export dialog says so, offers
redaction, and never uploads anything: rendering is local, and only the user decides where the file goes. Prompts,
replies and tool output are never drawn; captions use tool names and paths only, as the map does.

## Plan

1. **Now (marketing):** a Playwright script in `scripts/` that opens the app on BookStack, posts a scripted set of
   sessions to `/api/agents/events` (or replays saved ones), and records with `page.clock` to drive time. Output: the
   first clips for the site and social posts.
2. **Clock and preload:** make the controller's clock injectable and add scene preloading. Unit-test that two renders
   of one script produce identical frames.
3. **Export in the app:** WebCodecs + muxer, the export dialog, on session replays first.
4. **`codiluce record`:** the headless renderer and video scripts; `npm run videos` for release assets.
5. **More scenes:** several sessions on one clock, tours, history, titles and captions; the pull-request Action.
6. **Edited pieces:** Remotion compositions for launches, only if the generated clips are not enough.

## Open questions

- Should a replay video follow the camera to each file (closer, more cinematic) or keep the whole map (more honest
  about where work happens)? Probably a script option, defaulting to the whole map with gentle zooms.
- How long should a generated pull-request video be by default: 30 seconds, or the session's real length compressed?
- Do we include the Agents panel (session list with color squares) in exports, drawn onto the canvas, or keep videos
  map-only with a legend?
- Which repositories can we show publicly? Only open-source examples (BookStack, as for the screenshots), never a
  user's private code in our marketing.
