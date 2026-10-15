/**
 * Where the hero's eclipse sits: between the header and the hero text, so the text never covers it. In CSS pixels
 * from the top of the hero, given its size and the top of its text. The shader draws the disc there, and the CSS
 * backdrop shown before it (or instead of it) puts its line of light at the same height, through `--horizon`.
 */
export function heroDisc(width: number, height: number, textTop: number | null) {
  const top = 64 + 28;
  const bottom = textTop === null ? height * 0.45 : textTop - 36;
  const radius = Math.max(36, Math.min((bottom - top) / 2, width * 0.28, 150));
  return { center: Math.max(top + radius, (top + bottom) / 2), radius };
}

/**
 * Runs as the hero is parsed, before its first paint, so the backdrop's line starts where the shader will draw its
 * own; again once the fonts load, as the text they reflow moves the disc.
 */
export const HORIZON_SCRIPT = `(function(){var h=document.currentScript.parentElement,place=function(){var r=h.getBoundingClientRect(),t=h.querySelector('.hero-content > :first-child'),d=(${heroDisc})(r.width,r.height,t?t.getBoundingClientRect().top-r.top:null);h.style.setProperty('--horizon',d.center+'px')};place();if(document.fonts)document.fonts.ready.then(place)})()`;
