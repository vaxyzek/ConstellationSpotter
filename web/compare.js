import {
  makeProjection, starRadius, colorForCI, strokePath, drawGrid, sep, vec, DEG,
} from './sky.js';

const $ = (s) => document.querySelector(s);
const VERDICTS = 'constellation-verdicts';

const state = {
  cons: [], stars: [], byHip: new Map(),
  index: 0,
  verdicts: JSON.parse(localStorage.getItem(VERDICTS) || '{}'),
  opts: {
    labels: true, boundaries: true, neighbours: true, grid: true,
    magLimit: 6.5, zoom: 1.0,
  },
};

// ------------------------------------------------------------------ loading

async function load() {
  const [cons, stars] = await Promise.all([
    fetch('../data/constellations.json').then((r) => r.json()),
    fetch('../data/stars.json').then((r) => r.json()),
  ]);
  state.cons = cons.constellations;
  state.stars = stars.stars;
  for (const s of state.stars) if (s.hip != null) state.byHip.set(s.hip, s);

  // Which stars belong to which constellation figure, for highlighting.
  state.figureHips = new Map();
  for (const c of state.cons) {
    const set = new Set();
    for (const line of c.lines) for (const hip of line) set.add(hip);
    state.figureHips.set(c.abbr, set);
  }

  buildPicker();

  // ?c=Ori deep-links a constellation; otherwise resume where we left off.
  const want = new URLSearchParams(location.search).get('c');
  const fromUrl = want
    ? state.cons.findIndex((c) => c.abbr.toLowerCase() === want.toLowerCase())
    : -1;
  const saved = Number(localStorage.getItem('constellation-index') || 0);
  show(fromUrl >= 0 ? fromUrl : (Number.isFinite(saved) ? saved : 0));
}

// ---------------------------------------------------------------- rendering

function render() {
  const c = state.cons[state.index];
  const canvas = $('#render');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;

  // Match the reference sheet's aspect ratio so the two panels line up.
  const img = $('#iau');
  const aspect = img.naturalHeight && img.naturalWidth
    ? img.naturalHeight / img.naturalWidth : 1.15;

  canvas.width = size * dpr;
  canvas.height = Math.round(size * aspect) * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = size, H = Math.round(size * aspect);
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, 0, W, H);

  const project = frameFigure(c, W, H);

  if (state.opts.grid) drawGrid(ctx, project, { color: '#c8c8c8' });

  if (state.opts.boundaries) {
    ctx.save();
    ctx.strokeStyle = '#8a8a8a';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    for (const poly of c.boundary) strokePath(ctx, project, poly);
    ctx.restore();
  }

  // Neighbouring figures first, so the target draws on top.
  if (state.opts.neighbours) {
    ctx.save();
    ctx.strokeStyle = 'rgba(120,170,120,0.75)';
    ctx.lineWidth = 1.6;
    for (const other of state.cons) {
      if (other.abbr === c.abbr) continue;
      if (sep(other.center, c.center) > c.radius + other.radius + 12) continue;
      for (const line of other.lines) drawFigureLine(ctx, project, line);
    }
    ctx.restore();
  }

  // Stars.
  const limit = state.opts.magLimit;
  const figure = state.figureHips.get(c.abbr);
  for (const s of state.stars) {
    if (s.mag > limit) continue;
    const p = project(s.ra, s.dec);
    if (!p || p[2] < 0) continue;
    if (p[0] < -20 || p[0] > W + 20 || p[1] < -20 || p[1] > H + 20) continue;
    const r = starRadius(s.mag, limit, state.opts.zoom > 1 ? 1.1 : 1);
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fillStyle = $('#trueColor').checked ? colorForCI(s.ci) : '#111';
    ctx.fill();
    if (figure.has(s.hip)) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], r + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#d2443c';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  // Target figure on top.
  ctx.save();
  ctx.strokeStyle = '#2f7d32';
  ctx.lineWidth = 2.6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const line of c.lines) drawFigureLine(ctx, project, line);
  ctx.restore();

  if (state.opts.labels) drawLabels(ctx, project, c, W, H);
  drawLegend(ctx, W, H, limit);
}

/**
 * Build a projection that fits the figure to the canvas.
 *
 * Fitting the figure's real projected bounding box beats any field-of-view
 * heuristic: it copes with wide sheets (Hydra) and tall ones (Eridanus) alike,
 * and follows whichever half of a split constellation is on screen.
 */
function frameFigure(c, W, H) {
  const pts = [];
  for (const line of c.lines) {
    for (const hip of line) {
      const s = state.byHip.get(hip);
      if (s) pts.push([s.ra, s.dec]);
    }
  }
  // Mensa and Microscopium have no figure at all (the IAU charts show none),
  // so there is nothing to fit -- frame their boundary instead.
  if (pts.length < 2) {
    for (const poly of c.boundary) for (const p of poly) pts.push(p);
  }
  if (!pts.length) pts.push(c.center);

  // Mean direction of the visible stars, as the projection's tangent point.
  let vx = 0, vy = 0, vz = 0;
  for (const [ra, dec] of pts) {
    const v = vec(ra, dec);
    vx += v[0]; vy += v[1]; vz += v[2];
  }
  const n = Math.hypot(vx, vy, vz) || 1;
  const dec0 = Math.asin(vz / n) / DEG;
  const ra0 = (Math.atan2(vy, vx) / DEG + 360) % 360;

  // Unit-scale pass to measure the figure's extent in the projection plane.
  const unit = makeProjection({ ra0, dec0, scale: 1, cx: 0, cy: 0 });
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [ra, dec] of pts) {
    const p = unit(ra, dec);
    if (!p) continue;
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  // 0.02 floor ~= a 1-degree field, so a degenerate extent cannot zoom to infinity.
  const spanX = Math.max(maxX - minX, 0.02);
  const spanY = Math.max(maxY - minY, 0.02);

  // 0.68 leaves the same sort of margin the IAU sheets keep around a figure.
  const scale = Math.min(W * 0.68 / spanX, H * 0.68 / spanY) * state.opts.zoom;
  const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;

  return makeProjection({
    ra0, dec0, scale,
    cx: W / 2 - midX * scale, cy: H / 2 - midY * scale,
  });
}

function drawFigureLine(ctx, project, hips) {
  const pts = [];
  for (const hip of hips) {
    const s = state.byHip.get(hip);
    if (s) pts.push([s.ra, s.dec]);
  }
  strokePath(ctx, project, pts);
}

function drawLabels(ctx, project, c, W, H) {
  ctx.save();
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#111';
  ctx.textAlign = 'left';
  // Brightest first, so when labels collide the notable star keeps its name.
  const stars = [...state.figureHips.get(c.abbr)]
    .map((hip) => state.byHip.get(hip))
    .filter(Boolean)
    .sort((a, b) => a.mag - b.mag);

  const boxes = [];
  const hits = (b) => boxes.some((o) =>
    b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);

  for (const s of stars) {
    const p = project(s.ra, s.dec);
    if (!p || p[2] < 0) continue;
    // Label with the star's OWN constellation: figures borrow stars from
    // neighbours (Serpens uses nu/eta Oph, Pegasus uses alpha And), and
    // labelling those with the displayed abbreviation invents a wrong name.
    const text = s.name || (s.bayer ? `${s.bayer} ${s.con || c.abbr}` : `HIP ${s.hip}`);
    const w = ctx.measureText(text).width;
    // Try each side of the star before giving up on the label.
    const spots = [[7, -6], [-w - 7, -6], [7, 14], [-w - 7, 14]];
    for (const [dx, dy] of spots) {
      const box = { x: p[0] + dx, y: p[1] + dy - 10, w, h: 13 };
      if (hits(box)) continue;
      boxes.push(box);
      ctx.fillText(text, box.x, p[1] + dy);
      break;
    }
  }
  ctx.font = 'italic 17px ui-serif, Georgia, serif';
  ctx.fillStyle = '#333';
  ctx.textAlign = 'center';
  ctx.fillText(c.name.toUpperCase(), W / 2, 26);
  ctx.restore();
}

function drawLegend(ctx, W, H, limit) {
  ctx.save();
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#333';
  ctx.textAlign = 'center';
  let x = 24;
  for (let m = -1; m <= 6; m++) {
    const r = starRadius(m, limit, 1);
    ctx.beginPath();
    ctx.arc(x, H - 22, r, 0, Math.PI * 2);
    ctx.fillStyle = '#111';
    ctx.fill();
    ctx.fillStyle = '#333';
    ctx.fillText(String(m), x, H - 8);
    x += Math.max(18, r * 2 + 12);
  }
  ctx.restore();
}

// ------------------------------------------------------------------ chrome

function buildPicker() {
  const sel = $('#picker');
  sel.innerHTML = '';
  state.cons.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${c.abbr} — ${c.name}`;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => show(Number(sel.value)));
}

function show(i) {
  state.index = ((i % state.cons.length) + state.cons.length) % state.cons.length;
  localStorage.setItem('constellation-index', String(state.index));
  const c = state.cons[state.index];

  $('#picker').value = String(state.index);
  $('#counter').textContent = `${state.index + 1} / ${state.cons.length}`;
  $('#meta').textContent =
    `${c.lines.length} polylines · ${c.lines.reduce((n, l) => n + l.length - 1, 0)} segments · `
    + `${state.figureHips.get(c.abbr).size} stars · radius ${c.radius.toFixed(1)}°`;

  showChart();
  renderVerdict();
  render();
}

function showChart() {
  const img = $('#iau');
  img.onload = render;  // canvas aspect follows the sheet, known only once loaded
  img.src = `iau/${state.cons[state.index].iau}.gif`;
}

function setVerdict(v) {
  const c = state.cons[state.index];
  if (v === null) delete state.verdicts[c.abbr];
  else state.verdicts[c.abbr] = v;
  localStorage.setItem(VERDICTS, JSON.stringify(state.verdicts));
  renderVerdict();
}

function renderVerdict() {
  const c = state.cons[state.index];
  const v = state.verdicts[c.abbr] || null;
  for (const btn of document.querySelectorAll('[data-verdict]')) {
    btn.classList.toggle('active', btn.dataset.verdict === v);
  }
  const ok = Object.values(state.verdicts).filter((x) => x === 'ok').length;
  const bad = Object.values(state.verdicts).filter((x) => x === 'bad').length;
  $('#progress').textContent =
    `${ok} matched · ${bad} flagged · ${state.cons.length - ok - bad} unchecked`;
}

function exportReport() {
  const rows = state.cons.map((c) => ({
    abbr: c.abbr, name: c.name,
    verdict: state.verdicts[c.abbr] || 'unchecked',
    polylines: c.lines.length,
    segments: c.lines.reduce((n, l) => n + l.length - 1, 0),
  }));
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'line-verification.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function wire() {
  $('#prev').onclick = () => show(state.index - 1);
  $('#next').onclick = () => show(state.index + 1);
  $('#export').onclick = exportReport;

  for (const btn of document.querySelectorAll('[data-verdict]')) {
    btn.onclick = () => setVerdict(
      state.verdicts[state.cons[state.index].abbr] === btn.dataset.verdict
        ? null : btn.dataset.verdict,
    );
  }

  const bind = (id, key, transform = (el) => el.checked) => {
    const el = $(id);
    el.addEventListener('input', () => {
      state.opts[key] = transform(el);
      if (key === 'magLimit') $('#magOut').textContent = state.opts.magLimit.toFixed(1);
      if (key === 'zoom') $('#zoomOut').textContent = `${state.opts.zoom.toFixed(2)}×`;
      render();
    });
  };
  bind('#labels', 'labels');
  bind('#boundaries', 'boundaries');
  bind('#neighbours', 'neighbours');
  bind('#grid', 'grid');
  bind('#trueColor', 'trueColor');
  bind('#mag', 'magLimit', (el) => Number(el.value));
  bind('#zoom', 'zoom', (el) => Number(el.value));

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') show(state.index - 1);
    else if (e.key === 'ArrowRight') show(state.index + 1);
    else if (e.key === 'y') setVerdict('ok');
    else if (e.key === 'n') setVerdict('bad');
  });

  window.addEventListener('resize', render);
}

wire();
load();
