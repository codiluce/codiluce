# Onboarding tour

A guided first visit to the map, designed 2026-10-19 (a grilling session). The tour walks the user through their
own repository, one thread at a time: find something, understand it, see what it is part of, what breaks if it
changes, and how it got here. Each stop does something real on their map and spotlights the control that did it.
It is offered once, on the first visit, and can be taken again from Help. Not built yet.

## Decisions

| Question | Decision |
|---|---|
| What kind of tour | A guided walk on the user's own indexed repository. Every stop acts on their map (lights a real flow, opens Impact on a real file, plays their history) and spotlights the control that does it. Not coachmarks over idle buttons, not a canned demo. |
| Who acts | Hybrid. A stop invites the user to use the lit control and continues when they do. **Next** always does it for them, so nobody gets stuck. |
| First arrival | A small welcome card once the first map has loaded: what was indexed, then *Take the 2-minute tour* · *Not now*. Never auto-plays. Dismissing it counts as seen. |
| Remembered where | `localStorage`, beside the other preferences. A second repository served at the same time on another port is another origin and offers it again; accepted. |
| Taking it again | `?` becomes a Help menu: *Take the tour*, the chapters, *Keyboard and pointer*. A `?tour` query parameter starts it (`?tour=people` starts a chapter), for links from the README, the docs and the terminal. |
| Scope | One core tour of six stops (about two minutes), then a closing card offering six chapters of one to three stops each. |
| Story | One thread: the stops follow the same file, picked from the index, so each stop builds on the one before. |
| Nothing to show | A stop whose data is missing stays, as a short *Not on yet, here's how* card with the reason and the command or setting. On the closing card, a chapter without data offers *How to turn it on* instead of *Show me*. |
| Leaving | Exit at any stop (Skip, ✕, Esc) or finishing restores what was open before: panels, center tab, selection, timeline, lens and camera. The closing card's *Show me* links are the way to stay somewhere. |
| During the tour | Nothing is blocked. The lit control is ringed and the rest dims slightly. If the user wanders off, the card stays put; **Next** and **Back** re-apply what their stop needs. |
| The words | One card anchored beside the spotlighted control: the stop's text with the repository's facts, *3 of 6*, Back · Next · Skip tour, ← and →. Explanation tours keep the bottom bar of the stage. |
| Copy | Hand-written templates filled with facts from the index (*POST /api/checkout touches 14 files in 3 folders*). No model call: instant, free, offline. Codiluce still never spends without a terminal prompt. |
| The site | Out of scope. The landing page's `MapDemo` is a scripted canvas on a made-up repository, not the web UI. A live site demo (the real UI on a pre-indexed example, its API answers recorded) is its own project; built client-side, this tour would come with it. |

## The welcome card

Shown when the map is `ready`, the tour has not been seen, no `?tour` is in the URL and no explanation tour is on
stage. It sits at the bottom left of the map, non-modal, so a deep link still shows what it links to.

> Codiluce lit up **bookstack**: 1,240 files, 86 flows, 50 commits of history.
> **Take the 2-minute tour** · Not now

Counts it can't give are left out (no history: no commits clause). *Not now*, ✕ and starting the tour all mark it
seen.

## The core tour

Each stop has two beats. **Invite** spotlights a control and asks the user to use it. **Show** is what that does on
their code, with the facts in the text. The invited action, or **Next**, moves from invite to show; **Next** on show
goes to the next stop. *The file* is the thread's file, *the flow* its flow (see [Picking the thread](#picking-the-thread)).

| # | Stop | Invite (spotlight) | Show | When there's nothing |
|---|---|---|---|---|
| 1 | Map | the map: *scroll to zoom, double-click a folder* | *This is bookstack.* The camera flies to the file's top folder and opens it: folders are places, files are blocks. | — |
| 2 | Search | the search box: *press `/`* | The box fills with the file's name and shows the result; choosing it selects the file. | — |
| 3 | Inspector + Code | the **Code** button | The file is selected: the Inspector lists what it's connected to, the rest of the map recedes, Code shows the source. | — |
| 4 | Flows | the **Flows** button | *This file is part of POST /api/checkout, which touches 14 files in 3 folders.* The flows through the file are listed, the flow lights on the map, then opens in lanes in the Flow tab. | *No entry points found*: the kinds of entry points Codiluce looks for, and a link to Languages & frameworks. |
| 5 | Impact | the **Impact** button | *Change this file and 23 places are affected, 3 hops out.* Impact on the file, hop by hop, with a word on the *Uncommitted changes* origin. | — |
| 6 | History | the **History** button, then Space | The timeline opens on the file and plays the commits that changed it. | History unavailable: the timeline's own reason and how to turn it on. History still indexing: progress, and *take this stop later from Help*. |

The closing card lists the chapters and *Done*.

## Picking the thread

Picked on the server, where the graph and Git are, by a new `GET /api/projection/onboarding`. Deterministic: ties
break by path.

1. **The flow:** among lanes flows, the most complete (`status`) that touches at least 3 files, ranked by files
   touched (capped, so one huge flow doesn't win) with a bonus for reaching tables. If there are none, the page
   (steps) flow with the most files. If there are no flows at all, there's no flow, and stop 4 shows its card.
2. **The file:** in that flow, the handler's file if something depends on it and it has at least 2 commits.
   Otherwise the flow's file with the most incoming relations. Without a flow, the most depended-on file in the
   repository.
3. **The folder:** the file's top-level folder (a child of the root).
4. **The commits:** the last few (at most 8) commits that changed the file, when history is available.

The response also carries what the welcome card and the fallbacks need:

```jsonc
{
  "repository": "bookstack",
  "counts": { "files": 1240, "flows": 86, "commits": 50 },
  "thread": {
    "folder": { "id": "…", "name": "app" },
    "file": { "id": "…", "name": "BookController.php", "dependents": 23, "hops": 3 },
    "flow": { "id": "…", "name": "POST /books", "files": 14, "folders": 3 },
    "commits": ["3fe7e5b", "…"]
  },
  "available": {
    "history": "ready",         // "ready" | "indexing" | "off" (+ reason)
    "features": false, "people": true, "pulls": false, "agents": false, "explanations": 2
  }
}
```

## Chapters

The same card and beats, continuing the thread where they can. Order as listed. Each also has a Help menu entry and
a `?tour=<key>`.

| Chapter (`key`) | Stops | When there's nothing |
|---|---|---|
| People & PRs (`people`) | Who changed *the file* (the Inspector) → People: its main author, their files lit → PRs: an open one (or the latest merged), its files and blast radius. | No authorship: why. No PRs: branches or `--pr-metadata github`. |
| Agents (`agents`) | The Agents panel: live sessions as squares on the map, copies for parallel work → a saved session's replay. | How to connect an agent (`codiluce harness setup --agent NAME`, the agents docs). |
| Explain (`explain`) | The Explain column: ask about the code, or what an agent published over MCP → a saved explanation with a tour plays its first scene. | No explanations yet: ask from the column, or ask your agent through the MCP server. |
| Features (`features`) | The Features panel: the largest feature lit, with its flows. | Not described yet: `codiluce annotate`, with its estimate first (it costs money). |
| Color by (`color`) | Color by: two lenses on the same map (code health, then one other). | — |
| Settings (`settings`) | Settings: themes, 3D or the 2D plan, building shapes, views. | — |

## Mechanics

- **State:** a store slice `onboarding?: { tour: 'core' | ChapterKey; stop: number; beat: 'invite' | 'show';
  thread?: OnboardingThread; before: Snapshot }`. Starting a tour fetches the thread (once per session),
  snapshots, then applies stop 1. An explanation tour on stage is stopped first; restore reopens its explanation,
  not its scene.
- **Stops are data:** `web/lib/onboarding.ts` holds each stop's `available(thread)`, `invite` (target, text),
  `show(store, thread)`, `done(state)` (has the user done the invited action?) and text templates. It's pure apart
  from `show`, so it's testable without a browser.
- **Spotlight and card:** controls the tour points at get `data-onboarding="flows"` and so on. An overlay with
  `pointer-events: none` rings the target's rectangle and dims the rest lightly; a `ResizeObserver` and layout
  changes re-measure it. The card is placed beside the target where it fits (below, above, left, right), by hand,
  with no positioning library. The map stops ring the map itself.
- **Keyboard:** while a tour runs it owns ← → (Back, Next) and Esc (exit), except in inputs. History's `[ ]` and
  Space keep working, and stop 6 invites Space.
- **Reduced motion:** the camera jumps instead of flying, and stop 6 steps through the commits instead of playing
  them.
- **Restore:** the snapshot holds the selection, center view, left panel (open and tab), Inspector, Code, Explain,
  timeline (open, at, vs), Impact, flow view, lens and camera. It's re-applied through store actions, the camera
  last.
- **Persistence:** `codiluce:onboarding` = `{ "seen": 1, "chapters": ["people"] }`, read and written through the
  store's injected `storage` like `codiluce:prefs`, all in try/catch. Chapters done get a check in the Help menu
  and on the closing card.
- **Entry points:** the welcome card; Help → *Take the tour* / a chapter; `?tour[=key]`, read on load and removed
  from the URL (`history.replaceState`) so a reload doesn't restart it. The store's own `#…` state is left alone.
- **Naming:** in code it's *onboarding*, because `tour`, `TourState`, `tourView` and `TourStage` already mean
  explanation tours (and the flow tour of `openFlowView`). In the UI it's *the tour*.

## Build plan

On `main`, per AGENTS.md (a routine UI feature). Other sessions commit in this checkout: edit the shared files in
place and commit only this work's hunks.

1. **Groundwork**
   - Lift the left panel (`leftOpen`, `leftTab`) and `inspectorOpen` out of `Shell`'s local state into the store,
     so the tour can open them and restore them. Today they're `useState` in `web/components/AtlasApp.tsx`.
   - Add a camera snapshot/restore to `web/lib/controller.ts`.
   - Let the store fill the search box. `SearchBox`'s query is local `useState` today.
   - Add `data-onboarding` attributes on the controls.
   - Replace the `?` button with the Help menu; the current dialog becomes *Keyboard and pointer*.
2. **Thread:** `src/projection/onboarding.ts` (picker) and the route in `src/api/projection-routes.ts`, with tests
   on a fixture repository: with flows, without flows, without history.
3. **Core tour:** `web/lib/onboarding.ts`, the store slice and actions (`startOnboarding`, `onboardingNext`,
   `onboardingBack`, `exitOnboarding`), `web/components/Onboarding.tsx` (welcome card, spotlight, step card,
   closing card), the `?tour` parameter, theme tokens and Dusk/Dawn checks.
4. **Chapters:** the six chapters and their fallbacks.
5. **Docs:** a line in the README quickstart (*a tour starts from the welcome card; take it again from ?*). The
   site docs follow with the next site update; another session has uncommitted work in `site/`.

## Tests

- `web/tests/onboarding.test.ts`:
  - The stop list from availability: every fallback is reached.
  - Invite → show on `done` and on Next.
  - Back and Next re-apply a stop after the user wandered off.
  - Snapshot → restore round trip.
  - Storage: the seen flag, chapters done, and storage that throws.
- `tests/onboarding.test.ts`: the thread picker's choices and tie-breaks.
- `web/e2e/onboarding.spec.ts`:
  - First visit shows the card with counts.
  - The core tour runs end to end through the lit controls, and with Next only.
  - Esc mid-tour restores the layout.
  - A second visit shows no card.
  - Help → *Take the tour* and `?tour=people` start it.
  - The History stop's fallback works on the history-less server.

## Later

- The live site demo (see *The site* above).
- *What's new* after an upgrade: a short tour of what changed since the version last seen (the tour version in
  `codiluce:onboarding` is the hook).
- Per-user rather than per-browser *seen* (`~/.config/codiluce`), if offering it again on a second port annoys.
