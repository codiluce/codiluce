'use client';

import { useEffect, useRef } from 'react';

/**
 * The hero background: the Eclipse mark as a light source. A dark disc is cut by a band of light that
 * becomes the horizon; under it a floor of dots and file tiles (the map's dot grid, in perspective)
 * catches the light, and amber pulses (flows) run along it into the light.
 * WebGL2 only; without it the CSS backdrop behind the canvas stays.
 */

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uRes;      // canvas size in device pixels
uniform float uTime;    // seconds
uniform float uIntro;   // 0 → 1 as the light comes on
uniform vec2 uMouse;    // smoothed pointer, -1..1
uniform vec3 uDisc;     // center (x, y) and radius, in units of the canvas height
out vec4 outColor;

const vec3 INK = vec3(0.039, 0.039, 0.043);
const vec3 AMBER = vec3(1.0, 0.749, 0.278);
const vec3 WARM = vec3(1.0, 0.92, 0.78);
const vec3 PAPER = vec3(0.96, 0.96, 0.95);

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 c = uDisc.xy;
  float R = uDisc.z;
  vec2 q = p - c;
  float t = uTime;
  float px = 1.0 / uRes.y;
  float breathe = 1.0 + 0.07 * sin(t * 0.8) + 0.03 * sin(t * 2.3);

  float d = length(q);
  float bh = R * (3.0 / 31.0) * uIntro;              // half height of the band, as in the mark
  float inDisc = 1.0 - smoothstep(R - px * 1.5, R + px * 1.5, d);
  float inBand = 1.0 - smoothstep(bh - px, bh + px, abs(q.y));
  float halves = inDisc * (1.0 - inBand);            // the two dark halves occlude what is behind them

  vec3 light = vec3(0.0);

  // Sky: a faint warm haze above the horizon.
  float above = p.y - c.y;
  if (above > 0.0) light += AMBER * 0.05 * exp(-above * 7.0) * exp(-abs(q.x) * 1.6) * uIntro;

  // Floor: dots and file tiles in perspective, lit from the horizon.
  float below = c.y - p.y;
  if (below > 0.002) {
    float z = 1.0 / below;
    float K = 13.0;
    float drift = t * 0.55;
    vec2 g = vec2((p.x + uMouse.x * 0.035 * below * 2.0) * z, z - drift) * vec2(K, K * 0.5);
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 fw = fwidth(g);
    float blur = max(fw.x, fw.y);
    float h = hash(id);

    // A dot per cell; about one cell in eight holds a file tile instead.
    float dotMask = 1.0 - smoothstep(0.07 - blur * 0.6, 0.07 + blur * 0.6, length(f * vec2(1.0, 1.0)));
    vec2 tb = abs(f) - vec2(0.26, 0.26);
    float tile = 1.0 - smoothstep(-blur * 0.6, blur * 0.6, max(tb.x, tb.y));
    float isTile = step(0.875, h);
    float mark = mix(dotMask * 0.9, tile * (0.35 + 0.65 * hash(id + 3.1)), isTile);
    // Far away the pattern is finer than a pixel: fade to its average instead of shimmering.
    float fine = smoothstep(0.18, 0.55, blur);
    mark = mix(mark, 0.05, fine);

    float spread = abs(q.x) / (0.35 + below * 1.4);
    float lit = exp(-spread * 2.2) * exp(-below * 2.6) * 1.35 + 0.05 * exp(-below * 1.5);
    float column = exp(-abs(q.x) * (26.0 - 10.0 * below)) * (0.55 + 0.45 * noise(vec2(g.y * 0.35 - t * 0.6, g.x * 0.2)));
    vec3 floorLight = mix(PAPER * 0.55, WARM, 0.55) * mark * lit + WARM * mark * column * 0.9 * exp(-below * 1.4);

    // Flows: some columns carry amber pulses that run toward the light.
    float lane = hash(vec2(id.x, 11.0));
    if (lane > 0.9 && isTile < 0.5) {
      float phase = fract(id.y * 0.045 - t * (0.1 + 0.12 * lane) + lane * 17.0);
      float pulse = smoothstep(0.78, 0.995, phase) * step(phase, 0.995);
      floorLight += AMBER * dotMask * pulse * (1.6 - fine) * exp(-below * 0.8) * (0.7 + 0.6 * lit);
    }
    // The floor fades into the dark near the viewer and close to the horizon line.
    floorLight *= smoothstep(0.0, 0.03, below) * uIntro;
    light += floorLight;
  }

  // Corona: light escaping around the rim of the disc, with slow streamers.
  if (d > R * 0.9) {
    float r = max(d - R, 0.0);
    float a = atan(q.y, q.x);
    float streamers = fbm(vec2(a * 3.0 + 7.0, r * 5.0 - t * 0.1)) * 1.7;
    float flatten = exp(-abs(q.y) * 4.0 / (R * 6.0));
    float corona = exp(-r * 70.0 / (R * 6.0)) * 0.55 + exp(-r * 13.0 / (R * 6.0)) * 0.22 * streamers + exp(-r * 4.0 / (R * 6.0)) * 0.05;
    corona *= (0.75 + 0.5 * flatten) * uIntro * breathe;
    light += mix(AMBER, WARM, exp(-r * 30.0)) * corona * (1.0 - inDisc);
  }

  // The band of light through the disc: brightest in the middle.
  float core = 1.0 - smoothstep(0.0, R, abs(q.x));
  light += mix(AMBER, PAPER, 0.35 + 0.65 * core) * inDisc * inBand * (2.2 + 2.5 * core) * breathe;

  // The streak: the band carried across the horizon, a thin bright line and a softer glow.
  float sy = abs(q.y);
  float thin = exp(-sy / (px * 1.6)) * (0.9 * exp(-abs(q.x) * 0.9) + 0.25);
  float soft = exp(-sy / (bh * 1.6 + px * 4.0)) * exp(-abs(q.x) * 2.0) * 0.5;
  float wide = exp(-sy * 22.0) * exp(-abs(q.x) * 1.4) * 0.12;
  light += (WARM * thin + AMBER * (soft + wide)) * uIntro * breathe * (1.0 - halves);

  // The halves themselves: near-black, with their inner edges catching the light.
  float edge = exp(-max(abs(q.y) - bh, 0.0) / (px * 2.5 + R * 0.012)) * halves;
  float rim = exp(-max(R - d, 0.0) / (px * 2.0 + R * 0.01)) * halves;
  vec3 discColor = INK * 1.25 + WARM * edge * 0.55 * uIntro + AMBER * rim * 0.18 * uIntro;

  vec3 lit3 = INK + (vec3(1.0) - INK) * (vec3(1.0) - exp(-light * 1.25));
  vec3 col = mix(lit3, discColor, halves);

  // Vignette and grain.
  vec2 uv = gl_FragCoord.xy / uRes;
  col *= mix(1.0, 0.72, smoothstep(0.35, 1.15, length((uv - vec2(0.5, 0.55)) * vec2(1.1, 1.0))));
  col += (hash(gl_FragCoord.xy + fract(t) * 91.0) - 0.5) * 0.012;
  outColor = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn(gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function HeroShader() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'low-power' });
    if (!gl) return;
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vs || !fs) return;
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, 'uRes');
    const uTime = gl.getUniformLocation(program, 'uTime');
    const uIntro = gl.getUniformLocation(program, 'uIntro');
    const uMouse = gl.getUniformLocation(program, 'uMouse');
    const uDisc = gl.getUniformLocation(program, 'uDisc');

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0, height = 0;
    // The disc fills the space between the header and the hero text, so the text never covers it.
    const disc = { y: 0.2, r: 0.12 };
    const hero = canvas.closest('.hero');
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      // Large screens render a little under device resolution: the image is soft light, not text.
      const scale = Math.min(window.devicePixelRatio || 1, rect.width > 1400 ? 1.25 : 1.5);
      width = Math.max(1, Math.round(rect.width * scale));
      height = Math.max(1, Math.round(rect.height * scale));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      gl.viewport(0, 0, width, height);
      const text = hero?.querySelector('.hero-content > :first-child')?.getBoundingClientRect();
      const top = 64 + 28;
      const bottom = text ? text.top - rect.top - 36 : rect.height * 0.45;
      const radius = Math.max(36, Math.min((bottom - top) / 2, rect.width * 0.28, 150));
      const center = Math.max(top + radius, (top + bottom) / 2);
      disc.y = 0.5 - center / rect.height;
      disc.r = radius / rect.height;
    };

    const target = { x: 0, y: 0 };
    const mouse = { x: 0, y: 0 };
    const onPointer = (event: PointerEvent) => {
      target.x = (event.clientX / window.innerWidth) * 2 - 1;
      target.y = (event.clientY / window.innerHeight) * 2 - 1;
    };

    const start = performance.now();
    let frame = 0;
    let visible = true;
    const draw = (now: number) => {
      const elapsed = reduced ? 30 : (now - start) / 1000;
      const introT = reduced ? 1 : Math.min(1, Math.max(0, (elapsed - 0.15) / 2.4));
      const intro = 1 - Math.pow(1 - introT, 3);
      mouse.x += (target.x - mouse.x) * 0.04;
      mouse.y += (target.y - mouse.y) * 0.04;
      gl.uniform2f(uRes, width, height);
      gl.uniform1f(uTime, elapsed + 4);
      gl.uniform1f(uIntro, intro);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.uniform3f(uDisc, 0, disc.y, disc.r);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const loop = (now: number) => {
      draw(now);
      if (visible && !reduced && !document.hidden) frame = requestAnimationFrame(loop);
    };
    const resume = () => {
      cancelAnimationFrame(frame);
      if (visible && !document.hidden) frame = requestAnimationFrame(loop);
    };

    resize();
    const resizeObserver = new ResizeObserver(() => { resize(); if (reduced) draw(performance.now()); });
    resizeObserver.observe(canvas);
    const content = hero?.querySelector('.hero-content');
    if (content) resizeObserver.observe(content);
    void document.fonts?.ready.then(() => { resize(); if (reduced) draw(performance.now()); });
    const intersection = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; if (!reduced) resume(); });
    intersection.observe(canvas);
    const onVisibility = () => { if (!reduced) resume(); };
    document.addEventListener('visibilitychange', onVisibility);
    if (!reduced) window.addEventListener('pointermove', onPointer, { passive: true });

    frame = requestAnimationFrame(loop);
    canvas.dataset.ready = 'true';

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointermove', onPointer);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, []);

  return <canvas ref={canvasRef} className="hero-canvas" aria-hidden="true" />;
}
