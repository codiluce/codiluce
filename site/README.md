# Codiluce website

The public site: home (demo, goal, agents, features, stacks, contributing) and the docs. Next.js App Router, statically
exported to `out/`, so any static host works (GitHub Pages, Netlify, Cloudflare Pages, S3, nginx).

```bash
cd site
npm install
npm run dev        # http://localhost:4320
npm run build      # writes out/
npm run preview    # serves out/ on http://localhost:4321
```

- `app/page.tsx`: home. `app/docs/*`: one folder per docs page; the order lives in `lib/site.ts` (`DOCS_NAV`).
- `components/HeroShader.tsx`: the hero, a WebGL2 fragment shader. The Eclipse disc sizes itself to the space
  above the hero text. It pauses off screen and in background tabs, draws one still frame with
  `prefers-reduced-motion`, and leaves the CSS backdrop in place when WebGL2 is missing.
- `components/MapDemo.tsx`: the home page's demo under the hero, Codiluce's window playing agents, an explanation, a
  flow and the history on a made-up repository (`lib/district.ts`), drawn with the map's own shapes (`lib/shapes.ts`).
  It is scripted: keep its panels in step with the app's wording. It pauses off screen and in background tabs, and
  shows a still frame of the chosen scene with `prefers-reduced-motion`. `GoalDiff.tsx` and `AgentWork.tsx` are the
  goal and agents sections' smaller animations.
- `NEXT_RELEASE` in `lib/site.ts` lists features on main but not in the npm release; the site tags them "Next release".
  Empty it when publishing.
- `public/shots/`: screenshots of Codiluce (Codiluce Dusk theme) mapping
  [BookStack](https://github.com/BookStackApp/BookStack), an open-source wiki. Retake them with any
  repository, at 1600 × 1000 CSS px and device scale 2, and save them as 2400 × 1500 WebP.
- Install commands, the version, links, the call booking URL and the Google Analytics ID are in `lib/site.ts`.
  The Google tag (`app/layout.tsx`) is only included in production builds, so `npm run dev` is not counted.
- `public/social-preview.png`: the 1280 × 640 social card used by Open Graph and Twitter metadata.
  Regenerate from the repository root with `node site/scripts/social-preview.mjs` after installing the
  root and site dependencies and Playwright Chromium. It uses the site's fonts and a still frame of `HeroShader.tsx`.
