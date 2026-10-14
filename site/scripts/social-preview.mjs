// Render the social card at exactly 1280 × 640, using the site's own fonts and hero shader.
// Run from the repository root: node site/scripts/social-preview.mjs
import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('../', import.meta.url));
const width = 1280;
const height = 640;
const font = async (name) => (await readFile(path.join(site, `node_modules/@fontsource-variable/${name}/files/${name}-latin-wght-normal.woff2`))).toString('base64');
const [displayFont, textFont, shader] = await Promise.all([
  font('space-grotesk'),
  font('geist'),
  readFile(path.join(site, 'components/HeroShader.tsx'), 'utf8'),
]);
const source = (name) => {
  const match = shader.match(new RegExp(`const ${name} = \x60([\\s\\S]*?)\x60;`));
  if (!match) throw new Error(`Missing ${name} shader in HeroShader.tsx`);
  return match[1];
};

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Codiluce social preview</title>
  <style>
    @font-face { font-family: Display; src: url(data:font/woff2;base64,${displayFont}) format('woff2'); font-weight: 300 700; }
    @font-face { font-family: Text; src: url(data:font/woff2;base64,${textFont}) format('woff2'); font-weight: 100 900; }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
    body { background: #0a0a0b; color: #f5f5f3; font-family: Text, sans-serif; -webkit-font-smoothing: antialiased; }
    .card { position: relative; width: 100%; height: 100%; isolation: isolate; }
    canvas { position: absolute; inset: 0; z-index: -2; width: 100%; height: 100%; }
    .shade { position: absolute; inset: 0; z-index: -1; background: linear-gradient(180deg, transparent 45%, rgba(10,10,11,.64) 62%, rgba(10,10,11,.9) 100%); }
    .header { position: absolute; top: 44px; left: 56px; right: 56px; display: flex; justify-content: space-between; align-items: center; }
    .logo { display: flex; align-items: center; gap: 13px; }
    .logo svg { width: 34px; height: 34px; }
    .wordmark { font-family: Display, sans-serif; font-size: 34px; font-weight: 500; letter-spacing: -.03em; line-height: 1; }
    .status { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 400; letter-spacing: .12em; color: #a1a1a7; }
    .status::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #ffbf47; box-shadow: 0 0 12px #ffbf4740; }
    .message { position: absolute; top: 370px; left: 56px; right: 56px; text-align: center; }
    h1 { margin: 0; font-family: Display, sans-serif; font-weight: 500; font-size: 76px; line-height: 1.08; letter-spacing: -.045em; white-space: nowrap; }
    h1 span { color: #ffbf47; }
    .description { margin: 20px 0 0; color: #b4b4bb; font-size: 24px; line-height: 1.4; letter-spacing: -.015em; }
    .url { position: absolute; bottom: 46px; left: 0; right: 0; margin: 0; text-align: center; color: #a1a1a7; font-size: 17px; letter-spacing: .025em; }
  </style>
</head>
<body>
  <main class="card">
    <canvas width="${width}" height="${height}" aria-hidden="true"></canvas>
    <div class="shade"></div>
    <header class="header">
      <div class="logo">
        <svg viewBox="19 19 62 62" aria-hidden="true">
          <path d="M19.1455 47A31 31 0 0 1 80.8545 47Z" fill="currentColor" />
          <path d="M80.8545 53A31 31 0 0 1 19.1455 53Z" fill="currentColor" />
        </svg>
        <span class="wordmark">codiluce</span>
      </div>
      <div class="status">LOCAL · OPEN SOURCE</div>
    </header>
    <div class="message">
      <h1>Bring your code to <span>light</span></h1>
      <p class="description">See how your code fits together.</p>
    </div>
    <p class="url">codiluce.com</p>
  </main>
</body>
</html>`;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setContent(html);
  await page.evaluate(async ({ vertex, fragment, width, height }) => {
    await document.fonts.ready;
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is required to render the social card.');
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, width, height);
    gl.uniform2f(gl.getUniformLocation(program, 'uRes'), width, height);
    gl.uniform1f(gl.getUniformLocation(program, 'uTime'), 34);
    gl.uniform1f(gl.getUniformLocation(program, 'uIntro'), 1);
    gl.uniform2f(gl.getUniformLocation(program, 'uMouse'), 0, 0);
    gl.uniform3f(gl.getUniformLocation(program, 'uDisc'), 0, .125, .145);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.finish();
    if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL rendering failed.');
    if (document.documentElement.scrollWidth !== width || document.documentElement.scrollHeight !== height) throw new Error('Social card does not fit the target dimensions.');
    for (const selector of ['h1', '.description', '.header', '.url']) {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect();
      if (element.scrollWidth > element.clientWidth || rect.left < 0 || rect.right > width || rect.top < 0 || rect.bottom > height) throw new Error(`Social card text is clipped: ${selector}`);
    }
  }, { vertex: source('VERTEX'), fragment: source('FRAGMENT'), width, height });
  if (pageErrors.length) throw new Error(pageErrors.join('\n'));
  const output = path.join(site, 'public/social-preview.png');
  await mkdir(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, type: 'png', animations: 'disabled' });
  console.log(`Created ${output} (${width} × ${height}).`);
} finally {
  await browser.close();
}
