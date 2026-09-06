/* Loads the string engine straight out of index.html and checks the things
   that go wrong silently in a physical model: tuning drift up the neck,
   a coupled bridge network that rings itself up, clicks on a re-pluck,
   and NaN.
   Run: node dev/verify.mjs            (add --wav to also render demo audio) */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const RATE = 48000;

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const m = html.match(/<script id="dsp"[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.error('no dsp block in index.html'); process.exit(1); }

const factory = new Function(`
  const sampleRate = ${RATE};
  ${m[1]}
  return { Guitar, GuitarString, Delay, OnePole, Biquad, onePoleMag, onePolePhaseDelay, makeRng };
`);
const E = factory();

let failures = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  const tag = ok ? '  ok  ' : ' FAIL ';
  console.log(`[${tag}] ${name}${detail ? '   ' + detail : ''}`);
}

/* ---------- helpers ---------- */

function render(guitar, seconds, events) {
  const n = Math.round(seconds * RATE);
  const L = new Float32Array(n), R = new Float32Array(n);
  const block = 128;
  const evts = (events || []).slice().sort((a, b) => a.at - b.at);
  let ei = 0;
  const bl = new Float32Array(block), br = new Float32Array(block);
  for (let off = 0; off < n; off += block) {
    const t = off / RATE;
    while (ei < evts.length && evts[ei].at <= t) { guitar.handle(evts[ei].msg); ei++; }
    const len = Math.min(block, n - off);
    guitar.render(bl, br, len);
    L.set(bl.subarray(0, len), off);
    R.set(br.subarray(0, len), off);
  }
  return { L, R, n };
}

/* Period measured across many cycles at once, so the parabolic refinement
   error gets divided by the number of cycles spanned. Good to ~0.02 cents.
   Two stages, because a wide search around a lag of K periods will happily
   lock onto K+1 periods instead and report a confident answer 40 cents out.
   Stage one pins the period to within a fraction of a sample over a single
   cycle, stage two only refines inside +/- 0.4 of a period around K of them. */
function measureHz(x, expected, startSec) {
  const s = Math.round((startSec === undefined ? 0.12 : startSec) * RATE);
  const Pguess = RATE / expected;
  const win = Math.min(8192, Math.max(1024, Math.round(8 * Pguess)));

  const corr = (l) => {
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < win; i++) {
      const a = x[s + i], b = x[s + i + l];
      num += a * b; da += a * a; db += b * b;
    }
    const d = Math.sqrt(da * db);
    return d < 1e-20 ? 0 : num / d;
  };
  const refine = (lo, hi) => {
    let best = -1, bv = -2;
    for (let l = lo; l <= hi; l++) { const v = corr(l); if (v > bv) { bv = v; best = l; } }
    if (best < 1 || bv < 0.25) return null;
    const y0 = corr(best - 1), y2 = corr(best + 1);
    const den = y0 - 2 * bv + y2;
    const frac = Math.abs(den) < 1e-12 ? 0 : 0.5 * (y0 - y2) / den;
    return best + Math.max(-1, Math.min(1, frac));
  };

  /* stage one: one period, wide enough to catch a badly mistuned note */
  if (s + win + Math.ceil(Pguess * 1.35) + 4 > x.length) return null;
  const p1 = refine(Math.max(2, Math.floor(Pguess * 0.7)), Math.ceil(Pguess * 1.35));
  if (p1 === null) return null;

  /* stage two: K periods out, searched only inside one period either side */
  const K = Math.max(1, Math.round(Math.min(9000, Math.max(4000, 6 * p1)) / p1));
  const lag0 = K * p1;
  if (s + win + Math.ceil(lag0 + p1) + 4 > x.length) return RATE / p1;
  const p2 = refine(Math.max(2, Math.floor(lag0 - 0.4 * p1)), Math.ceil(lag0 + 0.4 * p1));
  if (p2 === null) return RATE / p1;
  return RATE / (p2 / K);
}

/* plain iterative radix 2 fft, real input */
function fftMag(x, off, N) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    re[i] = (x[off + i] || 0) * w;
  }
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const mag = new Float64Array(N / 2);
  for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}

function centroidHz(x, startSec) {
  const N = 16384;
  const off = Math.round(startSec * RATE);
  if (off + N > x.length) return 0;
  const mag = fftMag(x, off, N);
  let num = 0, den = 0;
  for (let k = 1; k < N / 2; k++) {
    const p = mag[k] * mag[k];
    num += p * ((k * RATE) / N); den += p;
  }
  return den > 0 ? num / den : 0;
}

function cents(f, ref) { return 1200 * Math.log2(f / ref); }

function peakEnvelope(x, winSec) {
  const w = Math.round(winSec * RATE);
  const out = [];
  for (let i = 0; i + w <= x.length; i += w) {
    let p = 0;
    for (let k = 0; k < w; k++) { const a = Math.abs(x[i + k]); if (a > p) p = a; }
    out.push(p);
  }
  return out;
}

function hasBadSamples(x) {
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) return 'nan at ' + i;
    if (v > 1.55 || v < -1.55) return 'clipped ' + v.toFixed(3) + ' at ' + i;
  }
  return null;
}

const OPEN = [82.407, 110.0, 146.832, 195.998, 246.942, 329.628];
const fret = (open, f) => open * Math.pow(2, f / 12);

/* ---------- 1. the fractional delay interpolator must not have gain ---------- */
{
  let worst = 0, worstAt = null;
  for (let mu = 1.0; mu < 2.0; mu += 0.02) {
    const m1 = mu - 1, m2 = mu - 2, m3 = mu - 3;
    const c = [-(m1 * m2 * m3) / 6, (mu * m2 * m3) / 2, -(mu * m1 * m3) / 2, (mu * m1 * m2) / 6];
    for (let k = 0; k <= 500; k++) {
      const w = (Math.PI * k) / 500;
      let re = 0, im = 0;
      for (let t = 0; t < 4; t++) { re += c[t] * Math.cos(-w * t); im += c[t] * Math.sin(-w * t); }
      const mag = Math.hypot(re, im);
      if (mag > worst) { worst = mag; worstAt = { mu: mu.toFixed(2), w: (w / Math.PI).toFixed(2) }; }
    }
  }
  check('lagrange interpolator never exceeds unity gain', worst <= 1.0001,
    `max |H| = ${worst.toFixed(6)} at mu=${worstAt.mu}, w=${worstAt.w}pi`);
}

/* ---------- 2. sum of the interpolator taps is 1 (dc gain) ---------- */
{
  let worst = 0;
  for (let mu = 1.0; mu < 2.0; mu += 0.01) {
    const m1 = mu - 1, m2 = mu - 2, m3 = mu - 3;
    const s = -(m1 * m2 * m3) / 6 + (mu * m2 * m3) / 2 - (mu * m1 * m3) / 2 + (mu * m1 * m2) / 6;
    worst = Math.max(worst, Math.abs(s - 1));
  }
  check('interpolator dc gain is exactly 1', worst < 1e-12, `max error ${worst.toExponential(2)}`);
}

/* ---------- 3. tuning across the whole neck ---------- */
{
  let worst = 0, worstAt = '', bad = 0, tested = 0;
  const table = [];
  for (let s = 0; s < 6; s++) {
    for (const f of [0, 3, 5, 7, 12, 15, 17, 19, 22]) {
      const g = new E.Guitar(RATE);
      const target = fret(OPEN[s], f);
      const { L } = render(g, 1.6, [{ at: 0, msg: { t: 'pluck', s, vel: 0.85, pos: 0.17, freq: target } }]);
      const hz = measureHz(L, target, 0.15);
      tested++;
      if (hz === null) { bad++; table.push(`s${s + 1}f${f}: no pitch`); continue; }
      const c = cents(hz, target);
      if (Math.abs(c) > worst) { worst = Math.abs(c); worstAt = `string ${s + 1} fret ${f}`; }
      if (Math.abs(c) > 3) table.push(`s${s + 1}f${f}: ${c.toFixed(2)}c`);
    }
  }
  check('every fretted note within 3 cents', worst <= 3 && bad === 0,
    `worst ${worst.toFixed(2)} cents at ${worstAt}, ${tested} notes` +
    (table.length ? '\n         ' + table.join('\n         ') : ''));
}

/* ---------- 4. decay time lands near the target ---------- */
{
  const g = new E.Guitar(RATE);
  const { L } = render(g, 7.0, [{ at: 0, msg: { t: 'pluck', s: 0, vel: 1.0, pos: 0.17 } }]);
  const env = peakEnvelope(L, 0.05);
  const p0 = Math.max(...env.slice(0, 6));
  let t60 = null;
  for (let i = 3; i < env.length; i++) if (env[i] < p0 / 1000) { t60 = i * 0.05; break; }
  check('low E decays in a plausible time', t60 !== null && t60 > 2.5 && t60 < 9,
    `t60 = ${t60 === null ? 'still ringing at 7s' : t60.toFixed(2) + 's'} (asked for ~5.5s)`);
}

/* ---------- 5. coupled bridge does not ring itself up ---------- */
{
  const g = new E.Guitar(RATE);
  const ev = [];
  for (let s = 0; s < 6; s++) ev.push({ at: s * 0.012, msg: { t: 'pluck', s, vel: 1.0, pos: 0.14 } });
  const { L, R } = render(g, 30, ev);
  const badL = hasBadSamples(L), badR = hasBadSamples(R);
  const env = peakEnvelope(L, 0.25);
  const attack = Math.max(...env.slice(0, 4));
  let grew = null;
  for (let i = 8; i < env.length; i++) {
    const before = Math.max(...env.slice(Math.max(0, i - 8), i));
    if (env[i] > before * 1.35 && env[i] > 0.02) { grew = i * 0.25; break; }
  }
  const tail = env[env.length - 1];
  check('30 second six string ring stays finite and decays',
    !badL && !badR && grew === null && tail < attack * 0.5,
    `${badL || badR || 'no nan'}, peak ${attack.toFixed(3)}, tail ${tail.toExponential(2)}` +
    (grew !== null ? `, grew again at ${grew}s` : ''));
}

/* ---------- 6. re-plucking a ringing string must not click ----------
   The fair comparison is against the attack of a single pluck on a silent
   string: that transient is real and wanted. Anything much sharper than it
   is the choke discontinuity leaking through. */
{
  const maxJump = (x) => {
    let worst = 0, at = 0;
    for (let i = 1; i < x.length; i++) {
      const d = Math.abs(x[i] - x[i - 1]);
      if (d > worst) { worst = d; at = i / RATE; }
    }
    return { worst, at };
  };
  const quiet = { at: -1, msg: { t: 'fretnoise', v: 0 } };
  const one = new E.Guitar(RATE);
  const single = maxJump(render(one, 2.0, [quiet,
    { at: 0.0, msg: { t: 'pluck', s: 2, vel: 0.9, pos: 0.17 } }]).L);
  const g = new E.Guitar(RATE);
  const repeat = maxJump(render(g, 2.0, [quiet,
    { at: 0.0, msg: { t: 'pluck', s: 2, vel: 0.9, pos: 0.17 } },
    { at: 0.4, msg: { t: 'pluck', s: 2, vel: 0.9, pos: 0.17 } },
    { at: 0.8, msg: { t: 'pluck', s: 2, vel: 0.9, pos: 0.17 } },
    { at: 1.2, msg: { t: 'pluck', s: 2, vel: 0.9, pos: 0.17 } },
  ]).L);
  check('re-plucking a ringing string is no sharper than a fresh attack',
    repeat.worst < single.worst * 1.35,
    `worst step ${repeat.worst.toFixed(5)} re-plucked vs ${single.worst.toFixed(5)} fresh` +
    ` (at ${repeat.at.toFixed(3)}s)`);

  /* The contact noise is wanted, and the honest place to look for it is the
     tail of the choke fade: the string is nearly at zero there, so whatever
     is left is the sound of a hand landing on it. Subtraction will not work,
     because switching the noise off also changes the random stream. */
  const chokeTail = (fretNoise) => {
    const g2 = new E.Guitar(RATE);
    const x = render(g2, 0.6, [
      { at: -1, msg: { t: 'fretnoise', v: fretNoise } },
      { at: 0.0, msg: { t: 'pluck', s: 2, vel: 0.9, pos: 0.17 } },
      { at: 0.4, msg: { t: 'pluck', s: 2, vel: 0.9, pos: 0.17 } },
    ]).L;
    let ring = 0, tail = 0;
    for (let i = Math.round(0.30 * RATE); i < Math.round(0.39 * RATE); i++) ring = Math.max(ring, Math.abs(x[i]));
    for (let i = Math.round(0.4020 * RATE); i < Math.round(0.4026 * RATE); i++) tail = Math.max(tail, Math.abs(x[i]));
    return { ring, tail };
  };
  const off = chokeTail(0), on = chokeTail(1);
  const r = on.tail / Math.max(1e-12, off.tail);
  check('a hand landing on a ringing string makes a sound', r > 2 && on.tail < on.ring,
    `choke tail is ${r.toFixed(1)}x louder with contact noise on, and sits ` +
    `${(20 * Math.log10(on.tail / on.ring)).toFixed(1)} dB under the ringing string`);
}

/* ---------- 7. pluck position actually changes the spectrum ---------- */
{
  const a = new E.Guitar(RATE);
  const bridgeSide = render(a, 0.9, [{ at: 0, msg: { t: 'pluck', s: 2, vel: 0.9, pos: 0.06, hard: 1 } }]).L;
  const b = new E.Guitar(RATE);
  const neckSide = render(b, 0.9, [{ at: 0, msg: { t: 'pluck', s: 2, vel: 0.9, pos: 0.45, hard: 1 } }]).L;
  const cb = centroidHz(bridgeSide, 0.05), cn = centroidHz(neckSide, 0.05);
  check('plucking near the bridge is brighter than over the neck', cb > cn * 1.2,
    `centroid ${Math.round(cb)} Hz near bridge vs ${Math.round(cn)} Hz over the neck`);
}

/* ---------- 7b. the pluck position nulls are actually there ----------
   A string plucked at 1/5 of its length has no 5th, 10th or 15th harmonic.
   This is the single clearest sign the excitation is a real plucked shape
   and not a noise burst. */
{
  const g = new E.Guitar(RATE);
  const f0 = OPEN[2];
  const { L } = render(g, 0.9, [{ at: 0, msg: { t: 'pluck', s: 2, vel: 0.9, pos: 0.2, hard: 1, noise: 0 } }]);
  const N = 16384;
  const mag = fftMag(L, Math.round(0.03 * RATE), N);
  const at = (n) => {
    const bin = Math.round((n * f0 * N) / RATE);
    let p = 0;
    for (let k = bin - 2; k <= bin + 2; k++) p = Math.max(p, mag[k] || 0);
    return p;
  };
  const null5 = at(5) / Math.max(1e-12, (at(4) + at(6)) / 2);
  const null10 = at(10) / Math.max(1e-12, (at(9) + at(11)) / 2);
  check('the 5th and 10th harmonics are suppressed when plucking at 1/5',
    null5 < 0.35 && null10 < 0.5,
    `5th is ${(20 * Math.log10(null5)).toFixed(1)} dB and 10th ${(20 * Math.log10(null10)).toFixed(1)} dB` +
    ' below their neighbours');
}

/* ---------- 8. velocity changes level and brightness ---------- */
{
  const soft = new E.Guitar(RATE);
  const s1 = render(soft, 0.6, [{ at: 0, msg: { t: 'pluck', s: 3, vel: 0.15, pos: 0.17 } }]).L;
  const hard = new E.Guitar(RATE);
  const s2 = render(hard, 0.6, [{ at: 0, msg: { t: 'pluck', s: 3, vel: 1.0, pos: 0.17 } }]).L;
  const pk = (x) => { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); return p; };
  const r = pk(s2) / Math.max(1e-9, pk(s1));
  check('velocity maps to level', r > 3 && r < 30, `hard is ${r.toFixed(1)}x the soft pluck`);
}

/* ---------- 9. every message the ui sends is handled without throwing ---------- */
{
  const g = new E.Guitar(RATE);
  let err = null;
  try {
    const msgs = [
      { t: 'pluck', s: 0, vel: 0.8, pos: 0.2 },
      { t: 'pluck', s: 5, vel: 0.8, pos: 0.2, harmonic: 2 },
      { t: 'pluck', s: 3, vel: 0.8, pos: 0.2, slide: 0.002 },
      { t: 'mute', s: 1, a: 0.7 }, { t: 'allmute', a: 1 },
      { t: 'bend', s: 2, c: 200 }, { t: 'vib', s: 2, d: 30, r: 6 },
      { t: 'tuning', f: [73.416, 110, 146.832, 195.998, 246.942, 329.628] },
      { t: 'couple', v: 0.03 }, { t: 'body', v: 0.5 },
      { t: 'inst', inst: { brightness: 0.8, decaySeconds: 3, combDepth: 1, combFrac: 0.09,
        modes: [{ name: 'x', freqHz: 120, q: 6, gainDb: 1 }] } },
      { t: 'silence' }, { t: 'nonsense' },
    ];
    render(g, 1.0, msgs.map((msg, i) => ({ at: i * 0.05, msg })));
  } catch (e) { err = e.message; }
  check('handles the full message set without throwing', err === null, err || 'all 13 messages');
}

/* ---------- 10. extreme input does not blow up ---------- */
{
  const g = new E.Guitar(RATE);
  const ev = [];
  for (let i = 0; i < 260; i++) {
    ev.push({ at: i * 0.012, msg: { t: 'pluck', s: i % 6, vel: 1.0, pos: 0.05, hard: 1, noise: 0.6 } });
  }
  const { L, R } = render(g, 6, ev);
  const bad = hasBadSamples(L) || hasBadSamples(R);
  let peak = 0;
  for (const v of L) peak = Math.max(peak, Math.abs(v));
  check('260 hard plucks in 3 seconds stays finite', !bad, `${bad || 'clean'}, peak ${peak.toFixed(3)}`);
}

/* ---------- 11. harmonics land an octave (or a twelfth) up ---------- */
{
  for (const [h, name] of [[2, 'twelfth fret'], [3, 'seventh fret']]) {
    const g = new E.Guitar(RATE);
    const target = OPEN[2] * h;
    const { L } = render(g, 1.2, [{ at: 0, msg: { t: 'pluck', s: 2, vel: 0.9, pos: 0.25, harmonic: h } }]);
    const hz = measureHz(L, target, 0.2);
    const c = hz === null ? null : cents(hz, target);
    check(`${name} harmonic is in tune`, c !== null && Math.abs(c) < 8,
      c === null ? 'no pitch found' : `${c.toFixed(2)} cents off ${target.toFixed(1)} Hz`);
  }
}

/* ---------- 12. scheduled plucks land on the right sample ---------- */
{
  const g = new E.Guitar(RATE);
  /* one strum, six strings, 9 ms apart, all posted in the same block */
  const offsets = [0, 432, 864, 1296, 1728, 2160];
  const g2 = new E.Guitar(RATE);
  const msgs = offsets.map((d, s) => ({ at: 0, msg: { t: 'pluck', s, vel: 0.9, pos: 0.15, d } }));
  const { L } = render(g2, 1.5, msgs);

  /* find where each string actually starts moving by watching its envelope */
  const onset = [];
  const g3 = new E.Guitar(RATE);
  for (let s = 0; s < 6; s++) {
    const solo = new E.Guitar(RATE);
    const out = render(solo, 0.2, [{ at: 0, msg: { t: 'pluck', s, vel: 0.9, pos: 0.15, d: offsets[s] } }]).L;
    let i = 0;
    while (i < out.length && Math.abs(out[i]) < 1e-4) i++;
    onset.push(i);
  }
  const err = onset.map((o, i) => Math.abs(o - offsets[i]));
  const worst = Math.max(...err);
  check('a scheduled pluck fires within a couple of samples of its offset',
    worst <= 4 && !hasBadSamples(L),
    `worst offset error ${worst} samples across a six string strum`);
  void g; void g3;
}

/* ---------- 13. absolute time scheduling, the path the app uses ----------
   The app hands the engine an AudioContext timestamp, not a sample offset.
   That path was dead once: every strum arrived as a block chord. */
{
  const targets = [0.10, 0.25, 0.42];
  const err = [];
  for (const t of targets) {
    const g = new E.Guitar(RATE);
    const out = render(g, 0.8, [{ at: 0, msg: { t: 'pluck', s: 2, vel: 0.9, pos: 0.15, at: t } }]).L;
    let i = 0;
    while (i < out.length && Math.abs(out[i]) < 1e-4) i++;
    err.push(Math.abs(i - Math.round(t * RATE)));
  }
  const worst = Math.max(...err);
  check('a pluck given an absolute time fires at that time, not on arrival',
    worst <= 200, `worst ${worst} samples off across ${targets.length} scheduled notes`);

  /* and a six string strum must actually arrive spread out */
  const g2 = new E.Guitar(RATE);
  const msgs = [];
  for (let s = 0; s < 6; s++) {
    msgs.push({ at: 0, msg: { t: 'pluck', s, vel: 0.9, pos: 0.15, at: 0.05 + s * 0.012 } });
  }
  const onsets = [];
  for (let s = 0; s < 6; s++) {
    const solo = new E.Guitar(RATE);
    const out = render(solo, 0.5, [msgs[s]]).L;
    let i = 0;
    while (i < out.length && Math.abs(out[i]) < 1e-4) i++;
    onsets.push(i / RATE);
  }
  const gaps = [];
  for (let i = 1; i < 6; i++) gaps.push(onsets[i] - onsets[i - 1]);
  const spread = onsets[5] - onsets[0];
  check('a six string strum arrives spread out, not as one block chord',
    spread > 0.05 && gaps.every((q) => q > 0.008 && q < 0.017),
    `${(spread * 1000).toFixed(1)} ms from first string to last`);
  void g2;
}

/* ---------- 14. a capo must not snap a ringing note to the open string ---------- */
{
  const g = new E.Guitar(RATE);
  /* fret the A string at the fifth and let it ring */
  const fretted = fret(OPEN[1], 5);
  const capoUp = OPEN.map((f) => f * Math.pow(2, 2 / 12));
  const { L } = render(g, 2.4, [
    { at: 0, msg: { t: 'pluck', s: 1, vel: 0.95, pos: 0.17, freq: fretted } },
    { at: 0.7, msg: { t: 'tuning', f: capoUp } },
  ]);
  const before = measureHz(L, fretted, 0.25);
  const after = measureHz(L, fretted * Math.pow(2, 2 / 12), 1.3);
  const wantAfter = fretted * Math.pow(2, 2 / 12);
  const openAfter = capoUp[1];
  const ok = before !== null && after !== null &&
    Math.abs(cents(before, fretted)) < 12 &&
    Math.abs(cents(after, wantAfter)) < 25 &&
    Math.abs(cents(after, openAfter)) > 200;
  check('a capo carries a ringing fretted note up with it',
    ok,
    before === null || after === null ? 'could not measure' :
    `${before.toFixed(1)} Hz then ${after.toFixed(1)} Hz, wanted ${wantAfter.toFixed(1)} ` +
    `(the open string would be ${openAfter.toFixed(1)})`);

  /* and it must glide there rather than jump */
  let worst = 0;
  const from = Math.round(0.69 * RATE), to = Math.round(0.78 * RATE);
  let ref = 0;
  for (let i = 1; i < L.length; i++) { const d = Math.abs(L[i] - L[i - 1]); if (i < from && d > ref) ref = d; }
  for (let i = from; i < to; i++) { const d = Math.abs(L[i] - L[i - 1]); if (d > worst) worst = d; }
  check('the retune is a slide, not a jump', worst <= ref * 1.3,
    `largest step through the change ${worst.toFixed(5)} against ${ref.toFixed(5)} while just ringing`);
}

/* ---------- optional: render something to listen to ---------- */
if (process.argv.includes('--wav')) {
  const g = new E.Guitar(RATE);
  const ev = [];
  const chords = [
    [0, 2, 2, 1, 0, 0],   // E
    [-1, 0, 2, 2, 1, 0],  // Am
    [3, 2, 0, 0, 0, 3],   // G
    [-1, 3, 2, 0, 1, 0],  // C
  ];
  let t = 0;
  for (let rep = 0; rep < 2; rep++) {
    for (const ch of chords) {
      for (let s = 0; s < 6; s++) {
        if (ch[s] < 0) continue;
        ev.push({ at: t + s * 0.016, msg: {
          t: 'pluck', s, vel: 0.62 + (s % 2) * 0.12, pos: 0.16,
          freq: fret(OPEN[s], ch[s]) } });
      }
      t += 1.35;
    }
  }
  const { L, R, n } = render(g, t + 3, ev);
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, L[i])) * 32767;
    const r = Math.max(-1, Math.min(1, R[i])) * 32767;
    buf.writeInt16LE(l | 0, 44 + i * 4);
    buf.writeInt16LE(r | 0, 46 + i * 4);
  }
  const out = path.join(HERE, 'demo.wav');
  fs.writeFileSync(out, buf);
  console.log('\nwrote ' + out);
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
