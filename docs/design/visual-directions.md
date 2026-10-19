# Map, agents and history: three visual directions

A proposal for review, written 2026-10-16. Nothing here is built yet. It covers three points raised that day: how the
map shows code at different depths (and how diagrams relate to the map), how agents working in real time could become
characters, and how commits, pull requests and the code's evolution could read as clearly as they do on the landing
page.

The three points share one problem. Each feature has a *set of things to show*: a tour scene's boxes, an agent's
files, a commit's changes. Those things sit at different depths and far apart on the map, and the map can only show
one depth at a time. Section 1 proposes the shared fix, and sections 2 and 3 build on it.

| Point | Proposal | Biggest decision |
|---|---|---|
| Mixed levels | Keep the isometric map. Open the path to whatever a feature shows (*the cut*). Add a flat plan view, and a *focus layout* that packs only the things shown, in their map order, at a size that reads. | Whether diagrams follow the map's geography instead of the order of their arrows. |
| Diagrams | Tour diagrams and Impact use the focus layout in plan view: the map's own blocks, gathered, with arrows along the streets. | Replace the layered `CodeDiagram`, or keep it as an opt-in. |
| Agent characters | A character per provider and a copy per session, colored by session. Poses for read, edit, search, run, test, wait and idle. Characters hop between roofs and split for parallel reads. Made from Codex `image_gen` sheets, one pose per cell, with motion done in code. | Raster sprites from image generation, or a vector rig drawn in code. |
| Change stories | A commit is a *beat*: a card plus a short choreography (removals sink, moves slide, additions grow, edits pulse, new links draw in). Beats play on a stable stage, the focus layout of everything the story touches. A PR replays its commits there. | Story pace (a few seconds per commit) beside today's time-lapse, not instead of it. |

## 1. Mixed levels

### What happens today

The map is a nested rectangle layout seen in isometric projection. Two rules decide what gets drawn:

- **Sizes are bottom-up.** A file's footprint depends only on its line count, bucketed by powers of two (`leafSide`,
  `src/projection/layout.ts:39`). A folder is as large as what it packs plus its padding. So a 200-line file is the
  same size at depth 3 or depth 9: depth alone never shrinks anything.
- **Opening is by screen size.** A folder opens (its children are drawn) when it is at least 210 px on screen
  (`openPx`, `web/lib/lod.ts:20`). The rule is the same for every folder. A file inside a closed folder is not drawn,
  and a relationship that ends there is drawn to the nearest drawn ancestor, dashed (`resolve`,
  `web/lib/renderer.ts:821`).

The second rule is where depth hurts. A deep file usually sits in a chain of small folders, and small folders reach
210 px late. Here is what that looks like on this repository's own map (the server on port 4300):

| File | Depth | Footprint | Nameable from scale | Drawn from scale |
|---|---|---|---|---|
| `src/cli.ts` | 3 | 129 | 0.23 | 0.09 |
| `src/analysis/tree-sitter/analyzer.ts` | 5 | 115 | 0.26 | 0.22 |
| `tests/fixtures/repository/frontend/src/app/(account)/users/[id]/page.tsx` | 11 | 24 | 1.25 | 4.77 |

*Nameable* is the scale where the file itself is 30 px across (`labelPx`). *Drawn* is the scale where its last folder
opens. The fixture page is big enough to name at 1.25, but it stays hidden inside `[id]/` (44 units, one file) until
4.77. That is four times the zoom the file itself needs, and twenty times the zoom that makes `src/cli.ts` readable.
Its chain `(account)/users/[id]/` is three nested floors around a single file, each with its own padding and wall
height.

So a relationship from `src/cli.ts` to that page has no good camera. The two files are about 1,050 units apart. When
the camera is far enough out to frame both, the page's end of the edge is a dashed line to `frontend/` or `app/`. When
it is close enough to draw the page, `src/cli.ts` is far off screen. A third, smaller effect: every floor raises what
it holds by 6 units, so an arc from a shallow roof to a deep one leans, and with streets on, each floor is drawn a
little further inset.

Mixed levels already exist in one place. A flow on the map opens every area that holds one of its stops, whatever the
area's size on screen (`force` in `Scene.visible`, `web/lib/scene.ts`, set at `web/lib/controller.ts:315`). That
solves *which* blocks are drawn, but not distance: at the zoom that frames a whole flow, deep stops are a few pixels
wide.

### Is a mixed-level view possible?

Yes. Any picture of the hierarchy is a *cut*: a set of nodes drawn closed, exactly one on every path from the root to
a leaf, with everything above them open. Today the cut is chosen by screen size, the same everywhere. A mixed-level view
chooses it by interest instead. What the feature is showing goes into the cut at its own depth (a file, or a symbol),
its ancestors are open, and everything else stays as coarse as possible. GitHub's file tree does a small version of
this when it shows `src/app/(account)/users/[id]` as one row.

Any view can then be described with three knobs:

1. **The cut:** which nodes are drawn as closed blocks.
2. **The sizing:** where those blocks are and how big. Either the real layout, or a *focus layout* made for the cut.
3. **The camera:** isometric, or a flat plan seen from above.

Every feature already has an *interest set* to feed the first knob: a tour scene's boxes, the entities an impact
reaches, a commit's changes, a PR's net diff, an agent's files this turn, a flow's stops, the selection and its
relations. That shared input is what sections 2 and 3 build on.

### Step 1: a better cut on the map we have

These are small changes, with no new view:

- **Open small folders early.** Open a folder when its size passes `openPx` *or* when every child would already be
  nameable, whichever comes first. Big folders keep today's rule. Small ones open as soon as their files can be read.
  The fixture page would then be drawn from 1.25 instead of 4.77. At that scale it sits about 1,350 px from
  `src/cli.ts` on screen, which still doesn't fit beside the side panels, but now only distance is in the way. The cost
  to measure is the drawing budget (7,000 primitives a frame), since more folders will be open at once.
- **Merge single-child chains.** A folder whose only child is a folder is drawn as one area named
  `(account)/users/[id]/`: one floor, one wall height, one label. This is a projection-level change, like the districts
  are, and bottom-up sizing makes it easy because nothing outside the chain moves.
- **Open the interest set's path** for the selection's relations, a tour scene, an agent's files or a commit, the way
  flows already do. The forcing belongs to the view and is never saved.
- **Name the far end.** When an edge has to end at a closed area, give that end a chip with the file's name
  (`page.tsx · in users/[id]/`). A dashed line to a folder then still says where it goes.

Together these fix "the deep end is a folder". They don't fix distance.

### Step 2: the plan view (the 2D projection)

The plan view is the same layout seen from straight above. Rectangles are axis-aligned, there are no walls and no
occlusion, and labels run horizontally, as wide as their block. The isometric projection is a fixed affine map
(`project`, `web/lib/camera.ts`), so the plan is just another affine map, and the switch between them can be animated.
In about half a second the map turns 45°, unsquashes, and its blocks sink to the ground. The layout doesn't change, so
everything stays where the reader learned it.

The plan works better wherever lines and text matter more than buildings: diagrams, arrows, dense labels. In plan,
archetype shapes need a top view, such as a glyph on the block. The renderer would have to take the projection as a
parameter in `project`, `projectedBounds`, the hit test (`hitPrism`, which assumes `ISO_Y = 0.5`), the rails, the shapes
and the labels.

### Step 3: the focus layout (the schematic)

This is the fix for distance. The focus layout packs *only the cut*, with the same packer, so the interest set ends up
close together and at a size that reads, while keeping the map's order.

- **Start from the cut:** the interest set and its ancestors, all open. In each open folder, the siblings outside the
  set are folded into one tile (`+14 files`), or dropped.
- **Merge single-child chains,** as in step 1.
- **Size each kept file by its real footprint,** clamped so that a 5-line file stays readable and a 3,000-line file
  doesn't crowd the rest. A symbol in the set opens its file, which then shows those symbols and a `+N`.
- **Pack with `layoutHierarchy`,** passing the real layout's slot order (`LayoutState`), so that what comes first on the
  map comes first here too. Slots that are missing are dropped rather than kept as holes, which needs a small new option
  on the packer. Because sizing is bottom-up, twelve files make a picture a few hundred units across, wherever on the
  map they came from.

Going from the map to the focus layout is a morph in world units. Each kept block's rectangle moves from its place on
the map to its place in the focus layout. Folder frames shrink-wrap around their blocks, merged chains close up, and
the rest of the map fades into a ground texture. The morph works with either camera: in isometric it reads as the city
gathering, in plan as the plan reorganizing. Going back plays it in reverse.

```
 map, isometric, real layout     plan, real layout                   plan, focus layout
     ◇ src     ◇ tests           ┌ src ─────┐┌ tests ────────────┐    ┌ src ──┐   ┌ …/users/[id]/ ┐
   ◇◇◇◇◇     ◇◇◇◇◇◇◇◇            │ cli.ts   ││  … fixtures …     │    │cli.ts ├──►│   page.tsx    │
    ◇ cli.ts   (page.tsx is      │          ││        ▪ page.tsx │    │ +31   │   │               │
               inside a closed   └──────────┘└───────────────────┘    └───────┘   └───────────────┘
               folder)
```

A variant worth prototyping, without promising it, is **lift**. In isometric, the focus layout floats above its region
of the map as a second level, each block on a thin stalk down to its real place. It shows *where* and *what* together,
at the cost of clutter.

### Diagrams on the focus layout

Today, a tour's diagram scene lifts its boxes off their blocks into a separate picture (`CodeDiagram`,
`web/lib/diagram-layout.ts`). The boxes sit in columns along the arrows, with a band per folder, drawn as HTML over a
dimmed map. In that picture the boxes lose their place: two files side by side on the map can end up in opposite
corners. The diagram teaches nothing about the map, and the morph has to fly boxes across the screen to cover the gap.

Proposal: a diagram scene is the focus layout of its boxes, in plan, with its arrows drawn on it.

- **Boxes** are the map's own blocks (same color, same archetype glyph), gathered. Folders are their real frames, with
  single-child chains merged.
- **Arrows** are routed at right angles along the streets between blocks, the way rails already are on the map.
  `web/lib/rails.ts` works in world units, so it only needs the focus layout's rectangles. Labels and evidence chips
  stay as they are now.
- **Direction** comes from the arrows, not the layout. A pulse travels along each arrow in order (the flow-motion
  streams), and a chain is numbered when the scene reads as steps.
- **Moving between scenes** is a new cut. Blocks shared by two scenes slide, new ones rise, gone ones sink, and the
  frames follow. Map scenes and diagram scenes become the same thing at different cuts, so the morph stops being a
  special effect.

The cost is that a long chain may zig-zag, because the boxes follow the map, not the arrows. There are two answers. A
scene can ask for `"layout": "flow"`, which keeps today's layered layout as an option. Or the packer can straighten
chains inside their frames, keeping slot order but placing the arrow's start first. I would ship geography as the
default with the flow layout as a scene's opt-in, then watch which one the model picks.

**Impact as a diagram** (phase 3 of the tours) becomes the focus layout of the blast radius: the origin, the files it
reaches colored by hop, and the chains as arrows. A large radius of hundreds of files needs a budget on the cut. The
nearest hops stay as files, and the rest fold into folder tiles with counts (`app/Http/ · 23 at 2 hops`).

### And a real 3D projection?

A perspective camera with orbit and tilt (WebGL) would make the map look richer, but it doesn't touch either cause.
It doesn't change which folders are open, and perspective shrinks distant blocks, so two far-apart ends get *harder* to
show together. It also adds occlusion, an orbit to navigate, and a rewrite of the 1,450-line Canvas renderer. 3D code
cities (CodeCity, CodeCharta) tend to be good at a memorable overview and weak at reading relationships, and reading
relationships is exactly the problem here. The map already has the memorable part. Two ideas worth borrowing from 3D
instead:

- **Rotation in 90° steps** of the isometric view, for when a tall block hides what's behind it.
- **Elevation as emphasis** (the lift above). Once chains are merged, depth no longer needs to stack floors as high.

Recommendation: keep isometric as the map, add the plan as a second camera, and put the effort into the cut and the
focus layout.

## 2. Agents as characters

### What exists

Hooks report each session's reads, edits, searches, commands, tests and status (`src/activity/model.ts`). The map
outlines each touched block in the session's color, with pills such as `CC · read` above it, fading over 30 seconds
(`activityBadges`, `web/lib/renderer.ts:235`). It is accurate, but it reads like a debugger. Nothing moves between
files, so you can't see the order of the work, what runs in parallel, or who is where.

### The cast

- **One character per provider:** one for Claude Code, one for Codex, and a neutral one for anything not yet designed
  (Gemini CLI, Cursor, OpenCode, Aider…). The designs should be original: hints of each product's palette, but none of
  their logos or mascots. Claude Code already has its own pixel mascot.
- **A copy per session,** wearing the session's color (a scarf or a badge), with the session title on hover. Two Claude
  Code sessions are two characters.
- **Subagents** split off as small copies of their parent when the provider reports an agent id, and rejoin when they
  stop.

### What each observation looks like

| Observation | Character |
|---|---|
| Read | Hops to the file and stands on its roof, holding a magnifying glass over it. |
| Several reads at once (a batched `cat`, parallel tool calls) | Splits into translucent copies, one per file. They rejoin as the reads complete. |
| Edit | Notebook and pencil on the roof. The block wears scaffolding until the edit completes, then flashes. |
| Search | Binoculars, or a sweeping flashlight cone, over the folder it searched. The folder keeps its dashed outline. |
| Command | Opens a laptop where it stands, since commands report no file. |
| Test | Holds a flask. A check bubble when the run completes, a cross when the hook reports a failure. |
| Waiting for permission | Raises a hand with a `?`. The bubble pulses, and clicking it opens the session. |
| Idle | Sits down, and after a while sleeps (`z`). |
| Finished | Waves and fades out. |
| No news for 5 minutes | Greyed out: the status is unknown, which isn't the same as idle. |

This keeps the activity feed's rule: show only what was observed, never inferred intent. A character never goes to a
file it wasn't reported at, and between two observations it stays where it was.

### On the map

- **Screen-sized.** Characters are billboards about 40 px tall at any zoom, standing on the drawn block. When the file
  is hidden, they stand on the nearest open area, as today's badges do. Zoomed far out, they shrink to a face pin.
- **Hops** between roofs, along an arc with a shadow on the ground. A long jump is a quick leap with a dust puff.
  Walking the streets with the rails router would be prettier, but much slower to read. Hops show the order of the work
  at a glance.
- **A fading trail** of dots behind each character for its last few moves, over the existing 30-second window, so the
  path still reads after the fact.
- **Crowds:** several characters on one block fan out around the roof. Off screen, the edge arrow carries the
  character's face.
- **Follow** an agent with the camera, like the time-lapse's Follow.
- **The agent view:** the focus layout of a session's files this turn. Only the files it is working in, gathered, with
  the character hopping between them. This is the shot for marketing videos.

### Making the characters with Codex image generation

Codex has a built-in `image_gen` tool, used through its `imagegen` skill. It needs no API key on a ChatGPT plan and
saves images under `$CODEX_HOME/generated_images/`. It supports transparent backgrounds when asked for explicitly, and
it can edit images already in the conversation, which is how a reference image keeps a character consistent. The CLI
path (`gpt-image-2`) needs an API key and doesn't do transparent backgrounds. Codex is installed on this machine
(codex-cli 0.162.1) and has already been used for images. Community skills such as Agent Sprite Forge add a sheet
workflow on top: fixed grids, a layout guide image, a magenta background, then a script that keys out the background,
splits the cells, aligns them and exports.

The plan:

1. **Model sheet first.** Draw one character front three-quarter, back three-quarter and side, until it's approved.
   Write down its identity markers (silhouette, palette, eyes, accessory) and repeat them in every later prompt.
2. **Poses, not frames.** Image models drift between frames, so each cell holds a pose and the motion is done in code:
   the arc of a hop, squash and stretch, bobbing, a wobbling prop. The poses are idle, crouch, airborne, read, write,
   search, run, test, wait, sit, sleep and wave. Two facings are enough on an isometric map, toward the viewer and away
   from them, mirrored for the other two directions. Twelve poses × two facings fit in two 4×3 sheets per character.
3. **One sheet per group of actions,** made by editing from the approved model sheet. Use a fixed grid (a layout guide,
   256 px cells) on a flat key color, with the feet on the same line in every cell and nothing crossing a cell edge.
4. **Clean up with a script in the repo:** key out the background, despill, split the cells, align by the feet, use one
   scale for all cells, trim, then pack into an atlas (WebP) with a JSON manifest (frame rectangles, foot anchor,
   facing).
5. **Recolor and props.** The session color goes on a part generated in a second key color (pure green, say) and
   swapped at runtime, so one sheet serves every session. Props (magnifying glass, notebook, flask, laptop) are small
   separate sprites shared by all characters and placed in code. A new provider then only needs its body poses.
6. **A pack per provider:** `web/public/characters/<provider>/atlas.webp` plus `manifest.json`, loaded by provider
   name, with the neutral pack as the fallback.

Generate at 2× (256 px cells for a 40–48 px character at a device pixel ratio of 2). Review each sheet on a contact
sheet before anything goes into the app.

The alternative is a **vector rig**: the approved concept redrawn as a few paths (body, eyes, arms, prop) in code, like
the building shapes in `web/lib/shapes.ts`. A rig is crisp at any size, follows the themes, and animates limb by limb.
The costs are hand work for each character and a plainer look. I would start with image generation, since it's fast
and the charm is the point, and keep the rig as the fallback if consistency or themes become a problem.

### Risks

- **Noise.** Five busy sessions are five moving characters. Characters should be calm at rest (idle poses, no constant
  wobble). With reduced motion they stand still and only change pose, and the existing overlay toggle hides them.
- **Brands.** Characters stand for products by name, but their look should be ours. Check the providers' brand rules
  before characters appear on the website.
- **Cost.** Image generation counts against Codex usage, and a sheet costs several turns' worth. A pack takes a few
  dozen generations, retries included.
- **Drawing cost.** A few dozen sprites a frame is cheap on Canvas. The trails and splits are the part to measure.

## 3. Change stories: commits, pull requests and evolution

### What the landing page does that the app doesn't

The landing page's History scene (`site/components/MapDemo.tsx`) plays four commits on a small made-up repository,
about 2.3 seconds each:

- **The commit is the protagonist.** The list beside the map highlights it (sha, message, author, an *agent* tag,
  `+2 added ~1 modified`), and a playhead moves along a timeline with a tick per commit.
- **The changes happen in time.** New buildings grow out of the ground in green and fade to their normal color.
  Modified ones glow. Removed ones turn red and sink.
- **Every changed building is labeled** on its roof (`+ ResetForm`, `~ routes`, `− TokenHelper`).
- **Everything fits.** The whole repository is on screen, at a size where labels read.

The app has most of the ingredients. Compare tints changed blocks, adds glyphs and ghosts, dims the unchanged ones,
and can split into places. The time-lapse plays every indexed commit: blocks rise (520 ms), changed blocks flash
(900 ms), and a Follow camera tracks the changes. What's missing:

- **Pace.** Playback runs at 2 to 24 commits a second (`playbackRate`, `web/lib/store.ts:996`), sized so the whole
  history plays in about 40 seconds. A commit is on screen for less time than its own flash.
- **Scale.** The real map is shown whole, so a commit's ten files are specks at overview zoom and their labels are
  hidden. Changes at different depths are the mixed-level problem again.
- **Story.** Nothing says what a commit is about while it plays. Commit notes (`annotate`) and commit runs (themes
  across consecutive commits) exist, but they aren't part of playback.
- **Removal.** A ghost stays for one frame instead of visibly leaving.

### Proposal: stories on a stable stage

A **story** is an ordered list of *beats*. Each beat is a commit or, for live work, a batch of uncommitted changes. The
story's **stage** is the focus layout of everything it touches, computed once on the timeline layout (`timelineLayout`,
the union of all history), so places never move during the story. The stage is what makes the landing page work:
small, stable, and everything labeled. Any real PR can have one.

A beat takes about 2.5 seconds at 1×:

1. **The card:** the title (the commit note's title when the commit is annotated, otherwise its subject), the author
   or agent, when, the counts, and one line about what changed. That line is the note's summary when there is one.
   Otherwise it's generated from the indexed changes at no cost: *adds route POST /password/email; changes the
   signature of AuthService.attempt; removes TokenHelper*.
2. **Removals** turn red and sink.
3. **Moves** slide from their old place to the new one. Lineage already knows the predecessor (`previousId`,
   `previousPath`).
4. **Additions** grow out of the ground in green and settle to their own color.
5. **Modifications** pulse, with small glyphs for what changed, taken from the change facets: signature, definition,
   relations, size, renamed.
6. **Relationships** the commit added draw in. Removed ones turn dashed and fade (relations already carry
   `change: added | removed`).
7. **Labels** with `+`, `~` or `−` go on the changed blocks, most significant first. The rest are folded per folder
   (`src/projection/ · 9 modified`).

Clicking a changed block during or after a beat opens its diff (`/api/source/diff`). Very large commits, such as
generated code or a renamed folder, fold into folder tiles that pulse together, with their counts.

### Where stories come from

- **A pull request.** *Replay* plays its commits on the stage of its net diff, then ends on the net diff itself, with
  its blast radius (`impact-pull`) as a ring of dimmer blocks. A squash-merged PR is a single beat. Replaying an open
  PR commit by commit means indexing its branch, which waits on the layout-registry fix described in
  [branches-and-worktrees.md](branches-and-worktrees.md). Until then, open PRs replay as one beat of their net diff.
- **A range:** a day, a week, a release, the last N commits of main. Commit runs become chapters, each with its own
  title card.
- **The working tree:** uncommitted changes as one live beat that keeps updating. This is where agents come in.
- **Long histories** keep today's time-lapse (fast, unlabeled), with two changes: ranges under about 30 commits play as
  stories, and chapters (runs) show as titles while the time-lapse plays.

### With characters

Each beat is performed by its author: a person avatar (initials, in their People color) for people, and the provider's
character for commits made by agents. Agent commits can be detected from `Co-authored-by` trailers, which
`src/history/authors.ts` already parses, and from known agent addresses. The character hops to each changed file in the
beat's order, holding a hammer for additions, the notebook for edits and an eraser for removals. For live work it's the
same session character as in section 2, so watching an agent work and replaying its branch look the same.

## How the three fit together

```
interest set ──► cut ──► sizing (map | focus layout) ──► camera (isometric | plan) ──► overlays
  tour scene                                                                             arrows on the streets
  impact radius                                                                          characters
  commit, PR, range                                                                      change choreography
  agent's files this turn                                                                labels, chips
  flow stops, selection
```

A suggested order, in which each step is useful on its own:

1. **A better cut on the existing map** (step 1 of section 1). It's small, and it fixes dashed edges to folders
   everywhere.
2. **The focus layout** and the morph in world units, in isometric first. The layout is pure and testable, and belongs
   in `src/projection/` next to `layout.ts`.
3. **Change stories** on top of it: commit beats and PR replay. They don't need the plan view, and they're the feature
   closest to the landing page.
4. **The plan view,** then **tour diagrams** on the focus layout in plan, then **Impact** as a diagram.
5. **Characters.** Concepts and packs can start any time, since they're art. The map integration comes after step 2,
   so the agent view exists.

## Prototypes to run first

These are throwaway prototypes, to settle the design questions before building:

- **The focus layout on two real cases:** the tree-sitter tour's scenes, and a real PR of this repository. Render them
  as static pictures (isometric and plan) to judge whether geography reads as a diagram and how often a chain
  zig-zags.
- **Character concepts:** a model sheet per provider with Codex `image_gen`, then one pose sheet run through the
  cleanup script and placed on a screenshot of the map at 40 px.
- **One commit beat** with the full choreography, on one real commit's stage, to tune the pace.

## Open questions

1. Should diagrams follow geography (the map's places) with the flow layout as an opt-in, or the other way round?
2. In the focus layout, are siblings outside the set folded into a `+N` tile, kept small and dim, or dropped?
3. Is the plan view a setting for the whole map, or only a mode that some views switch to?
4. Characters: raster sprites from image generation, or a vector rig? Pixel art, like terminal mascots, or the map's
   flat style?
5. Which character packs come first? Claude Code, Codex and the neutral one?
6. Should short ranges play as stories automatically, or only when asked (*Replay*)?
7. Is the generated change line enough for story cards by default, with commit notes (a paid model call) as an
   upgrade?
