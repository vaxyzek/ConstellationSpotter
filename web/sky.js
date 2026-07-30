// Sky rendering: projection + drawing primitives shared by the compare tool
// and (later) the game itself.

export const DEG = Math.PI / 180;

/** Unit vector for an equatorial position. */
export function vec(raDeg, decDeg) {
  const ra = raDeg * DEG, dec = decDeg * DEG, c = Math.cos(dec);
  return [c * Math.cos(ra), c * Math.sin(ra), Math.sin(dec)];
}

/** Angular separation in degrees. */
export function sep(a, b) {
  const va = vec(a[0], a[1]), vb = vec(b[0], b[1]);
  const d = va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2];
  return Math.acos(Math.max(-1, Math.min(1, d))) / DEG;
}

/**
 * Stereographic projection about (ra0, dec0), optionally rotated.
 *
 * Returns canvas coordinates with north up and RA increasing to the LEFT,
 * matching how the sky actually looks and how the IAU charts are drawn.
 * `scale` is pixels per unit of projected plane at the centre.
 */
export function makeProjection({ ra0, dec0, roll = 0, scale, cx, cy }) {
  const sd0 = Math.sin(dec0 * DEG), cd0 = Math.cos(dec0 * DEG);
  const cr = Math.cos(roll * DEG), sr = Math.sin(roll * DEG);

  return function project(raDeg, decDeg) {
    const dra = (raDeg - ra0) * DEG;
    const dec = decDeg * DEG;
    const sd = Math.sin(dec), cd = Math.cos(dec);
    const cosc = sd0 * sd + cd0 * cd * Math.cos(dra);
    const k = 2 / (1 + cosc);
    if (!isFinite(k) || 1 + cosc < 1e-9) return null; // antipode
    let x = k * cd * Math.sin(dra);
    let y = k * (cd0 * sd - sd0 * cd * Math.cos(dra));
    if (roll) {
      const rx = x * cr - y * sr;
      y = x * sr + y * cr;
      x = rx;
    }
    // Negate x so RA increases leftwards; negate y so north is up.
    return [cx - x * scale, cy - y * scale, cosc];
  };
}

/**
 * Apparent radius in px for a star of the given magnitude.
 *
 * The floor matters: without it everything past mag ~5.8 lands below one pixel
 * and the sky looks far emptier than the IAU sheets, which still print those
 * stars as visible dots.
 */
export function starRadius(mag, limit, zoom = 1) {
  const r = 0.9 + 0.55 * Math.max(0, limit - mag);
  return Math.max(0.9, r * zoom);
}

/** Approximate RGB for a B-V colour index. */
export function colorForCI(ci) {
  if (ci == null) return '#fff';
  // Piecewise fit through the usual O..M sequence.
  const stops = [
    [-0.35, 155, 176, 255], [-0.15, 190, 205, 255], [0.0, 220, 228, 255],
    [0.15, 245, 245, 255], [0.35, 255, 246, 230], [0.6, 255, 238, 200],
    [0.9, 255, 220, 168], [1.3, 255, 196, 140], [1.8, 255, 168, 120],
  ];
  const c = Math.max(stops[0][0], Math.min(stops[stops.length - 1][0], ci));
  for (let i = 1; i < stops.length; i++) {
    if (c <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const t = (c - a[0]) / (b[0] - a[0]);
      const m = (j) => Math.round(a[j] + (b[j] - a[j]) * t);
      return `rgb(${m(1)},${m(2)},${m(3)})`;
    }
  }
  return '#fff';
}

/** Draw a polyline given as [ra, dec] pairs, splitting where it leaves the sky. */
export function strokePath(ctx, project, points) {
  let started = false;
  ctx.beginPath();
  for (const [ra, dec] of points) {
    const p = project(ra, dec);
    if (!p || p[2] < -0.2) { started = false; continue; }
    if (started) ctx.lineTo(p[0], p[1]);
    else { ctx.moveTo(p[0], p[1]); started = true; }
  }
  ctx.stroke();
}

/** RA/Dec graticule for the visible area. */
export function drawGrid(ctx, project, { raStep = 15, decStep = 10, color }) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let ra = 0; ra < 360; ra += raStep) {
    const pts = [];
    for (let d = -89; d <= 89; d += 1) pts.push([ra, d]);
    strokePath(ctx, project, pts);
  }
  for (let dec = -80; dec <= 80; dec += decStep) {
    const pts = [];
    for (let r = 0; r <= 360; r += 2) pts.push([r, dec]);
    strokePath(ctx, project, pts);
  }
  ctx.restore();
}
