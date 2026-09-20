// Explore mode: pan/zoom/rotate the whole celestial sphere, click a bounded
// region and name it from the list of constellations still unsolved. The game
// ends when all 89 regions are named; the score is how few wrong guesses it
// took.

import { makeProjection, makeUnprojection, colorForCI, strokePath, vec, DEG }
  from './sky.js';
import { buildRegion, regionContains, ringsAsRaDec } from './regions.js';

const $ = (s) => document.querySelector(s);

const SAVE_KEY = 'cs.explore.v1';
const OPTS_KEY = 'cs.explore.opts.v1';

// Field of view in degrees across the canvas' smaller dimension. The upper end
// shows a whole hemisphere; past that the stereographic projection stretches
// the far rim so much that regions are unclickable.
const FOV_MIN = 8;
const FOV_MAX = 140;

const state = {
  cons: [], stars: [], regions: [], byAbbr: new Map(),
  view: { ra0: 0, dec0: 0, roll: 0, fov: 60 },
  solved: new Map(),      // abbr -> { wrong }
  selected: null,         // region awaiting an answer
  hover: null,
  wrong: 0,
  flash: null,            // { abbr, right, until }
  opts: { colour: true, showLines: true, labels: true, maglimit: 5.6 },
};

// ------------------------------------------------------------------ loading

async function load() {
  const [cons, stars] = await Promise.all([
    fetch('../data/constellations.json').then((r) => r.json()),
    fetch('../data/stars.json').then((r) => r.json()),
  ]);
  state.cons = cons.constellations;
  state.stars = stars.stars;
  for (const c of state.cons) state.byAbbr.set(c.abbr, c);

  // Every region is playable here: unlike the quiz, naming a region needs no
  // figure, so Mensa and Microscopium are in.
  state.regions = state.cons.map(buildRegion);
  for (const r of state.regions) r.con = state.byAbbr.get(r.abbr);
  // Smallest first: a click inside a small region enclosed by the cap of a
  // large one should resolve to the small one, and first-match wins.
  state.regions.sort((a, b) => a.radius - b.radius);

  Object.assign(state.opts, JSON.parse(localStorage.getItem(OPTS_KEY) || '{}'));
  restore();
  syncControls();
  renderList();
  renderProgress();
  render();
}

function restore() {
  const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
  if (!saved) return;
  state.wrong = saved.wrong || 0;
  for (const [abbr, v] of saved.solved || []) {
    if (state.byAbbr.has(abbr)) state.solved.set(abbr, v);
  }
}

function save() {
  localStorage.setItem(SAVE_KEY, JSON.stringify({
    wrong: state.wrong, solved: [...state.solved],
  }));
}

function saveOpts() {
  localStorage.setItem(OPTS_KEY, JSON.stringify(state.opts));
}

// --------------------------------------------------------------- projection

function viewport() {
  const canvas = $('#sky');
  const W = canvas.clientWidth, H = canvas.clientHeight;
  // scale is px per unit of projected plane; at the centre the stereographic
  // plane unit maps to 2·tan(θ/2), so this makes `fov` span the short side.
  const scale = Math.min(W, H) / (4 * Math.tan((state.view.fov / 2) * DEG / 2));
  return {
    W, H,
    params: {
      ra0: state.view.ra0, dec0: state.view.dec0, roll: state.view.roll,
      scale, cx: W / 2, cy: H / 2,
    },
  };
}

/** Which region is under a canvas pixel, or null. */
function regionAtPixel(px, py) {
  const { params } = viewport();
  const unproject = makeUnprojection(params);
  const [ra, dec] = unproject(px, py);
  const p = vec(ra, dec);
  for (const r of state.regions) if (regionContains(r, p)) return r;
  return null;
}

// ------------------------------------------------------------------ playing

function pick(region) {
  if (!region || state.solved.has(region.abbr)) {
    state.selected = null;
  } else {
    state.selected = region;
    state.selected.tries = state.selected.tries || 0;
  }
  renderPrompt();
  renderList();
  render();
}

function guess(abbr) {
  const sel = state.selected;
  if (!sel || state.solved.has(abbr)) return;

  if (abbr === sel.abbr) {
    state.solved.set(sel.abbr, { wrong: sel.tries || 0 });
    state.flash = { abbr: sel.abbr, right: true, start: Date.now(), ms: 900 };
    const c = sel.con;
    verdict(`${full(c)} — correct`, 'right');
    state.selected = null;
  } else {
    // A wrong guess costs a point but leaves the region open, so it comes back
    // round later; the goal is to finish the sky with as few as possible.
    state.wrong += 1;
    sel.tries = (sel.tries || 0) + 1;
    state.flash = { abbr: sel.abbr, right: false, start: Date.now(), ms: 600 };
    verdict(`Not ${state.byAbbr.get(abbr).name} — try again`, 'wrong');
  }
  save();
  renderProgress();
  renderPrompt();
  renderList();
  render();
  animateFlash();
  if (state.solved.size === state.cons.length) finish();
}

function finish() {
  const total = state.cons.length;
  verdict(`Whole sky named — ${total} regions, ${state.wrong} wrong ` +
          `guess${state.wrong === 1 ? '' : 'es'}.`, 'right');
  $('#prompt').textContent = 'Sky complete';
}

function verdict(text, cls) {
  const v = $('#verdict');
  v.textContent = text;
  v.className = `verdict ${cls || ''}`;
}

/**
 * Keep redrawing while a flash is fading.
 *
 * Everything else here draws on demand, in response to an event. A fade has no
 * event to hang off, so without this the tint just sticks at full strength
 * until the next mouse move.
 */
function animateFlash() {
  if (!state.flash) return;
  requestAnimationFrame(() => {
    if (!state.flash) return;
    render();
    animateFlash();
  });
}

const full = (c) => (c.name_ru ? `${c.name} (${c.name_ru})` : c.name);

// ---------------------------------------------------------------- rendering

function renderProgress() {
  const done = state.solved.size, total = state.cons.length;
  $('#progress').innerHTML =
    `<span class="stat"><b>${done}</b>/${total} named · ` +
    `<b>${state.wrong}</b> wrong</span>`;
}

function renderPrompt() {
  const p = $('#prompt');
  if (state.solved.size === state.cons.length) { p.textContent = 'Sky complete'; return; }
  p.textContent = state.selected
    ? 'Which constellation is this?'
    : 'Click a region in the sky';
  $('#list').classList.toggle('disabled', !state.selected);
}

function renderList() {
  const term = $('#filter').value.trim().toLowerCase();
  const list = $('#list');
  list.innerHTML = '';
  const entries = [...state.cons].sort((a, b) => a.name.localeCompare(b.name));
  for (const c of entries) {
    const solved = state.solved.has(c.abbr);
    if (term && !(`${c.name} ${c.name_ru || ''} ${c.abbr}`.toLowerCase().includes(term))) {
      continue;
    }
    const b = document.createElement('button');
    b.className = solved ? 'solved' : '';
    b.disabled = solved;
    b.innerHTML = `${c.name}${c.name_ru ? ` <span class="ru">${c.name_ru}</span>` : ''}`;
    b.addEventListener('click', () => guess(c.abbr));
    list.appendChild(b);
  }
}

function syncControls() {
  $('#colour').checked = state.opts.colour;
  $('#showLines').checked = state.opts.showLines;
  $('#labels').checked = state.opts.labels;
  $('#maglimit').value = state.opts.maglimit;
  $('#magOut').textContent = `${Number(state.opts.maglimit).toFixed(1)} mag`;
}

function render() {
  const canvas = $('#sky');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const { W, H, params } = viewport();
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, W, H);

  const project = makeProjection(params);
  const limit = Number(state.opts.maglimit);
  const now = Date.now();
  if (state.flash && now - state.flash.start > state.flash.ms) state.flash = null;

  // Solved regions get a faint wash so the sky visibly fills in as you go.
  for (const r of state.regions) {
    if (!state.solved.has(r.abbr)) continue;
    fillRegion(ctx, project, r, 'rgba(90, 150, 120, 0.085)');
  }

  if (state.flash) {
    const r = state.regions.find((x) => x.abbr === state.flash.abbr);
    const fade = Math.max(0, 1 - (now - state.flash.start) / state.flash.ms);
    if (r) {
      fillRegion(ctx, project, r, state.flash.right
        ? `rgba(63,154,74,${0.35 * fade})`
        : `rgba(192,72,63,${0.35 * fade})`);
    }
  }

  // Hover and selection highlights.
  const hl = state.selected || state.hover;
  if (hl && !state.solved.has(hl.abbr)) {
    fillRegion(ctx, project, hl, state.selected
      ? 'rgba(126,214,255,0.14)' : 'rgba(126,214,255,0.07)');
  }

  // All boundaries, dim; the highlighted one brighter and solid.
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(120,145,185,0.32)';
  ctx.setLineDash([4, 4]);
  for (const c of state.cons) for (const poly of c.boundary) strokePath(ctx, project, poly);
  ctx.restore();

  if (hl) {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = state.selected ? '#7ed6ff' : 'rgba(126,214,255,0.75)';
    for (const ring of ringsAsRaDec(hl)) strokePath(ctx, project, ring);
    ctx.restore();
  }

  // Figure lines for regions already named.
  if (state.opts.showLines) {
    const byHip = hipIndex();
    ctx.save();
    ctx.strokeStyle = 'rgba(160,200,255,0.5)';
    ctx.lineWidth = 1.4;
    for (const abbr of state.solved.keys()) {
      const c = state.byAbbr.get(abbr);
      for (const line of c.lines) {
        const pts = line.map((h) => byHip.get(h)).filter(Boolean)
          .map((s) => [s.ra, s.dec]);
        if (pts.length > 1) strokePath(ctx, project, pts);
      }
    }
    ctx.restore();
  }

  drawStars(ctx, project, W, H, limit);

  if (state.opts.labels) drawLabels(ctx, project, W, H);
}

let _hipIndex = null;
function hipIndex() {
  if (!_hipIndex) {
    _hipIndex = new Map();
    for (const s of state.stars) if (s.hip != null) _hipIndex.set(s.hip, s);
  }
  return _hipIndex;
}

function fillRegion(ctx, project, region, style) {
  ctx.save();
  ctx.fillStyle = style;
  ctx.beginPath();
  for (const ring of ringsAsRaDec(region)) {
    let started = false;
    for (const [ra, dec] of ring) {
      const p = project(ra, dec);
      // A region straddling the far rim cannot be filled as one path; skip
      // rather than draw a wrong shape.
      if (!p || p[2] < -0.2) { started = false; continue; }
      if (started) ctx.lineTo(p[0], p[1]);
      else { ctx.moveTo(p[0], p[1]); started = true; }
    }
    ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
}

function drawStars(ctx, project, W, H, limit) {
  for (const s of state.stars) {
    if (s.mag > limit) continue;
    const p = project(s.ra, s.dec);
    if (!p || p[2] < 0) continue;
    if (p[0] < -10 || p[0] > W + 10 || p[1] < -10 || p[1] > H + 10) continue;

    const above = limit - s.mag;
    const r = 0.6 + 0.7 * above;
    const alpha = Math.max(0.12, Math.min(1, above / 1.2));
    const colour = state.opts.colour ? colorForCI(s.ci) : '#fff';

    if (s.mag < 2.6) {
      const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r * 4);
      g.addColorStop(0, colour);
      g.addColorStop(0.25, `rgba(255,255,255,${0.28 * alpha})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p[0], p[1], r * 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawLabels(ctx, project, W, H) {
  ctx.save();
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(200,220,255,0.65)';
  for (const abbr of state.solved.keys()) {
    const c = state.byAbbr.get(abbr);
    const p = project(c.center[0], c.center[1]);
    if (!p || p[2] < 0.1) continue;
    if (p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H) continue;
    ctx.fillText(c.name, p[0], p[1]);
  }
  ctx.restore();
}

// ----------------------------------------------------------------- controls

function clampView() {
  const v = state.view;
  v.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, v.fov));
  // Let the pole be crossed, but not flipped past: beyond ±90° the projection
  // mirrors and dragging reverses, which feels broken.
  v.dec0 = Math.max(-89.9, Math.min(89.9, v.dec0));
  v.ra0 = ((v.ra0 % 360) + 360) % 360;
}

function bindCanvas() {
  const canvas = $('#sky');
  const stage = $('#stage');
  let drag = null;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.offsetX, y: e.offsetY, moved: 0, roll: e.shiftKey };
    stage.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.roll) {
        state.view.roll += dx * 0.4;
      } else {
        // Pan in degrees of sky per pixel, so drag speed matches zoom level.
        const perPx = state.view.fov / Math.min(canvas.clientWidth, canvas.clientHeight);
        const rr = state.view.roll * DEG;
        const mx = dx * Math.cos(rr) + dy * Math.sin(rr);
        const my = -dx * Math.sin(rr) + dy * Math.cos(rr);
        // RA compresses towards the poles; without the sec(dec) term panning
        // near Polaris crawls.
        const sec = 1 / Math.max(0.12, Math.cos(state.view.dec0 * DEG));
        state.view.ra0 += mx * perPx * sec;
        state.view.dec0 += my * perPx;
      }
      drag.x = e.offsetX; drag.y = e.offsetY;
      clampView();
      render();
      return;
    }
    const r = regionAtPixel(e.offsetX, e.offsetY);
    const changed = (r && r.abbr) !== (state.hover && state.hover.abbr);
    state.hover = r;
    stage.classList.toggle('pickable', !!r && !state.solved.has(r.abbr));
    showTip(e, r);
    if (changed) render();
  });

  const endDrag = (e) => {
    if (!drag) return;
    const wasClick = drag.moved < 4 && !drag.roll;
    drag = null;
    stage.classList.remove('dragging');
    if (wasClick) pick(regionAtPixel(e.offsetX, e.offsetY));
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => { drag = null; stage.classList.remove('dragging'); });

  canvas.addEventListener('pointerleave', () => {
    state.hover = null;
    $('#tip').hidden = true;
    render();
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // Zoom about the cursor: keep the sky position under the pointer fixed.
    const before = makeUnprojection(viewport().params)(e.offsetX, e.offsetY);
    state.view.fov *= Math.exp(e.deltaY * 0.0014);
    clampView();
    const after = makeUnprojection(viewport().params)(e.offsetX, e.offsetY);
    // Shift the centre by the drift at the cursor. RA differences wrap, so
    // normalise to (-180, 180] before applying.
    let dra = before[0] - after[0];
    if (dra > 180) dra -= 360;
    else if (dra < -180) dra += 360;
    state.view.ra0 += dra;
    state.view.dec0 += before[1] - after[1];
    clampView();
    render();
  }, { passive: false });
}

function showTip(e, region) {
  const tip = $('#tip');
  if (!region) { tip.hidden = true; return; }
  const c = region.con;
  const solved = state.solved.has(region.abbr);
  tip.innerHTML = solved
    ? `${c.name}${c.name_ru ? ` <span class="ru">${c.name_ru}</span>` : ''}`
    : '<span class="ru">unnamed region</span>';
  tip.style.left = `${e.offsetX}px`;
  tip.style.top = `${e.offsetY}px`;
  tip.hidden = false;
}

function bindControls() {
  for (const [id, key] of [['colour', 'colour'], ['showLines', 'showLines'],
                           ['labels', 'labels']]) {
    $(`#${id}`).addEventListener('change', (e) => {
      state.opts[key] = e.target.checked;
      saveOpts();
      render();
    });
  }
  $('#maglimit').addEventListener('input', (e) => {
    state.opts.maglimit = Number(e.target.value);
    $('#magOut').textContent = `${state.opts.maglimit.toFixed(1)} mag`;
    saveOpts();
    render();
  });
  $('#filter').addEventListener('input', renderList);

  $('#reset').addEventListener('click', () => {
    if (!confirm('Clear all progress and start over?')) return;
    state.solved.clear();
    state.wrong = 0;
    state.selected = null;
    save();
    verdict('', '');
    renderProgress();
    renderPrompt();
    renderList();
    render();
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'Escape') { state.selected = null; renderPrompt(); renderList(); render(); }
    else if (e.key === '[') { state.view.roll -= 5; render(); }
    else if (e.key === ']') { state.view.roll += 5; render(); }
    else if (e.key === '0') {
      state.view = { ra0: 0, dec0: 0, roll: 0, fov: 60 };
      render();
    } else return;
    e.preventDefault();
  });

  window.addEventListener('resize', render);
}

bindCanvas();
bindControls();
load();

// Exposed for debugging and for driving the view from the console/tests.
window.explore = { state, render, regionAtPixel };
