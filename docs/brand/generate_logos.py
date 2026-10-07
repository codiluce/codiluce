"""Draw Codiluce's ten vector identity studies, including outlined typography.

Run from the repository root with fonttools[woff] and uharfbuzz installed.
Then run `node docs/brand/render_logos.mjs` for the PNGs and download archive.
"""
from io import BytesIO
from pathlib import Path
from functools import lru_cache
import html
import json
import math
import shutil

import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'web/public/brand-explorations'
TAGLINE = 'Bring your code to light'
PALETTES = {
    'dark': {'background': '#0a0a0b', 'ink': '#f5f5f3', 'muted': '#929297'},
    'light': {'background': '#f5f5f2', 'ink': '#111113', 'muted': '#63636a'},
}
DIRECTIONS = [
    {'id': '01-latitude', 'name': 'Latitude', 'font': 'geist', 'weight': 450, 'tracking': -1.7, 'case': 'Codiluce', 'size': 106,
     'description': 'A fine circle and a quiet, uninterrupted horizon.', 'note': 'The starting point: light geometry, generous space.', 'geometry': '32-unit radius · 2.4-unit strokes', 'mark': 'latitude'},
    {'id': '02-equator', 'name': 'Equator', 'font': 'inter', 'weight': 520, 'tracking': -2.8, 'case': 'Codiluce', 'size': 104,
     'description': 'More weight. More presence. The same two elements.', 'note': 'A sturdier mark for headers and small interfaces.', 'geometry': '31-unit radius · 4-unit strokes', 'mark': 'equator'},
    {'id': '03-aperture', 'name': 'Aperture', 'font': 'geist', 'weight': 500, 'tracking': -2.4, 'case': 'codiluce', 'size': 110,
     'description': 'Open intersections let the horizontal line pass cleanly.', 'note': 'Lowercase lettering gives the precise symbol a softer voice.', 'geometry': '32-unit radius · open intersections · 2.2-unit beam', 'mark': 'aperture'},
    {'id': '04-eclipse', 'name': 'Eclipse', 'font': 'inter', 'weight': 580, 'tracking': -3.3, 'case': 'Codiluce', 'size': 104,
     'description': 'A solid disc, divided by one line of negative space.', 'note': 'The boldest silhouette in the set; immediate at icon sizes.', 'geometry': '31-unit radius · 6-unit negative-space cut', 'mark': 'eclipse'},
    {'id': '05-horizon', 'name': 'Horizon', 'font': 'archivo', 'weight': 530, 'tracking': -1.7, 'case': 'Codiluce', 'size': 106,
     'description': 'A low horizon turns the circle into a rising light.', 'note': 'The line sits slightly below the centre, without adding another shape.', 'geometry': '31-unit radius · horizon at y = 58', 'mark': 'horizon'},
    {'id': '06-ray', 'name': 'Ray', 'font': 'geist', 'weight': 550, 'tracking': -3.0, 'case': 'Codiluce', 'size': 106,
     'description': 'A longer right-hand line gives the circle direction.', 'note': 'Asymmetry introduces forward motion while keeping the mark spare.', 'geometry': '29-unit radius · 3-unit strokes · asymmetric beam', 'mark': 'ray'},
    {'id': '07-daybreak', 'name': 'Daybreak', 'font': 'inter', 'weight': 560, 'tracking': -3.1, 'case': 'Codiluce', 'size': 104,
     'description': 'An open upper arc, a solid lower half, one clear horizon.', 'note': 'The outline and solid half give the same circle a distinct rhythm.', 'geometry': '31-unit radius · 3.2-unit beam · solid lower hemisphere', 'mark': 'daybreak'},
    {'id': '08-axis', 'name': 'Axis', 'font': 'archivo', 'weight': 560, 'tracking': 0.7, 'case': 'CODILUCE', 'size': 82,
     'description': 'A restrained geometric mark and a Swiss uppercase wordmark.', 'note': 'The typographic alternative: editorial, ordered and composed.', 'geometry': '30-unit radius · 3-unit strokes · horizon at y = 44', 'mark': 'axis'},
    {'id': '09-signal', 'name': 'Signal', 'font': 'geist', 'weight': 610, 'tracking': -3.4, 'case': 'Codiluce', 'size': 104,
     'description': 'A confident beam, isolated from the circle at its junctions.', 'note': 'A stronger wordmark and controlled gaps create a technical identity.', 'geometry': '31-unit radius · 3.4-unit ring · 2.6-unit beam', 'mark': 'signal'},
    {'id': '10-lucent', 'name': 'Lucent', 'font': 'geist', 'weight': 550, 'tracking': -3.1, 'case': 'Codiluce', 'size': 108,
     'description': 'One circle. One line. Optically balanced, down to the gaps.', 'note': 'My pick: the clearest balance of character, simplicity and small-size clarity.', 'geometry': '30-unit radius · 3.6-unit ring · 3-unit beam · 7.5° junction gaps', 'mark': 'lucent', 'recommended': True},
]


def f(value):
    return f'{value:.4f}'.rstrip('0').rstrip('.')


@lru_cache(maxsize=None)
def font_data(family, weight):
    source = ROOT / f'node_modules/@fontsource-variable/{family}/files/{family}-latin-wght-normal.woff2'
    font = instantiateVariableFont(TTFont(source), {'wght': weight}, inplace=False)
    font.flavor = None
    buffer = BytesIO()
    font.save(buffer)
    face = hb.Face(buffer.getvalue())
    shaper = hb.Font(face)
    shaper.scale = (face.upem, face.upem)
    hb.ot_font_set_funcs(shaper)
    return font, shaper, face.upem


def lettering(text, family, weight, size, tracking=0):
    font, shaper, upem = font_data(family, weight)
    buffer = hb.Buffer()
    buffer.add_str(text)
    buffer.guess_segment_properties()
    hb.shape(shaper, buffer, {'kern': True})
    glyphs = font.getGlyphSet()
    order = font.getGlyphOrder()
    cursor = 0
    paths = []
    for info, position in zip(buffer.glyph_infos, buffer.glyph_positions):
        pen = SVGPathPen(glyphs)
        glyphs[order[info.codepoint]].draw(pen)
        commands = pen.getCommands()
        if commands:
            paths.append(f'<path transform="translate({f(cursor + position.x_offset)} {f(position.y_offset)})" d="{commands}"/>')
        cursor += position.x_advance + tracking * upem / size
    width = (cursor * size / upem) - tracking
    return ''.join(paths), size / upem, width


def text_at(text, family, weight, size, tracking, x, y, color):
    paths, scale, width = lettering(text, family, weight, size, tracking)
    return f'<g fill="{color}" transform="translate({f(x)} {f(y)}) scale({f(scale)} {f(-scale)})">{paths}</g>', width


def circle(radius, stroke, cx=50, cy=50):
    return f'<circle cx="{cx}" cy="{cy}" r="{radius}" fill="none" stroke="currentColor" stroke-width="{stroke}"/>'


def beam(x1, x2, width, y=50):
    return f'<path d="M {x1} {y} H {x2}" fill="none" stroke="currentColor" stroke-width="{width}"/>'


def open_circle(radius, stroke, angle):
    radians = math.radians(angle)
    dx, dy = radius * math.cos(radians), radius * math.sin(radians)
    left, right, top, bottom = map(f, [50-dx, 50+dx, 50-dy, 50+dy])
    return f'<path d="M {left} {top} A {radius} {radius} 0 0 1 {right} {top} M {right} {bottom} A {radius} {radius} 0 0 1 {left} {bottom}" fill="none" stroke="currentColor" stroke-width="{stroke}"/>'


def disc_half(radius, cut, lower=False):
    dx = math.sqrt(radius**2 - cut**2)
    left, right = f(50-dx), f(50+dx)
    y = f(50 + cut if lower else 50-cut)
    return f'<path d="M {right if lower else left} {y} A {radius} {radius} 0 0 1 {left if lower else right} {y} Z" fill="currentColor"/>'


def symbol(kind):
    if kind == 'latitude': return circle(32, 2.4) + beam(7, 93, 2.4)
    if kind == 'equator': return circle(31, 4) + beam(7, 93, 4)
    if kind == 'aperture': return open_circle(32, 2.8, 15) + beam(12, 88, 2.2)
    if kind == 'eclipse': return disc_half(31, 3) + disc_half(31, 3, True)
    if kind == 'horizon': return circle(31, 3) + beam(7, 93, 3, 58)
    if kind == 'ray': return circle(29, 3, 43) + beam(7, 98, 3)
    if kind == 'daybreak':
        upper = open_circle(31, 3.2, 12).split(' M ')[0] + '" fill="none" stroke="currentColor" stroke-width="3.2"/>'
        return upper + beam(6, 94, 3.2) + disc_half(31, 5.5, True)
    if kind == 'axis': return circle(30, 3) + beam(8, 92, 3, 44)
    if kind == 'signal': return open_circle(31, 3.4, 11) + beam(4, 96, 2.6)
    if kind == 'lucent': return open_circle(30, 3.6, 7.5) + beam(6, 94, 3)
    raise ValueError(kind)


def svg(content, label, width, height, viewbox=None):
    viewbox = viewbox or f'0 0 {width} {height}'
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="{viewbox}" role="img" aria-label="{html.escape(label, quote=True)}"><title>{html.escape(label)}</title>{content}</svg>\n'


def artwork(direction, mode, background=True, tagline=True, compact=False):
    palette = PALETTES[mode]
    _, _, width = lettering(direction['case'], direction['font'], direction['weight'], direction['size'], direction['tracking'])
    mark_size, gap = 152, 46
    total = mark_size + gap + width
    start = (1200-total)/2
    content = f'<rect width="1200" height="720" fill="{palette["background"]}"/>' if background else ''
    content += f'<g color="{palette["ink"]}" transform="translate({f(start)} 264) scale(1.52)">{symbol(direction["mark"])}</g>'
    wordmark, _ = text_at(direction['case'], direction['font'], direction['weight'], direction['size'], direction['tracking'], start+mark_size+gap, 356, palette['ink'])
    content += wordmark
    if tagline:
        claim, _ = text_at(TAGLINE, 'geist', 400, 27, 0.12, start+mark_size+gap+2, 405, palette['muted'])
        content += claim
    label = f'Codiluce — {direction["name"]}' + (f' — {TAGLINE}' if tagline else '')
    if compact:
        crop = f'{f(start-16)} 245 {f(total+32)} 205'
        return svg(content, label, round(total+32), 205, crop)
    return svg(content, label, 1200, 720)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for direction in DIRECTIONS:
        folder = OUT / direction['id']
        folder.mkdir(exist_ok=True)
        for mode in PALETTES:
            color = PALETTES[mode]['ink']
            mark = svg(f'<g color="{color}">{symbol(direction["mark"])}</g>', f'Codiluce {direction["name"]} symbol', 100, 100)
            (folder / f'mark{"-light" if mode == "light" else ""}.svg').write_text(mark)
            (folder / f'{mode}.svg').write_text(artwork(direction, mode))
            (folder / f'lockup{"-light" if mode == "light" else ""}.svg').write_text(artwork(direction, mode, background=False, compact=True))
        (folder / 'logo.svg').write_text(artwork(direction, 'dark', background=False, tagline=False, compact=True))
    (OUT / 'directions.json').write_text(json.dumps({'brand': 'Codiluce', 'tagline': TAGLINE, 'directions': DIRECTIONS}, indent=2) + '\n')
    (OUT / 'directions.js').write_text('window.CODILUCE_LOGO_DIRECTIONS = ' + json.dumps(DIRECTIONS) + ';\n')
    fonts = OUT / 'fonts'
    fonts.mkdir(exist_ok=True)
    for family in ['geist', 'inter', 'archivo']:
        source = ROOT / f'node_modules/@fontsource-variable/{family}'
        shutil.copyfile(source / f'files/{family}-latin-wght-normal.woff2', fonts / f'{family}.woff2')
        shutil.copyfile(source / 'LICENSE', fonts / f'{family}-LICENSE.txt')
    print(f'Created {len(DIRECTIONS)} directions with outlined lettering in {OUT}')


if __name__ == '__main__':
    main()
