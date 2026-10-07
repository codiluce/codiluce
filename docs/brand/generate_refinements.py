"""Ten typography/proportion studies each for the Eclipse and Daybreak marks.

Run with the same fonttools[woff] and uharfbuzz dependencies as generate_logos.py.
The selected symbol geometry comes unchanged from the original vector generator.
"""
from functools import lru_cache
from pathlib import Path
import json
import shutil

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen

from generate_logos import ROOT, PALETTES, TAGLINE, font_data, symbol, svg

OUT = ROOT / 'web/public/brand-explorations/eclipse-daybreak'
FAMILIES = {'inter': 'Inter', 'geist': 'Geist', 'archivo': 'Archivo',
            'space-grotesk': 'Space Grotesk', 'geist-mono': 'Geist Mono',
            'fraunces': 'Fraunces', 'nunito': 'Nunito'}
STYLES = [
    dict(id='01-swiss', name='Swiss', font='inter', weight=520, word='Codiluce', nameSize=104, tracking=-2.8,
         markHeight=84, gap=32, taglineSize=24, taglineGap=17, taglineFont='inter', taglineWeight=400,
         layout='horizontal', align='block', description='A balanced symbol, medium Swiss sans, and a restrained tagline.', recommended=True),
    dict(id='02-word-first', name='Word first', font='geist', weight=640, word='Codiluce', nameSize=126, tracking=-4,
         markHeight=52, gap=26, taglineSize=22, taglineGap=20, taglineFont='geist', taglineWeight=400,
         layout='horizontal', align='name', description='A small symbol and a large, confident wordmark.'),
    dict(id='03-symbol-first', name='Symbol first', font='archivo', weight=550, word='CODILUCE', nameSize=86, tracking=1.8,
         markHeight=128, gap=42, taglineSize=23, taglineGap=18, taglineFont='inter', taglineWeight=400,
         layout='horizontal', align='block', description='A larger symbol pairs with a compact uppercase name.'),
    dict(id='04-geometric', name='Geometric', font='space-grotesk', weight=500, word='codiluce', nameSize=110, tracking=-3,
         markHeight=88, gap=32, taglineSize=29, taglineGap=13, taglineFont='space-grotesk', taglineWeight=400,
         layout='horizontal', align='block', description='Lowercase geometry and a larger, closely placed tagline.'),
    dict(id='05-air', name='Air', font='inter', weight=380, word='Codiluce', nameSize=116, tracking=-1,
         markHeight=80, gap=58, taglineSize=22, taglineGap=26, taglineFont='inter', taglineWeight=400,
         layout='horizontal', align='name', description='Lighter type, more space, and a quiet supporting tagline.'),
    dict(id='06-mono', name='Mono', font='geist-mono', weight=450, word='codiluce', nameSize=94, tracking=-2,
         markHeight=76, gap=35, taglineSize=19, taglineGap=19, taglineFont='geist-mono', taglineWeight=400,
         layout='horizontal', align='block', description='Monospaced lettering gives the logo a precise code aesthetic.'),
    dict(id='07-stacked', name='Stacked', font='space-grotesk', weight=550, word='Codiluce', nameSize=94, tracking=-3,
         markHeight=104, gap=0, taglineSize=24, taglineGap=17, taglineFont='inter', taglineWeight=400, stackGap=29,
         layout='stacked', align='center', description='The symbol sits above the name and tagline in a centered stack.'),
    dict(id='08-editorial', name='Editorial', font='fraunces', weight=440, word='Codiluce', nameSize=116, tracking=-2.8,
         markHeight=76, gap=33, taglineSize=23, taglineGap=20, taglineFont='inter', taglineWeight=400,
         layout='horizontal', align='block', description='An editorial serif wordmark contrasts with a simple sans tagline.'),
    dict(id='09-soft', name='Soft', font='nunito', weight=650, word='codiluce', nameSize=116, tracking=-2.8,
         markHeight=80, gap=31, taglineSize=26, taglineGap=14, taglineFont='nunito', taglineWeight=450,
         layout='horizontal', align='block', description='Rounded lowercase lettering and a more prominent tagline.'),
    dict(id='10-signature', name='Signature', font='geist', weight=540, word='Codiluce', nameSize=108, tracking=-3.1,
         markHeight=76, gap=28, taglineSize=26, taglineGap=24, taglineFont='geist', taglineWeight=400,
         layout='signature', align='center', description='A balanced name and symbol, with the tagline centered beneath both.', recommended=True),
]


def n(value):
    return f'{value:.7f}'.rstrip('0').rstrip('.')


@lru_cache(maxsize=None)
def shaped(text, family, weight, size, tracking=0):
    font, shaper, upem = font_data(family, weight)
    buffer = hb.Buffer()
    buffer.add_str(text)
    buffer.guess_segment_properties()
    hb.shape(shaper, buffer, {'kern': True})
    glyphs = font.getGlyphSet()
    order = font.getGlyphOrder()
    cursor = 0
    paths, boxes = [], []
    for info, position in zip(buffer.glyph_infos, buffer.glyph_positions):
        glyph = glyphs[order[info.codepoint]]
        pen = SVGPathPen(glyphs)
        glyph.draw(pen)
        offset = cursor + position.x_offset
        if pen.getCommands():
            paths.append(f'<path transform="translate({n(offset)} {n(position.y_offset)})" d="{pen.getCommands()}"/>')
        bounds = BoundsPen(glyphs)
        glyph.draw(bounds)
        if bounds.bounds:
            x1, y1, x2, y2 = bounds.bounds
            boxes.append((x1+offset, y1+position.y_offset, x2+offset, y2+position.y_offset))
        cursor += position.x_advance + tracking*upem/size
    scale = size/upem
    box = (min(b[0] for b in boxes)*scale, -max(b[3] for b in boxes)*scale,
           max(b[2] for b in boxes)*scale, -min(b[1] for b in boxes)*scale)
    return dict(paths=''.join(paths), scale=scale, box=box, width=box[2]-box[0], height=box[3]-box[1])


def text_element(shape, x, y, color):
    x -= shape['box'][0]
    y -= shape['box'][1]
    return f'<g fill="{color}" transform="translate({n(x)} {n(y)}) scale({n(shape["scale"])} {n(-shape["scale"])})">{shape["paths"]}</g>'


def composition(style, mark, palette, include_tagline=True):
    name = shaped(style['word'], style['font'], style['weight'], style['nameSize'], style['tracking'])
    tagline = shaped(TAGLINE, style['taglineFont'], style['taglineWeight'], style['taglineSize'], 0.04)
    # The actual ink bounds of the unchanged symbols. Normalize by height so
    # the circle has the specified visual size, independent of its SVG canvas.
    bx, by, bw, bh = (19, 19, 62, 62) if mark == 'eclipse' else (6, 17.4, 88, 63.6)
    scale = style['markHeight']/bh
    mw, mh = bw*scale, style['markHeight']
    nw, nh, tw, th = name['width'], name['height'], tagline['width'], tagline['height']
    tag_gap = style['taglineGap']
    elements = []
    if style['layout'] == 'stacked':
        width = max(mw, nw, tw if include_tagline else 0)
        mx, my = (width-mw)/2, 0
        nx, ny = (width-nw)/2, mh+style['stackGap']
        tx, ty = (width-tw)/2, ny+nh+tag_gap
    elif style['layout'] == 'signature':
        row_width = mw+style['gap']+nw
        width = max(row_width, tw if include_tagline else 0)
        row_offset = (width-row_width)/2
        row_height = max(mh, nh)
        mx, my = row_offset, (row_height-mh)/2
        nx, ny = row_offset+mw+style['gap'], (row_height-nh)/2
        tx, ty = (width-tw)/2, row_height+tag_gap
    else:
        block_height = nh + (tag_gap+th if include_tagline else 0)
        width = mw+style['gap']+max(nw, tw if include_tagline else 0)
        mx, my = 0, ((nh if style['align']=='name' else block_height)-mh)/2
        nx, ny = mw+style['gap'], 0
        tx, ty = nx, nh+tag_gap
    elements.append(f'<g color="{palette["ink"]}" transform="translate({n(mx-bx*scale)} {n(my-by*scale)}) scale({n(scale)})">{symbol(mark)}</g>')
    elements.append(text_element(name, nx, ny, palette['ink']))
    if include_tagline:
        elements.append(text_element(tagline, tx, ty, palette['muted']))
    min_y = min(my, ny)
    bottom = max(my+mh, ny+nh, ty+th if include_tagline else 0)
    height = bottom-min_y
    # Normalize the composition's actual upper ink edge to y=0.
    content = f'<g transform="translate(0 {n(-min_y)})">{"".join(elements)}</g>'
    return content, width, height


def artwork(style, mark, mode, compact=False, tagline=True):
    palette = PALETTES[mode]
    content, width, height = composition(style, mark, palette, tagline)
    label = f'Codiluce — {mark.title()} {style["id"][:2]} {style["name"]}'
    if tagline:
        label += f' — {TAGLINE}'
    if compact:
        pad = 12
        return svg(f'<g transform="translate({pad} {pad})">{content}</g>', label,
                   round(width+pad*2), round(height+pad*2), f'0 0 {n(width+pad*2)} {n(height+pad*2)}')
    assert width < 1000 and height < 530, (style['id'], width, height)
    background = f'<rect width="1200" height="720" fill="{palette["background"]}"/>'
    centered = f'<g transform="translate({n((1200-width)/2)} {n((720-height)/2)})">{content}</g>'
    return svg(background+centered, label, 1200, 720)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    versions = []
    for style in STYLES:
        for mark in ['eclipse', 'daybreak']:
            folder = OUT / mark / style['id']
            folder.mkdir(parents=True, exist_ok=True)
            for mode in PALETTES:
                suffix = '-light' if mode == 'light' else ''
                (folder/f'{mode}.svg').write_text(artwork(style, mark, mode))
                (folder/f'lockup{suffix}.svg').write_text(artwork(style, mark, mode, compact=True))
                (folder/f'logo{suffix}.svg').write_text(artwork(style, mark, mode, compact=True, tagline=False))
            recommended = (mark == 'eclipse' and style['id'] == '01-swiss') or (mark == 'daybreak' and style['id'] == '10-signature')
            versions.append({**style, 'mark': mark, 'path': f'{mark}/{style["id"]}', 'fontName': FAMILIES[style['font']],
                             'taglineFontName': FAMILIES[style['taglineFont']], 'recommended': recommended})
    for mark in ['eclipse','daybreak']:
        for mode in PALETTES:
            suffix = '-light' if mode == 'light' else ''
            color = PALETTES[mode]['ink']
            label = f'Codiluce {mark.title()} symbol'
            (OUT/mark/f'mark{suffix}.svg').write_text(svg(f'<g color="{color}">{symbol(mark)}</g>', label, 100, 100))
    data = {'brand':'Codiluce', 'tagline':TAGLINE, 'versions':versions, 'styles':STYLES, 'fonts':FAMILIES}
    (OUT/'versions.json').write_text(json.dumps(data, indent=2)+'\n')
    (OUT/'versions.js').write_text('window.CODILUCE_REFINEMENTS = '+json.dumps(data)+';\n')
    fonts = OUT/'fonts'
    fonts.mkdir(exist_ok=True)
    for family in FAMILIES:
        source = ROOT/f'node_modules/@fontsource-variable/{family}'
        shutil.copyfile(source/f'files/{family}-latin-wght-normal.woff2', fonts/f'{family}.woff2')
        shutil.copyfile(source/'LICENSE', fonts/f'{family}-LICENSE.txt')
    print(f'Created {len(versions)} typography/proportion studies in {OUT}')


if __name__ == '__main__':
    main()
