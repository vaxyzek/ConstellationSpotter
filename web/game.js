import { makeProjection, colorForCI, strokePath, vec, DEG } from './sky.js';

const $ = (s) => document.querySelector(s);

/**
 * Bortle classes, with the naked-eye limiting magnitude and sky glow each
 * implies. Class 1 is capped at 6.5 because that is where the catalogue stops --
 * a truly dark sky reaches ~7.5, but we have no stars to draw past 6.5.
 */
const BORTLE = [
  null,
  { nelm: 6.5, sky: '#04060c', label: 'excellent dark sky' },
  { nelm: 6.3, sky: '#060910', label: 'typical dark sky' },
  { nelm: 6.1, sky: '#090d17', label: 'rural sky' },
  { nelm: 5.7, sky: '#0e1421', label: 'rural / suburban' },
  { nelm: 5.3, sky: '#151b2c', label: 'suburban sky' },
  { nelm: 4.9, sky: '#1d2335', label: 'bright suburban' },
  { nelm: 4.5, sky: '#262b3d', label: 'suburban / urban' },
  { nelm: 4.1, sky: '#2f3344', label: 'city sky' },
  { nelm: 3.8, sky: '#393b4a', label: 'inner-city sky' },
];

const OPTS_KEY = 'game-opts';
const SCORE_KEY = 'game-score';

const state = {
  cons: [], pool: [], stars: [], byHip: new Map(),
  // `done` is the round state; `answered` is which choice was clicked, and is
  // null when the round was skipped rather than answered.
  target: null, choices: [], done: false, answered: null, roll: 0,
  score: { correct: 0, total: 0, streak: 0, best: 0 },
  opts: { rotate: false, lines: false, boundary: false,
          bortle: 3, fov: 2.4, colour: true },
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

  // Mensa and Microscopium have no figure to show, so they are neither a
  // question nor a plausible answer.
  state.pool = state.cons.filter((c) => c.playable);

  Object.assign(state.opts, JSON.parse(localStorage.getItem(OPTS_KEY) || '{}'));
  Object.assign(state.score, JSON.parse(localStorage.getItem(SCORE_KEY) || '{}'));

  // Difficulty can also come from the URL, so a particular challenge is
  // shareable: ?c=Ori&lines=1&rotate=1&bortle=6&fov=3.2
  const q = new URLSearchParams(location.search);
  for (const [key, parse] of Object.entries({
    rotate: (v) => v === '1' || v === 'true',
    lines: (v) => v === '1' || v === 'true',
    boundary: (v) => v === '1' || v === 'true',
    colour: (v) => v === '1' || v === 'true',
    bortle: (v) => Math.max(1, Math.min(9, Number(v))),
    fov: (v) => Math.max(1.4, Math.min(4, Number(v))),
  })) {
    if (q.has(key)) state.opts[key] = parse(q.get(key));
  }

  syncControls();
  nextRound();
}

// -------------------------------------------------------------------- round

function nextRound() {
  const pool = state.pool;
  // ?c=Ori pins the target, for practising one constellation (and for testing).
  const want = new URLSearchParams(location.search).get('c');
  const pinned = want && pool.find((c) => c.abbr.toLowerCase() === want.toLowerCase());
  state.target = pinned || pool[Math.floor(Math.random() * pool.length)];
  state.done = false;
  state.answered = null;
  state.roll = state.opts.rotate ? Math.random() * 360 : 0;

  const others = pool.filter((c) => c !== state.target);
  const picks = [];
  while (picks.length < 3 && others.length) {
    picks.push(others.splice(Math.floor(Math.random() * others.length), 1)[0]);
  }
  state.choices = shuffle([state.target, ...picks]);

  renderChoices();
  render();
  $('#verdict').textContent = '';
  $('#verdict').className = 'verdict';
  $('#next').hidden = true;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function answer(c, skipped = false) {
  if (state.done) return;
  state.done = true;
  state.answered = c;

  const right = c === state.target;
  state.score.total += 1;
  if (right) {
    state.score.correct += 1;
    state.score.streak += 1;
    state.score.best = Math.max(state.score.best, state.score.streak);
  } else {
    state.score.streak = 0;
  }
  localStorage.setItem(SCORE_KEY, JSON.stringify(state.score));

  const full = (x) => (x.name_ru ? `${x.name} (${x.name_ru})` : x.name);
  const v = $('#verdict');
  if (right) v.textContent = `Correct — ${full(state.target)}`;
  else if (skipped) v.textContent = `It was ${full(state.target)}`;
  else v.textContent = `It was ${full(state.target)}, not ${c.name}`;
  v.className = `verdict ${right ? 'right' : 'wrong'}`;

  renderChoices();
  renderScore();
  render();              // redraw with the figure revealed
  $('#next').hidden = false;
  $('#next').focus();
}

// ---------------------------------------------------------------- rendering

function frame(c, W, H) {
  const pts = [];
  for (const line of c.lines) {
    for (const hip of line) {
      const s = state.byHip.get(hip);
      if (s) pts.push([s.ra, s.dec]);
    }
  }

  let vx = 0, vy = 0, vz = 0;
  for (const [ra, dec] of pts) {
    const v = vec(ra, dec);
    vx += v[0]; vy += v[1]; vz += v[2];
  }
  const n = Math.hypot(vx, vy, vz) || 1;
  const dec0 = Math.asin(vz / n) / DEG;
  const ra0 = (Math.atan2(vy, vx) / DEG + 360) % 360;

  // Measure the figure's extent *after* rolling, so a rotated constellation
  // still fits the frame rather than spilling out of it.
  const unit = makeProjection({ ra0, dec0, roll: state.roll, scale: 1, cx: 0, cy: 0 });
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [ra, dec] of pts) {
    const p = unit(ra, dec);
    if (!p) continue;
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  const spanX = Math.max(maxX - minX, 0.02);
  const spanY = Math.max(maxY - minY, 0.02);

  // fov is how many figure-widths of sky to show: bigger = more surrounding
  // stars to get lost in = harder.
  const scale = Math.min(W / (spanX * state.opts.fov), H / (spanY * state.opts.fov));
  const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;

  return makeProjection({
    ra0, dec0, roll: state.roll, scale,
    cx: W / 2 - midX * scale, cy: H / 2 - midY * scale,
  });
}

function render() {
  const canvas = $('#sky');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const bortle = BORTLE[state.opts.bortle];
  ctx.fillStyle = bortle.sky;
  ctx.fillRect(0, 0, W, H);

  const c = state.target;
  if (!c) return;
  const project = frame(c, W, H);
  const limit = bortle.nelm;

  // Boundaries go down before the stars so the stars sit on top of them.
  if (state.opts.boundary) {
    ctx.save();
    ctx.strokeStyle = 'rgba(150,175,210,0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (const poly of c.boundary) strokePath(ctx, project, poly);
    ctx.restore();
  }

  for (const s of state.stars) {
    if (s.mag > limit) continue;
    const p = project(s.ra, s.dec);
    if (!p || p[2] < 0) continue;
    if (p[0] < -10 || p[0] > W + 10 || p[1] < -10 || p[1] > H + 10) continue;

    const above = limit - s.mag;
    const r = 0.6 + 0.72 * above;
    // Fade the last magnitude out instead of cutting it off, so raising the
    // light pollution dims stars away rather than popping them out of existence.
    const alpha = Math.max(0.12, Math.min(1, above / 1.2));
    const colour = state.opts.colour ? colorForCI(s.ci) : '#fff';

    if (s.mag < 2.6) {  // bright stars get a soft halo
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

  // The figure: shown up front on easy, otherwise only once answered.
  if (state.opts.lines || state.done) {
    ctx.save();
    ctx.strokeStyle = state.done ? 'rgba(126,214,255,0.85)' : 'rgba(126,214,255,0.45)';
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const line of c.lines) {
      strokePath(ctx, project, line
        .map((hip) => state.byHip.get(hip))
        .filter(Boolean)
        .map((s) => [s.ra, s.dec]));
    }
    ctx.restore();
  }
}

// ------------------------------------------------------------------ chrome

function renderChoices() {
  const box = $('#choices');
  box.innerHTML = '';
  state.choices.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'choice';
    b.innerHTML = `<kbd>${i + 1}</kbd> ${c.name}`
      + (c.name_ru ? ` <span class="ru">(${c.name_ru})</span>` : '');
    if (state.done) {
      b.disabled = true;
      if (c === state.target) b.classList.add('right');
      else if (c === state.answered) b.classList.add('wrong');
    }
    b.onclick = () => answer(c);
    box.appendChild(b);
  });
}

function renderScore() {
  const { correct, total, streak, best } = state.score;
  const pct = total ? Math.round((correct / total) * 100) : 0;
  $('#score').textContent = `${correct}/${total} (${pct}%) · streak ${streak} · best ${best}`;
}

function syncControls() {
  $('#rotate').checked = state.opts.rotate;
  $('#lines').checked = state.opts.lines;
  $('#boundary').checked = state.opts.boundary;
  $('#colour').checked = state.opts.colour;
  $('#bortle').value = state.opts.bortle;
  $('#fov').value = state.opts.fov;
  const b = BORTLE[state.opts.bortle];
  $('#bortleOut').textContent = `Bortle ${state.opts.bortle} — ${b.label} (mag ${b.nelm})`;
  $('#fovOut').textContent = `${state.opts.fov.toFixed(1)}×`;
  renderScore();
}

function saveOpts() {
  localStorage.setItem(OPTS_KEY, JSON.stringify(state.opts));
}

/** Single path for changing a setting, from a control, a preset or a key. */
function setOpt(key, value) {
  state.opts[key] = value;
  // Orientation has to be re-rolled here rather than at the start of the next
  // round, or toggling it appears to do nothing until the question changes.
  if (key === 'rotate') state.roll = value ? Math.random() * 360 : 0;
  saveOpts();
  syncControls();
  render();
}

function toggleOpt(key) {
  setOpt(key, !state.opts[key]);
}

function wire() {
  const bind = (id, key, get) => {
    $(id).addEventListener('input', (e) => setOpt(key, get(e.target)));
  };
  bind('#rotate', 'rotate', (el) => el.checked);
  bind('#lines', 'lines', (el) => el.checked);
  bind('#boundary', 'boundary', (el) => el.checked);
  bind('#colour', 'colour', (el) => el.checked);
  bind('#bortle', 'bortle', (el) => Number(el.value));
  bind('#fov', 'fov', (el) => Number(el.value));

  for (const btn of document.querySelectorAll('[data-preset]')) {
    btn.onclick = () => {
      const p = {
        easy:   { rotate: false, lines: true,  boundary: true,  bortle: 2, fov: 2.1 },
        normal: { rotate: false, lines: false, boundary: false, bortle: 4, fov: 2.6 },
        hard:   { rotate: true,  lines: false, boundary: false, bortle: 6, fov: 3.6 },
      }[btn.dataset.preset];
      for (const [k, v] of Object.entries(p)) setOpt(k, v);
    };
  }

  $('#next').onclick = nextRound;
  $('#skip').onclick = () => { if (!state.done) answer(null, true); };

  document.addEventListener('keydown', (e) => {
    // Only bail out of shortcuts for controls that consume typing. Checkboxes
    // and sliders keep focus after a click, and letters mean nothing to them,
    // so a shortcut should still work right after you tick a box.
    const el = e.target;
    if (el.tagName === 'SELECT'
        || (el.tagName === 'INPUT' && !['checkbox', 'range'].includes(el.type))) {
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const key = e.key.toLowerCase();
    if (e.key >= '1' && e.key <= '4') {
      const c = state.choices[Number(e.key) - 1];
      if (c) answer(c);
    } else if (key === 's') {
      if (!state.done) answer(null, true);
    } else if (key === 'l') {
      toggleOpt('lines');
    } else if (key === 'o') {
      toggleOpt('rotate');
    } else if (key === 'c') {
      toggleOpt('colour');
    } else if (key === 'b') {
      toggleOpt('boundary');
    } else if ((e.key === 'Enter' || e.key === ' ') && state.done) {
      // preventDefault matters: #next holds focus, so without it the key would
      // also activate the button natively and advance two rounds.
      e.preventDefault();
      nextRound();
    }
  });

  window.addEventListener('resize', render);
}

wire();
load();
