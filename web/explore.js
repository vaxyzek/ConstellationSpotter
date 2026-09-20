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
  solved: new Map(),      // abbr -> { wrong, hinted }
  selected: null,         // region awaiting an answer
  hover: null,
  wrong: 0,
  hints: 0,               // hints taken, across the whole game
  hinted: new Set(),      // abbrs whose figure has been revealed as a hint
  flash: null,            // { abbr, right, start, ms }
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
  state.hints = saved.hints || 0;
  for (const abbr of saved.hinted || []) {
    if (state.byAbbr.has(abbr)) state.hinted.add(abbr);
  }
  for (const [abbr, v] of saved.solved || []) {
    if (state.byAbbr.has(abbr)) state.solved.set(abbr, v);
  }
}

function save() {
  localStorage.setItem(SAVE_KEY, JSON.stringify({
    wrong: state.wrong, hints: state.hints,
    hinted: [...state.hinted], solved: [...state.solved],
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

/**
 * Reveal the selected region's figure lines.
 *
 * Counted once per constellation, not per press: taking the same hint twice
 * (or after a reload, since it persists) is the same piece of help, and
 * charging for it again would only punish re-reading.
 */
function takeHint() {
  const sel = state.selected;
  if (!sel || state.solved.has(sel.abbr)) return;

  // Mensa and Microscopium genuinely have no figure -- the S&T source has no
  // records and the IAU charts show an empty region -- so there is nothing to
  // draw and nothing to charge for.
  if (!sel.con.lines.length) {
    verdict(`${sel.con.name} has no figure to show`, '');
    return;
  }

  if (!state.hinted.has(sel.abbr)) {
    state.hinted.add(sel.abbr);
    state.hints += 1;
    save();
    renderProgress();
  }
  renderHintButton();
  render();
}

function renderHintButton() {
  const b = $('#hint');
  const sel = state.selected;
  b.disabled = !sel;
  if (!sel) { b.textContent = 'hint'; return; }
  if (!sel.con.lines.length) b.textContent = 'no figure';
  else if (state.hinted.has(sel.abbr)) b.textContent = 'hint shown';
  else b.textContent = 'hint';
}

function guess(abbr) {
  const sel = state.selected;
  if (!sel || state.solved.has(abbr)) return;

  if (abbr === sel.abbr) {
    state.solved.set(sel.abbr, {
      wrong: sel.tries || 0,
      hinted: state.hinted.has(sel.abbr),
    });
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
          `guess${state.wrong === 1 ? '' : 'es'}, ${state.hints} hint` +
          `${state.hints === 1 ? '' : 's'}.`, 'right');
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
    `<b>${state.wrong}</b> wrong · <b>${state.hints}</b> hint` +
    `${state.hints === 1 ? '' : 's'}</span>`;
}

function renderPrompt() {
  const p = $('#prompt');
  renderHintButton();
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

  // Figure lines: solved regions (if that option is on), plus any region
  // whose hint has been taken -- a hint ignores the option, since asking for
  // it is an explicit request to see the figure.
  {
    const byHip = hipIndex();
    const drawFigure = (abbr) => {
      const c = state.byAbbr.get(abbr);
      for (const line of c.lines) {
        const pts = line.map((h) => byHip.get(h)).filter(Boolean)
          .map((s) => [s.ra, s.dec]);
        if (pts.length > 1) strokePath(ctx, project, pts);
      }
    };

    if (state.opts.showLines) {
      ctx.save();
      ctx.strokeStyle = 'rgba(160,200,255,0.5)';
      ctx.lineWidth = 1.4;
      for (const abbr of state.solved.keys()) {
        if (state.hinted.has(abbr)) continue;   // drawn below, in hint colour
        drawFigure(abbr);
      }
      ctx.restore();
    }

    // Hinted figures stand out: brighter, warmer, and drawn whether or not
    // the region is solved yet, so the help you asked for is unmistakable.
    ctx.save();
    ctx.strokeStyle = 'rgba(255,214,140,0.85)';
    ctx.lineWidth = 1.8;
    for (const abbr of state.hinted) {
      if (state.solved.has(abbr) && !state.opts.showLines) continue;
      drawFigure(abbr);
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

  // Live pointers by id, so one finger pans and two pinch/rotate. A single
  // `drag` variable cannot express that, and on a touchscreen the second
  // finger would otherwise be read as a jump of the first.
  const pointers = new Map();
  let gesture = null;   // two-finger: { dist, angle }
  let pan = null;       // one-finger/mouse: { x, y, moved, roll }

  const pos = (e) => ({ x: e.offsetX, y: e.offsetY });

  /** Centroid, spread and twist of the two live pointers. */
  function twoFinger() {
    const [a, b] = [...pointers.values()];
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x) / DEG,
    };
  }

  /** Move the sky so the position under (px, py) before the change is under it again. */
  function keepAnchored(before, px, py) {
    const after = makeUnprojection(viewport().params)(px, py);
    let dra = before[0] - after[0];
    if (dra > 180) dra -= 360;
    else if (dra < -180) dra += 360;
    state.view.ra0 += dra;
    state.view.dec0 += before[1] - after[1];
    clampView();
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, pos(e));

    if (pointers.size === 2) {
      pan = null;              // a pinch is starting; abandon the pan
      gesture = twoFinger();
    } else if (pointers.size === 1) {
      pan = { ...pos(e), moved: 0, roll: e.shiftKey };
      stage.classList.add('dragging');
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, pos(e));

    // --- two fingers: pinch to zoom, twist to rotate, anchored at the midpoint
    if (pointers.size === 2 && gesture) {
      const now = twoFinger();
      const before = makeUnprojection(viewport().params)(now.cx, now.cy);

      if (gesture.dist > 8 && now.dist > 8) {
        state.view.fov *= gesture.dist / now.dist;
      }
      let dAng = now.angle - gesture.angle;
      if (dAng > 180) dAng -= 360;
      else if (dAng < -180) dAng += 360;
      state.view.roll += dAng;

      clampView();
      keepAnchored(before, now.cx, now.cy);
      gesture = now;
      render();
      return;
    }

    // --- one finger / mouse: pan (or roll with shift held)
    if (pan) {
      const p = pos(e);
      const dx = p.x - pan.x, dy = p.y - pan.y;
      pan.moved += Math.abs(dx) + Math.abs(dy);
      if (pan.roll) {
        state.view.roll += dx * 0.4;
      } else {
        // Drag the sky with the finger: the point grabbed stays under it,
        // at any zoom, anywhere on the canvas -- which plain degrees-per-pixel
        // does not manage near the poles or the rim.
        const before = makeUnprojection(viewport().params)(pan.x, pan.y);
        keepAnchored(before, p.x, p.y);
      }
      pan.x = p.x; pan.y = p.y;
      clampView();
      render();
      return;
    }

    // --- no buttons down: hover readout (mouse only; a finger has no hover)
    if (e.pointerType === 'touch') return;
    const r = regionAtPixel(e.offsetX, e.offsetY);
    const changed = (r && r.abbr) !== (state.hover && state.hover.abbr);
    state.hover = r;
    stage.classList.toggle('pickable', !!r && !state.solved.has(r.abbr));
    showTip(e, r);
    if (changed) render();
  });

  function release(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) gesture = null;
    if (pointers.size === 0) stage.classList.remove('dragging');
  }

  canvas.addEventListener('pointerup', (e) => {
    // A tap is a click: short, still, and not the tail of a pinch.
    const tap = pan && pan.moved < 8 && !pan.roll && !gesture && pointers.size === 1;
    const p = pos(e);
    release(e);
    if (pointers.size === 0) pan = null;
    if (tap) {
      pick(regionAtPixel(p.x, p.y));
    }
  });

  canvas.addEventListener('pointercancel', (e) => {
    release(e);
    if (pointers.size === 0) pan = null;
  });

  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch') return;
    state.hover = null;
    $('#tip').hidden = true;
    render();
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const before = makeUnprojection(viewport().params)(e.offsetX, e.offsetY);
    state.view.fov *= Math.exp(e.deltaY * 0.0014);
    clampView();
    keepAnchored(before, e.offsetX, e.offsetY);
    render();
  }, { passive: false });

  // Zoom buttons, for touch users who would rather not pinch.
  $('#zoomIn').addEventListener('click', () => { zoomBy(1 / 1.4); });
  $('#zoomOut').addEventListener('click', () => { zoomBy(1.4); });
}

function zoomBy(factor) {
  state.view.fov *= factor;
  clampView();
  render();
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

  $('#hint').addEventListener('click', takeHint);

  $('#reset').addEventListener('click', () => {
    if (!confirm('Clear all progress and start over?')) return;
    state.solved.clear();
    state.hinted.clear();
    state.wrong = 0;
    state.hints = 0;
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
    else if (e.key === 'h' || e.key === 'H') { takeHint(); }
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
