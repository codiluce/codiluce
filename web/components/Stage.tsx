'use client';
// A tool in the middle that draws the map itself (Focus): a canvas redrawn
// every animation frame while it is on screen, with drag to pan, the wheel to
// zoom and a click to select, and camera fitting into what the panels leave of
// it.
import { useEffect, useRef } from 'react';
import { fitBounds, panBy, zoomAround, type Bounds, type Camera, type Viewport } from '../lib/camera';
import styles from './stage.module.css';

export { styles as stageStyles };
export interface StageFrame { ctx: CanvasRenderingContext2D; viewport: Viewport; dpr: number; time: number }
/** Space the panels take over the canvas (CSS px). */
export interface Insets { left: number; right: number; top: number; bottom: number }
export const LIMITS = { min: 0.008, max: 40 };
const DRAG_PX = 4;

/**
 * A full-size canvas drawn every frame. `camera` is moved by dragging and the
 * wheel (then `onUserCamera`); a press without a drag is a click.
 */
export function useStage(draw: (frame: StageFrame) => void, camera: { current: Camera }, handlers: { onUserCamera?: () => void; onClick?: (x: number, y: number) => void; onHover?: (x: number, y: number) => void } = {}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  // Refs, not effect dependencies: re-running the effect would resize (clear) the canvas on every render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0, viewport: Viewport = { width: 1, height: 1 }, dpr = 1;
    const resize = () => {
      dpr = Math.min(3, window.devicePixelRatio || 1);
      const box = canvas.getBoundingClientRect();
      viewport = { width: Math.max(1, box.width), height: Math.max(1, box.height) };
      const width = Math.round(viewport.width * dpr), height = Math.round(viewport.height * dpr);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(canvas);
    const loop = (time: number) => {
      raf = requestAnimationFrame(loop);
      if (viewport.width <= 1 || viewport.height <= 1) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRef.current({ ctx, viewport, dpr, time });
    };
    raf = requestAnimationFrame(loop);
    let drag: { x: number; y: number; moved: boolean } | undefined;
    const local = (event: { clientX: number; clientY: number }) => { const box = canvas.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
    const down = (event: PointerEvent) => { if (event.button !== 0) return; drag = { ...local(event), moved: false }; canvas.setPointerCapture(event.pointerId); };
    const move = (event: PointerEvent) => {
      const point = local(event);
      if (!drag) { handlersRef.current.onHover?.(point.x, point.y); return; }
      if (!drag.moved && Math.hypot(point.x - drag.x, point.y - drag.y) < DRAG_PX) return;
      camera.current = panBy(camera.current, point.x - drag.x, point.y - drag.y);
      drag = { ...point, moved: true }; handlersRef.current.onUserCamera?.();
    };
    const up = (event: PointerEvent) => {
      const was = drag; drag = undefined;
      if (was && !was.moved) { const point = local(event); handlersRef.current.onClick?.(point.x, point.y); }
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = local(event);
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      camera.current = zoomAround(camera.current, viewport, point.x, point.y, Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0018)), LIMITS);
      handlersRef.current.onUserCamera?.();
    };
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', () => { drag = undefined; });
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf); observer.disconnect();
      canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('wheel', wheel);
    };
  }, [camera]);
  return ref;
}
/** A camera showing `bounds` in what the panels leave of the viewport. */
export function fitInStage(bounds: Bounds, viewport: Viewport, insets: Insets, padding = 60): Camera {
  const free: Viewport = { width: Math.max(160, viewport.width - insets.left - insets.right), height: Math.max(160, viewport.height - insets.top - insets.bottom) };
  const camera = fitBounds(bounds, free, Math.min(padding, Math.min(free.width, free.height) * 0.18), LIMITS);
  // Shift so the content sits in the middle of the free part.
  return { scale: camera.scale, x: camera.x - (insets.left - insets.right) / 2 / camera.scale, y: camera.y - (insets.top - insets.bottom) / 2 / camera.scale };
}
export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, scale: Math.exp(Math.log(a.scale) + (Math.log(b.scale) - Math.log(a.scale)) * t) };
}
export function reducedMotion(): boolean { return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
