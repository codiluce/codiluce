# Codiluce website

The public site: home (goal, status, roadmap, contributing) and the docs. Next.js App Router, statically
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
- `public/shots/`: screenshots of Codiluce (Codiluce Dusk theme) mapping
  [BookStack](https://github.com/BookStackApp/BookStack), an open-source Laravel app. Retake them with any
  repository, at 1600 × 1000 CSS px and device scale 2, and save them as 2400 × 1500 WebP.
- Install commands, the version and links are in `lib/site.ts`.
