# Codiluce identity studies

Ten minimal logo alternatives based on a circle and a horizontal line. The last
direction, **10 · Lucent**, is the recommended refinement. The tagline is
**Bring your code to light**.

Open [the gallery](http://127.0.0.1:4300/brand-explorations/) while the local
Codiluce server is running. The standalone page is also available at
`web/public/brand-explorations/index.html` and works directly from disk.

Each direction contains transparent symbol, logo and tagline lockup SVGs,
dark and light SVG presentation cards, and matching 2400 × 1440 PNGs. Typography
is shaped with kerning and converted to vector paths, so the assets do not
require installed fonts. Geist, Inter and Archivo use the SIL Open Font License;
the preview fonts and their licenses are included.

The gallery and all downloads live in `web/public/brand-explorations/`.
`codiluce-10-logo-directions.zip` contains the complete collection. The existing
application logo is unchanged until a direction is selected.

To regenerate the vectors, install `fonttools[woff]` and `uharfbuzz`, then run
`python3 docs/brand/generate_logos.py`. Run
`node docs/brand/render_logos.mjs` to regenerate the PNGs and archive.

## Eclipse and Daybreak refinements

[Compare the twenty variations](http://127.0.0.1:4300/brand-explorations/eclipse-daybreak/):
ten versions of each selected mark, with different typefaces, weights, symbol
heights, name sizes, tagline sizes, spacing and layouts. Corresponding Eclipse
and Daybreak variants share a composition for direct comparison.

The new collection lives under `web/public/brand-explorations/eclipse-daybreak/`.
Each variant has dark/light presentation SVGs and PNGs, plus transparent SVGs
with and without the tagline. Geist, Inter, Archivo, Space Grotesk, Geist Mono,
Fraunces and Nunito provide seven typefaces. All lettering is kerned and outlined.

Run `python3 docs/brand/generate_refinements.py` and
`node docs/brand/render_refinements.mjs` to regenerate this collection.
