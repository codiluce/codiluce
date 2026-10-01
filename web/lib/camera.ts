// World ↔ isometric plane ↔ screen transforms. World coordinates come from the
// layout (ground plane x/y plus elevation z). The isometric projection is a
// fixed affine map; the camera (center + scale) is the only viewport state.
import type { Rect } from '@engine/projection/dto';

export interface Point { x: number; y: number }
export interface Viewport { width: number; height: number }
/** Camera center in isometric-plane units and CSS pixels per unit. */
export interface Camera { x: number; y: number; scale: number }
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
export interface ZoomLimits { min: number; max: number }

export const ISO_X = Math.cos(Math.PI / 6);
export const ISO_Y = 0.5;

export function project(x: number, y: number, z = 0): Point {
  return { x: (x - y) * ISO_X, y: (x + y) * ISO_Y - z };
}
/** Inverse of `project` for a known elevation. */
export function unproject(px: number, py: number, z = 0): Point {
  const a = px / ISO_X, b = (py + z) / ISO_Y;
  return { x: (a + b) / 2, y: (b - a) / 2 };
}
export function toScreen(camera: Camera, viewport: Viewport, point: Point): Point {
  return { x: (point.x - camera.x) * camera.scale + viewport.width / 2, y: (point.y - camera.y) * camera.scale + viewport.height / 2 };
}
export function fromScreen(camera: Camera, viewport: Viewport, screen: Point): Point {
  return { x: (screen.x - viewport.width / 2) / camera.scale + camera.x, y: (screen.y - viewport.height / 2) / camera.scale + camera.y };
}
export function worldToScreen(camera: Camera, viewport: Viewport, x: number, y: number, z = 0): Point {
  return toScreen(camera, viewport, project(x, y, z));
}
export function screenToWorld(camera: Camera, viewport: Viewport, sx: number, sy: number, z = 0): Point {
  const plane = fromScreen(camera, viewport, { x: sx, y: sy });
  return unproject(plane.x, plane.y, z);
}
/** Isometric-plane bounds of a world box (rect footprint from zBase to zTop). */
export function projectedBounds(rect: Rect, zBase: number, zTop: number): Bounds {
  return {
    minX: (rect.x - rect.y - rect.h) * ISO_X,
    maxX: (rect.x + rect.w - rect.y) * ISO_X,
    minY: (rect.x + rect.y) * ISO_Y - zTop,
    maxY: (rect.x + rect.w + rect.y + rect.h) * ISO_Y - zBase,
  };
}
/** Isometric-plane region currently on screen. */
export function visibleBounds(camera: Camera, viewport: Viewport, margin = 0): Bounds {
  const halfW = viewport.width / 2 / camera.scale + margin / camera.scale, halfH = viewport.height / 2 / camera.scale + margin / camera.scale;
  return { minX: camera.x - halfW, maxX: camera.x + halfW, minY: camera.y - halfH, maxY: camera.y + halfH };
}
export function intersects(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
export function clampScale(scale: number, limits: ZoomLimits): number { return Math.min(limits.max, Math.max(limits.min, scale)); }
/** Camera that shows `bounds` inside the viewport with `padding` CSS pixels on each side. */
export function fitBounds(bounds: Bounds, viewport: Viewport, padding: number, limits: ZoomLimits): Camera {
  const width = Math.max(1e-6, bounds.maxX - bounds.minX), height = Math.max(1e-6, bounds.maxY - bounds.minY);
  const availableW = Math.max(1, viewport.width - padding * 2), availableH = Math.max(1, viewport.height - padding * 2);
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, scale: clampScale(Math.min(availableW / width, availableH / height), limits) };
}
/** Zoom by `factor` keeping the plane point under the given screen position fixed. */
export function zoomAround(camera: Camera, viewport: Viewport, sx: number, sy: number, factor: number, limits: ZoomLimits): Camera {
  const anchor = fromScreen(camera, viewport, { x: sx, y: sy });
  const scale = clampScale(camera.scale * factor, limits);
  return { scale, x: anchor.x - (sx - viewport.width / 2) / scale, y: anchor.y - (sy - viewport.height / 2) / scale };
}
export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, x: camera.x - dx / camera.scale, y: camera.y - dy / camera.scale };
}
/**
 * Smooth zoom-and-pan path (van Wijk & Nuij, "Smooth and efficient zooming and
 * panning"): zooms out for long jumps so context stays visible. Returns an
 * interpolator over t∈[0,1] and a relative duration.
 */
export function zoomPath(from: Camera, to: Camera, viewport: Viewport): { at(t: number): Camera; length: number } {
  const rho = Math.SQRT2;
  const w0 = viewport.width / from.scale, w1 = viewport.width / to.scale;
  const dx = to.x - from.x, dy = to.y - from.y;
  const d2 = dx * dx + dy * dy, d1 = Math.sqrt(d2);
  if (d1 < 1e-9) {
    const S = Math.log(w1 / w0) / rho;
    return { length: Math.abs(S), at: t => ({ x: from.x, y: from.y, scale: viewport.width / (w0 * Math.exp(rho * t * S)) }) };
  }
  const b0 = (w1 * w1 - w0 * w0 + rho ** 4 * d2) / (2 * w0 * rho * rho * d1);
  const b1 = (w1 * w1 - w0 * w0 - rho ** 4 * d2) / (2 * w1 * rho * rho * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / rho;
  return {
    length: Math.abs(S),
    at(t) {
      if (t >= 1) return { ...to };
      const s = t * S, coshR0 = Math.cosh(r0);
      const u = (w0 / (rho * rho)) * (coshR0 * Math.tanh(rho * s + r0) - Math.sinh(r0));
      const w = (w0 * coshR0) / Math.cosh(rho * s + r0);
      return { x: from.x + (dx * u) / d1, y: from.y + (dy * u) / d1, scale: viewport.width / w };
    },
  };
}
export function easeInOut(t: number): number { return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; }
