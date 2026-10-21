# Launch video (37 s)

A 37-second launch film for Codiluce: 1920 × 1080, 60 fps, H.264 with AAC stereo. First cut on 2026-10-19 (30 s), recut
the same day (37 s) with a simpler flow, pull request review as a main feature, code health instead of the blast
radius, and a montage of quick features. The sound ends at 0:36; the end card holds one more second in silence.

| File | What |
| --- | --- |
| `codiluce-launch-37s.mp4` | Master (CRF 17, about 64 MB) |
| `codiluce-launch-37s-web.mp4` | Web version (CRF 23, about 16 MB) |
| `poster.png` | Poster frame (the end card, 0:35) |
| `source/` | Everything that renders it again |
| `previous/` | The first 30 s cut, for comparison |

The MP4 files are ignored by Git (`.gitignore` here): host them on the site or a release, not in the repository.

## Structure

120 BPM, so a beat is 0.5 s and a bar 2 s. Cuts land on beats.

| Time | Section | On screen |
| --- | --- | --- |
| 0:00–0:03 | Hook | Agent panes (Claude Code, Codex, Cursor, then a wall of them) streaming diffs. "Agents write the code now." → "Can you still follow it?" |
| 0:03–0:06 | Problem | "Pull request #2841 · opened by an agent · 41 files changed, +551 −13", then "What does it touch? / What could it break? / How does it all fit?" Everything collapses to a point of light; 0.25 s of silence. |
| 0:06–0:08.5 | Reveal | The light becomes the Eclipse mark, the wordmark slides out of it, "Bring your code to light." The mark's halves part and the map shows in the band between them. |
| 0:08.5–0:11.5 | 01 The map | "See your whole codebase." A dive from the whole repository down to the methods inside `PageRepo.php` (BookStack). |
| 0:11.5–0:15 | 02 Flows | "Follow every flow." A click on `POST /api/wishlist/{product}`: six numbered stops from the product page to the `wishlist_items` table, then the same flow in lanes (storefront). |
| 0:15–0:18 | 03 Pull requests | "Review every pull request." / "See what it changes, right on the map." PR #2841 lights its files, then Focus shows each changed file in place with its `+/−` (storefront). |
| 0:18–0:21 | 03 Pull requests | "Then your agent explains it, in reading order." The PR's explanation tour: what it touches, then "How a coupon reaches the total" morphs into a diagram. |
| 0:21–0:24 | 04 Code health | "Find the problem files." Color by → Hotspots; a click on the hottest file flies to `PageRepo.php` (BookStack). |
| 0:24–0:28 | 05 Agents | "Watch your agents work. Live." Claude Code, Codex and Cursor characters reading and editing files, Claude split into copies (BookStack). |
| 0:28–0:32 | Montage | "Know who wrote what." (People colors) / "Trace what depends on it." (Dependencies rails) / "Replay every commit." / "3D or 2D." |
| 0:32–0:37 | End card | Logo, "Bring your code to light.", `npx codiluce@latest start .` typed, "Free and open source · MIT · codiluce.com". The last hit lands at 0:35.5 and the sound fades out at 0:36; the card holds a second in silence. |

Transitions between features are a band of light sweeping down the frame, from the band of the Eclipse mark; the two
pull request beats change under a smaller band inside the window.

## What is real and what is illustrative

- **Real interface.** Every app shot is the Codiluce UI from the main checkout (HEAD 595cbba plus that day's work in
  progress, with the bundled `web/out`), captured with Playwright's fake clock one frame at a time at 2× density.
  What the shots show (flows, the PR's files and `+/−`, the tour's diagram, hotspots, people, dependencies) is what
  the app computed from the indexed code.
- **BookStack** (`examples/bookstack`): the map, code health, agents, history and 3D/2D shots. The three agent
  sessions are hook events posted to `/api/agents/events` (the characters and copies are the app's own rendering).
- **storefront, an invented repository** (flows, pull request, People, Dependencies): a Laravel API and a Next.js shop
  written by `source/demo/make_storefront.py`, with a year of generated history by invented people (Ana Ruiz, Priya
  Nair, Tom Becker…) and agents, and an agent's branch `claude/coupons-and-gift-cards` (41 files). Its index declares
  the web → api proxy in `config.yml`. The repository is not on GitHub: `source/demo/mock-github.mjs` stands in for
  the GitHub API during the capture, so the branch shows as open pull request #2841. The PR's explanation was
  published through `codiluce mcp`, as Claude Code would.
- **Illustrative.** The hook's panes (real BookStack code lines, made-up agent tasks) and "+48,906 lines changed
  today". The problem scene's numbers are the storefront PR's. The end card's `http://127.0.0.1:4300` is the default
  address, not a captured run, and so is the address bar of the windows.

## Sound

Every sound comes from [earshot](https://github.com/Leonxlnx/earshot)'s bank (0.3.0, `forge_v2r6+fit1+pluck1`),
rendered in code: no recordings, no music library. The bed is a 120 BPM groove (an 808-style kick on each bar's root
over Am – F – G – Em, claps, hats, kalimba arpeggios), lighter for one beat under the tour's morph; the effects
(whooshes on the cuts, the riser and stop-down into the reveal, impact and sub drop on the mark, UI clicks on the
cursor's presses, pops for the characters, key presses for the command) are placed on the picture's cues from
`source/timeline.js`. Every take passes `earshot sfx check`.

`earshot critique codiluce-launch-37s.mp4`: **launch-grade, 23 of 23 scored metrics in range** against its 7
reference launch films. −14.6 LUFS integrated, −1.0 dBTP (decoded AAC), realness 0.91, music presence 100 %, 91 % of
visual events with an onset within 100 ms, 1.05 s of silence at the end; `earshot sheet` finds 120 BPM and 96 % of the 23 cuts with an onset within
100 ms.

## Rendering it again

The scripts were written for this machine: they import Playwright from this checkout's `node_modules` and expect a
working directory `S` (`export S=…`) with `clips/`, `state/`, `demo/` and `video/` folders. Paths to adjust are at the
top of each file and in the `.sh` scripts.

1. **BookStack:** index it into `$S/state/bookstack` and serve it on port 4390 (`restart-server.sh`; agent activity
   lives in the server's memory, so restart it before and after the agents clip).
2. **storefront:** `rebuild-storefront.sh` generates the repository (`demo/make_storefront.py`), indexes it with the
   proxy config, points the GitHub stand-in at the branch tip, publishes the PR tour (`publish-pr-tour.mjs`) and
   serves it on port 4391 (`serve-storefront.sh`). Put the tour's ID in `clips.mjs` (`SF_TOUR`).
3. **Capture the clips:** `node source/capture.mjs <name>` for `map wishflow prfocus prtour health people deps history
   plan`, then `agents` on a fresh BookStack server. `--preview` captures at 1× for a quick look. About 1 GB of JPEG
   frames.
4. **Render the picture:** put `comp.html`, `timeline.js` and `assets/` in `$S/video/` (the composition reads
   `../clips/`), then `node source/render.mjs $S/video/frames all --workers 4` (about 7 minutes).
5. **Render the sound:** `node -e "console.log(JSON.stringify(require('./timeline.js')))" > timeline.json`, then, in a
   Python 3.10+ environment with earshot installed, `python -I source/audio.py timeline.json mix.wav`.
6. **Encode:** `ffmpeg -framerate 60 -i frames/f%05d.png -i mix.wav -c:v libx264 -preset slow -crf 17
   -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 256k -shortest codiluce-launch-37s.mp4`, and check it with
   `earshot critique` and `earshot sheet`.

Copy and timings live in `source/timeline.js`; the composition (`comp.html`) draws every frame as a function of
time, so a change there re-renders deterministically.
