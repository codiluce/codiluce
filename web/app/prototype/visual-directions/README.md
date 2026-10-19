# PROTOTYPE (throwaway): visual directions

Three prototypes for [docs/design/visual-directions.md](../../../../docs/design/visual-directions.md), on one route.
Throwaway code: no tests, minimal error handling, shortcuts into the app renderer's internals. Do not merge into main.

```sh
npm run prototype:visual        # next dev on :4390
open http://127.0.0.1:4390/prototype/visual-directions?proto=focus&variant=A
```

The bar at the bottom switches the prototype and its variant (← → also cycle variants).

| `?proto=` | Question | Variants |
|---|---|---|
| `focus` | Does a focus layout (only the cut, packed in map order) read as a diagram? | A Gather (iso, app renderer) · B Plan (tilts from iso) · C Lift (floats above the map) · D Map plan (the real map flattened, no re-sorting, callout labels) |
| `agents` | What should agents at work look like? Characters drawn in code. | A Buddies (vector, hop) · B Pixel crew (walk the streets) · C Pins (glide, breadcrumbs) · D Pixel crew (hop roof to roof) |
| `beat` | Can one real commit read like the landing page's History scene? | A In place · B Stage (iso) · C Stage (plan) + ledger + author |

Round 2 (after review):

- Focus: **Arrow labels** cycles *placed* (scored spots along the route, kept off names, blocks, arrow ends and
  panels; a numbered badge and a legend when nothing fits), *numbered* (badges only) and *on the line* (round 1).
- Agents: Claude Code is **Clawd** (the terminal banner's mascot), Codex a **blue cloud with a `>_` face**, any other
  harness Bolt. What is about no file (thinking, writing the reply, planning, the web, a command, waiting for
  permission, resting) happens **outside**: a mat beside the map edge nearest the agent's last file. Hooks don't
  observe the model, so thinking is inferred (a prompt, or a quiet gap) and *writing the reply* only in a replay
  (the gap before a turn ends). **Model sheet** shows every character in every pose, per style.
- Beat: the flicker came from the canvas being resized (cleared) on every React render; and in C the author
  vanished while hopping to a file that had not landed yet.

Data is a snapshot in `web/public/prototype/visual-directions/`, so no server is needed (except the agents' *Live*
source, which polls `/api/agents` through the dev proxy, `CODILUCE_API`, default :4300). To refresh it:

```sh
node web/app/prototype/visual-directions/capture.mjs http://127.0.0.1:4300 http://127.0.0.1:4301
```

The first server must show this repository's map; the second must have its history indexed (commits d7c679c,
f573379, 884201a).
