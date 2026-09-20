// Constellation regions: closed boundary rings and point-in-region lookup.
//
// data/constellations.json stores each boundary as a bag of unordered J2000
// polylines (the IAU edge records, subdivided and precessed). For hit-testing
// they have to be closed rings, so they are stitched end-to-end at load --
// ~5 300 vertices across all 89 entries, a few milliseconds, which is cheaper
// than carrying a second copy of the geometry in the data file.

import { vec, DEG } from './sky.js';

const QUANT = 1e4;  // endpoints are matched at 1e-4 deg, as the builder writes them

const key = (p) => `${Math.round(p[0] * QUANT)},${Math.round(p[1] * QUANT)}`;

/** Join a constellation's boundary polylines into closed rings. */
export function closeRings(polylines) {
  const segs = polylines.map((s) => s.slice());
  const ends = new Map();
  const add = (k, i) => {
    if (!ends.has(k)) ends.set(k, []);
    ends.get(k).push(i);
  };
  segs.forEach((s, i) => { add(key(s[0]), i); add(key(s[s.length - 1]), i); });

  const used = new Array(segs.length).fill(false);
  const rings = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const ring = segs[i].slice();
    for (;;) {
      const k = key(ring[ring.length - 1]);
      const next = (ends.get(k) || []).find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = true;
      const s = segs[next].slice();
      if (key(s[0]) !== k) s.reverse();
      ring.push(...s.slice(1));
      if (key(ring[ring.length - 1]) === key(ring[0])) break;
    }
    rings.push(ring);
  }
  return rings;
}

/**
 * Precompute a constellation's region: rings as unit vectors, plus the
 * bounding spherical cap.
 *
 * The cap is not only a speed filter. The winding test below is sign-blind on
 * a sphere -- a region and its antipode both wind -- so without it every
 * lookup also matches the constellation on the far side of the sky (Phoenix
 * would answer for Ursa Major). The cap rejects the antipode outright.
 */
export function buildRegion(con) {
  const rings = closeRings(con.boundary).map((r) => r.map(([ra, dec]) => vec(ra, dec)));

  let sx = 0, sy = 0, sz = 0;
  for (const r of rings) for (const v of r) { sx += v[0]; sy += v[1]; sz += v[2]; }
  const m = Math.hypot(sx, sy, sz) || 1;
  const centre = [sx / m, sy / m, sz / m];

  let radius = 0;
  for (const r of rings) {
    for (const v of r) {
      const d = Math.acos(Math.max(-1, Math.min(1, dot(v, centre))));
      if (d > radius) radius = d;
    }
  }
  return { abbr: con.abbr, rings, centre, radius: radius + 1e-9 };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Is the unit vector p inside this region? */
export function regionContains(region, p) {
  if (Math.acos(Math.max(-1, Math.min(1, dot(p, region.centre)))) > region.radius) {
    return false;
  }
  // Winding number about p: build a basis with p as the pole, walk each ring
  // and sum the change in longitude. Inside, the ring encircles p (±2π);
  // outside, the deltas cancel.
  const a = Math.abs(p[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let e = cross(a, p);
  const n = Math.hypot(e[0], e[1], e[2]);
  e = [e[0] / n, e[1] / n, e[2] / n];
  const f = cross(p, e);

  let total = 0;
  for (const ring of region.rings) {
    let prev = null;
    for (const v of ring) {
      const ang = Math.atan2(dot(v, f), dot(v, e));
      if (prev !== null) {
        let d = ang - prev;
        if (d > Math.PI) d -= 2 * Math.PI;
        else if (d < -Math.PI) d += 2 * Math.PI;
        total += d;
      }
      prev = ang;
    }
  }
  return Math.abs(total) > Math.PI;
}

/** The region containing p, or null. */
export function regionAt(regions, p) {
  for (const r of regions) if (regionContains(r, p)) return r;
  return null;
}

/** Ring vertices back as [ra, dec] degrees, for drawing. */
export function ringsAsRaDec(region) {
  return region.rings.map((ring) => ring.map((v) => {
    const dec = Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG;
    const ra = (Math.atan2(v[1], v[0]) / DEG + 360) % 360;
    return [ra, dec];
  }));
}
