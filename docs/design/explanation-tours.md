# Explanation tours

An explanation told in scenes. Each scene has a title, a short text, and a picture of the code it is about: where it
lives on the map, how its pieces relate in a diagram, or the flow it follows. The reader steps through the scenes in
the middle of the screen while the full text stays in the Explanations column. Designed 2026-10-16 (a grilling
session), built on the `feature/explanation-tours` branch. It grows the *Tour playback* idea of
[explanations.md](explanations.md).

The acceptance example: *"Explain using the Codiluce MCP how tree-sitter works"*. Its tour starts on the map
(*parsing lives in `src/analysis/tree-sitter/`*), then turns into diagrams: the pipeline hands files to the analyzer,
the analyzer asks a worker client, the client loads grammars, extraction turns syntax trees into entities, and the
per-language structure files feed it.

## Decisions

| Question | Decision |
|---|---|
| Who decides the scenes | The model, explicitly: `publish_explanation` and `update_explanation` take `scenes`. Explanations without scenes stay text; nothing is derived from headings, and older explanations are not converted. |
| When to write a tour | The model decides. Tool descriptions suggest one when an answer walks through several places or a process; a short answer stays text. |
| What a scene shows | It picks a view: **map** (where the code lives), **diagram** (how its pieces relate; the default) or **flow** (an existing flow view). |
| Map to diagram | Entering a diagram scene from the map, the camera frames the scene's code, then each box lifts off its block and glides into the diagram while the map dims to a backdrop. Diagram to diagram: shared boxes slide, new ones rise. Back to a map scene reverses it. Reduced motion crossfades. |
| Boxes | The scene's links: files, folders, symbols, tables, flows. A symbol sits inside its file's box when the file is in the scene too. Boxes group in a light frame per folder. At most 12 boxes a scene. |
| Arrows | Declared by the model: relationships between two boxes, not necessarily an import or a call ("feeds grammars to", "mirrors"). Every arrow has a label; arrows are directed unless `undirected`. When the index has a direct relationship between the two ends (or anything inside them), the arrow carries an evidence chip (`calls ×3`). Undeclared relationships are not drawn. |
| Layout | Automatic and deterministic. Directed arrows decide the columns (left to right); folders are horizontal bands, so their frames never overlap. An optional `start` box takes the first column. No layout library. |
| Text | Each scene carries its own Markdown. The full text is the intro followed by the scenes as `##` sections, so nothing is written twice. |
| Storage | In the explanation's `.md` file: each scene's section follows a `<!-- codiluce:scene {…} -->` marker holding its view, focus, start and arrows. GitHub still reads it as Markdown. Evidence and staleness are computed when read, never stored. |
| Where it plays | In the middle: opening an explanation that has a tour opens the tour there (a *Tour* tab). The column keeps the full text, the current scene's section highlighted; clicking a section jumps there. |
| Controls | A bar at the bottom of the stage: previous, next, pips, the scene's title; ← and → keys; `#explain=<id>&scene=3`. No autoplay. |
| On the stage | Pointing at a box lights its block through the dimmed map; clicking it selects it and opens its code, as a link does. The list tags tours (*▶ 6 scenes*). |
| Follow-ups | An appended answer may carry its own scenes; the tour plays the latest answer's. `replace` rewrites them. |
| Staleness | A changed box is dashed, a missing one a ghost with the reason on hover; the header keeps the *changed since* line. |
| Flow scenes | Reuse the flow view (lanes or steps) with the scene's links emphasized; nothing is redrawn. |
| Reuse | `web/lib/diagram-layout.ts` (pure layout), `CodeDiagram` (boxes, arrows, frames; knows nothing of tours) and `web/lib/map-morph.ts` (where blocks are on screen). Their API is shaped against a second consumer, Impact as a diagram, which ships later. |

## The scene input

```jsonc
{
  "intro": "Optional Markdown before the first scene",
  "scenes": [
    {
      "title": "Where parsing lives",
      "view": "map",
      "markdown": "Every language goes through [the analyzer](src/analysis/tree-sitter/analyzer.ts)…",
      "focus": ["src/analysis/tree-sitter/", "src/pipeline/index.ts"],   // optional: the scene's links otherwise
      "captions": { "src/pipeline/index.ts": "starts indexing" }       // optional: labels on the map / boxes
    },
    {
      "title": "From a file to a syntax tree",
      "markdown": "…",
      "start": "src/pipeline/index.ts",
      "arrows": [
        { "from": "src/pipeline/index.ts", "to": "src/analysis/tree-sitter/analyzer.ts", "label": "hands each file to" },
        { "from": "src/analysis/tree-sitter/client.ts", "to": "src/analysis/tree-sitter/grammars.ts", "label": "loads", "undirected": false }
      ]
    },
    { "title": "What happens on index", "view": "flow", "flow": "flow:cli index", "markdown": "…" }
  ]
}
```

- `focus` defaults to the code links of the scene's Markdown (files, folders, symbols, tables, flows), in order.
  Arrow ends join the focus when they are not in it.
- An arrow end, `start` and caption keys are links, written like the links in the text, and resolve the same way.
- Publishing refuses (with each problem) an unknown view, a flow scene without a flow, a scene with more than 12
  boxes, an arrow without a label, and links that do not resolve. At most 24 scenes.

## Stored form

```markdown
<!-- codiluce:answer at=… model=… commit=… -->
Optional intro.

<!-- codiluce:scene {"view":"diagram","start":"src/pipeline/index.ts","arrows":[…]} -->
## From a file to a syntax tree

The scene's text, with its links.
```

The turn parser ignores scene markers; `scenesOf(answer)` splits an answer into its intro and scenes. The column's
Markdown reader skips HTML comments, so an answer reads well anywhere.

## Evidence on arrows

For an arrow A → B, the server collects A and the entities inside it (a file's symbols; at most a few hundred), and
the same for B, then reads the index's relationships between the two sets, either way. The chip names the types
and counts (`calls ×3 · imports`), with the direction when it runs against the arrow. A folder end counts its files.

## Decisions taken while building

- **Left to right, or top to bottom.** A chain of five boxes left to right is unreadable in the middle beside both side
  panels, so the diagram lays itself out both ways and keeps the one that fits the stage at a larger scale (left to
  right unless top to bottom is clearly better). Bands are rows one way and columns the other.
- **Labels in the gaps.** Arrows fanning out of one box are labelled near where they arrive (fanning in: near where
  they leave), each label is held in the gap between the two layers, and overlapping labels are pushed apart.
- **Rise without a flash.** Boxes are held at their blocks with transitions off, then released, so the browser never
  animates them toward the map first.
- **The keyboard.** During a tour, ← and → step scenes, even with the map focused (the camera keeps its other keys).
  A starting tour takes focus from the empty composer, never from text being typed.
- **Clicking a box** selects it and opens its code without leaving the stage (`openFromTour`); flows and commits
  open as links do.
- **Flow scenes, for now,** light the flow on the map with a card that opens it; playing the flow view in the stage
  is phase 2.

## Phases

1. Scenes in the schema and the store, checks on publish, the tour in the middle with map and diagram scenes, the
   morph, the column in step with the stage. Acceptance: the tree-sitter tour, published over MCP.
2. Flow scenes, and staleness drawn in scenes.
3. Impact as a diagram, the reuse test of `CodeDiagram`.
