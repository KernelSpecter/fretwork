/* Loads the listener straight out of index.html and plays it signals this file
   builds, so there is nothing to hear in the repo and every expected answer is
   spelled out here rather than trusted.

   The point of the numbers below is that they are honest. Working out what
   chords are in a finished recording is not a solved problem, and this does it
   with signal processing rather than a trained model, so it is right most of
   the time and not all of the time. Each case says what it must get right, and
   the floors are set where the method actually is, not where it would be nice
   for it to be. If a change pushes one of them up, raise the floor. If a change
   pushes one down, that is a regression however good the reasoning was.

   Run: node dev/listen.mjs            (add --show to print each chart) */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const block = html.match(/<script id="listener"[^>]*>([\s\S]*?)<\/script>/);
if (!block) { console.error('no listener block in index.html'); process.exit(1); }
const L = new Function(`${block[1]}\nreturn LISTENER;`)();
const REF = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'reference.json'), 'utf8'));

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${name}${detail ? '   ' + detail : ''}`);
}

/* ---------- something to listen to ---------- */

const VOICING = {
  C: [60, 64, 67], Am: [57, 60, 64], F: [53, 57, 60], G: [55, 59, 62],
  D: [62, 66, 69], Em: [52, 55, 59], A: [57, 61, 64], E: [52, 56, 59],
  Dm: [62, 65, 69], Bm: [59, 62, 66], G7: [55, 59, 62, 65], C7: [60, 64, 67, 70],
};
const ROOT_NOTE = {
  C: 36, Am: 45, F: 41, G: 43, D: 38, Em: 40, A: 45, E: 40, Dm: 38, Bm: 47, G7: 43, C7: 36,
};

const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/* Plucked strings: a handful of harmonics each, decaying. Not a real
   recording, but it has the thing that makes this hard in it, which is that
   every note's overtones look like other notes. */
function render(seq, bpm, opts) {
  const o = Object.assign({ rate: 44100, harmonics: 6, noise: 0, bass: true, hits: 4 }, opts || {});
  const rate = o.rate;
  const beat = 60 / bpm;
  const barSec = beat * 4;
  const n = Math.round(seq.length * barSec * rate);
  const buf = new Float32Array(n);

  seq.forEach((name, bar) => {
    for (let hit = 0; hit < o.hits; hit++) {
      const t0 = Math.round((bar * barSec + hit * (barSec / o.hits)) * rate);
      const notes = VOICING[name].slice();
      if (o.bass) notes.push(ROOT_NOTE[name]);
      notes.forEach((midi, mi) => {
        const isBass = o.bass && mi === notes.length - 1;
        for (let k = 1; k <= o.harmonics; k++) {
          const f = hz(midi) * k;
          if (f > rate / 2.2) break;
          const amp = (isBass ? 0.42 : 0.22) / k;
          const len = Math.min(rate * 0.55, n - t0);
          for (let i = 0; i < len; i++) {
            buf[t0 + i] += amp * Math.exp(-i / (rate * 0.22)) * Math.sin((2 * Math.PI * f * i) / rate);
          }
        }
      });
    }
  });
  if (o.noise) for (let i = 0; i < n; i++) buf[i] += (Math.random() - 0.5) * o.noise;
  return { channels: [buf], rate };
}

/* The listener is free to start its bar lines wherever it finds them, so the
   answer is scored against the truth rotated to wherever it started. */
function score(heard, seq, bpm) {
  const barSec = (4 * 60) / bpm;
  const shift = Math.round(heard.offset / barSec);
  const got = heard.bars.map((b) => b.chord);
  let hits = 0;
  for (let i = 0; i < got.length; i++) if (got[i] === seq[(i + shift) % seq.length]) hits++;
  return { hits, of: got.length, got, shift };
}

/* ---------- the pieces, on their own ---------- */

{
  /* an FFT that is wrong makes everything above it wrong quietly */
  const n = 64;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / n);
  L.fft(re, im);
  let peak = 1, best = 0;
  for (let k = 1; k < n / 2; k++) {
    const m = Math.hypot(re[k], im[k]);
    if (m > best) { best = m; peak = k; }
  }
  check('the FFT puts a sine wave in the right bin', peak === 5, `peak at bin ${peak}, expected 5`);
}

{
  const rate = 44100;
  const n = rate * 2;
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { a[i] = 0.5; b[i] = -0.1; }
  const { x, rate: got } = L.condition([a, b], rate);
  const avg = x.reduce((p, q) => p + q, 0) / x.length;
  check('two channels come down to one, at the working rate',
    got === L.RATE && Math.abs(avg - 0.2) < 0.01 && Math.abs(x.length - (n / rate) * L.RATE) < 64,
    `${x.length} samples at ${got}Hz, mean ${avg.toFixed(3)}`);
}

{
  /* a chord's own overtones must not outvote its root */
  const one = render(['G'], 60, { hits: 1 });
  const spec = L.spectrogram(L.condition(one.channels, one.rate).x);
  const chroma = L.chromagram(spec);
  const avg = new Float32Array(12);
  for (const row of chroma) for (let p = 0; p < 12; p++) avg[p] += row[p] / chroma.length;
  let top = 0;
  for (let p = 1; p < 12; p++) if (avg[p] > avg[top]) top = p;
  check('a G chord reads as a G and not as its own third harmonic',
    L.NAMES_SHARP[top] === 'G', `loudest pitch class is ${L.NAMES_SHARP[top]}`);
}

{
  for (const bpm of [72, 96, 120, 144]) {
    const { channels, rate } = render(['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G'], bpm, {});
    const { x } = L.condition(channels, rate);
    const spec = L.spectrogram(x);
    const env = L.onsetStrength(spec);
    const t = L.findTempo(env, spec.fps);
    const off = Math.abs(t.bpm - bpm) / bpm;
    /* within 4%, or an exact double or half, which is a defensible reading of
       the same pulse rather than a wrong answer */
    const octave = Math.abs(t.bpm - bpm * 2) / bpm < 0.06 || Math.abs(t.bpm - bpm / 2) / bpm < 0.03;
    check(`the tempo of a ${bpm} bpm part is found`, off < 0.04 || octave, `found ${t.bpm.toFixed(1)}`);
  }
}

{
  const c = new Float32Array(12); c[0] = 1; c[4] = 1; c[7] = 1;      // C E G
  const scores = [];
  for (const tpl of L.TEMPLATES) scores.push([tpl.suffix || 'major', L.scoreChord(c, 0, tpl, null)]);
  scores.sort((a, b) => b[1] - a[1]);
  check('a plain triad scores as a plain triad, not as a seventh',
    scores[0][0] === 'major', scores.map(([n, v]) => `${n}=${v.toFixed(2)}`).join(' '));

  const bassF = new Float32Array(12); bassF[5] = 1;
  const bassA = new Float32Array(12); bassA[9] = 1;
  const shared = new Float32Array(12);
  shared[5] = 1; shared[9] = 1; shared[0] = 1;                        // F A C
  const asF = L.scoreChord(shared, 5, L.TEMPLATES[0], bassF);
  const asAm = L.scoreChord(shared, 9, L.TEMPLATES[1], bassA);
  const fWithFBass = L.scoreChord(shared, 5, L.TEMPLATES[0], bassF);
  const amWithFBass = L.scoreChord(shared, 9, L.TEMPLATES[1], bassF);
  check('the bass note decides between chords that share their notes',
    fWithFBass > amWithFBass, `F over an F bass ${asF.toFixed(3)} beats Am over it ${amWithFBass.toFixed(3)}`);
  void asAm;
}

{
  const find = L.shapeFinder(REF, 12);
  const missing = [];
  for (let root = 0; root < 12; root++) {
    for (const suffix of ['', 'm', '7', 'm7']) {
      const got = find(root, suffix);
      if (!got) { missing.push(L.NAMES_SHARP[root] + suffix); continue; }
      const on = got.frets.filter((f) => f >= 0);
      if (!on.length || Math.max(...on) > 12) missing.push(L.NAMES_SHARP[root] + suffix + ' out of reach');
      if (on.length < 2) missing.push(L.NAMES_SHARP[root] + suffix + ' sounds one string');
    }
  }
  check('every root and quality it can hear has a shape a hand can hold',
    missing.length === 0, missing.slice(0, 6).join(', '));

  /* a movable shape slid up the neck must still be the chord it claims */
  const bad = [];
  for (let root = 0; root < 12; root++) {
    const got = find(root, 'm');
    if (!got) continue;
    const OPEN = [40, 45, 50, 55, 59, 64];
    const pcs = new Set();
    got.frets.forEach((f, s) => { if (f >= 0) pcs.add((OPEN[s] + f) % 12); });
    const want = [root % 12, (root + 3) % 12, (root + 7) % 12];
    for (const p of pcs) if (!want.includes(p)) bad.push(`${L.NAMES_SHARP[root]}m sounds ${L.NAMES_SHARP[p]}`);
    for (const p of want) if (!pcs.has(p)) bad.push(`${L.NAMES_SHARP[root]}m is missing ${L.NAMES_SHARP[p]}`);
  }
  check('a barre shape slid to a new root is still that chord', bad.length === 0, bad.slice(0, 4).join('; '));
}

/* ---------- the whole thing, on a recording ---------- */

const CASES = [
  { label: 'I vi IV V, plain', seq: ['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G'], bpm: 100, opts: {}, floor: 1.0, key: 'Am' },
  { label: 'I V vi IV in G', seq: ['G', 'D', 'Em', 'C', 'G', 'D', 'Em', 'C'], bpm: 120, opts: {}, floor: 1.0 },
  { label: 'vi IV I V in Am', seq: ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'], bpm: 84, opts: {}, floor: 1.0 },
  { label: 'I IV V in E', seq: ['E', 'A', 'D', 'E', 'E', 'A', 'D', 'E'], bpm: 132, opts: {}, floor: 1.0 },
  { label: 'no bass under it', seq: ['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G'], bpm: 100, opts: { bass: false }, floor: 0.55 },
  { label: 'noisy', seq: ['G', 'D', 'Em', 'C', 'G', 'D', 'Em', 'C'], bpm: 96, opts: { noise: 0.06 }, floor: 0.55 },
  { label: 'sevenths in it', seq: ['C', 'Am', 'Dm', 'G7', 'C', 'Am', 'Dm', 'G7'], bpm: 108, opts: {}, floor: 0.55 },
  { label: 'two hits a bar', seq: ['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G'], bpm: 100, opts: { hits: 2 }, floor: 0.7 },
];

let allHits = 0, allOf = 0;
for (const c of CASES) {
  const { channels, rate } = render(c.seq, c.bpm, c.opts);
  let heard;
  try { heard = L.listen(channels, rate, REF, {}); } catch (e) {
    check(`it hears "${c.label}"`, false, e.message);
    continue;
  }
  const s = score(heard, c.seq, c.bpm);
  allHits += s.hits; allOf += s.of;
  const frac = s.of ? s.hits / s.of : 0;

  check(`"${c.label}" comes back at least ${Math.round(c.floor * 100)}% right`,
    frac >= c.floor - 1e-9 && heard.barCount > 0,
    `${s.hits}/${s.of} bars, ${heard.tempo} bpm against ${c.bpm}, ${Math.round(heard.confidence * 100)}% sure`);

  if (process.argv.includes('--show')) {
    console.log(`         want ${c.seq.join(' ')}`);
    console.log(`         got  ${s.got.join(' ')}   (started ${heard.offset.toFixed(2)}s in, key ${heard.key})`);
  }

  /* whatever it decided, the chart has to be playable and self consistent */
  let broken = 0;
  for (const bar of heard.bars) {
    if (bar.shape < 0) { broken++; continue; }
    const shape = REF.chordShapes[bar.shape];
    if (!shape) broken++;
    if (bar.frets.filter((f) => f >= 0).length < 2) broken++;
    if (Math.max(...bar.frets) > 12) broken++;
    if (!bar.pat) broken++;
    if (!(bar.confidence >= 0 && bar.confidence <= 1)) broken++;
  }
  check(`and every bar of "${c.label}" is playable`, broken === 0, `${broken} of ${heard.barCount}`);
}

check(`across every case it is at least 80% right on the chords`,
  allOf > 0 && allHits / allOf >= 0.8,
  `${allHits}/${allOf} = ${Math.round((100 * allHits) / allOf)}%`);

{
  /* the tempo it reports has to be the tempo the chart is written at, or the
     guitar plays the right chords at the wrong speed */
  const { channels, rate } = render(['C', 'Am', 'F', 'G'], 100, {});
  const heard = L.listen(channels, rate, REF, {});
  const barSec = (heard.beatsPerBar * 60) / heard.tempo;
  check('the chart is as long as the recording it came from',
    Math.abs(heard.barCount * barSec - heard.seconds) < barSec * 1.6,
    `${heard.barCount} bars of ${barSec.toFixed(2)}s against ${heard.seconds.toFixed(2)}s of audio`);
  check('it says how sure it is, and the number means something',
    heard.confidence > 0 && heard.confidence <= 1 && heard.tempoConfidence >= 0,
    `${Math.round(heard.confidence * 100)}% on the chords, ${Math.round(heard.tempoConfidence * 100)}% on the tempo`);
}

{
  const refusals = [
    ['nothing at all', [new Float32Array(0)], 44100],
    ['a fraction of a second', [new Float32Array(4410)], 44100],
  ];
  let refused = 0;
  for (const [, ch, rate] of refusals) {
    try { L.listen(ch, rate, REF, {}); } catch (e) { refused++; }
  }
  check('a file with nothing in it to hear is refused', refused === refusals.length, `${refused} of ${refusals.length}`);

  /* silence is not a refusal, but it must not invent a song either */
  let quiet = null;
  try { quiet = L.listen([new Float32Array(44100 * 6)], 44100, REF, {}); } catch (e) { quiet = 'refused'; }
  check('silence does not turn into a confident chart',
    quiet === 'refused' || quiet.confidence < 0.4,
    quiet === 'refused' ? 'refused' : `${Math.round(quiet.confidence * 100)}% sure of ${quiet.barCount} bars`);
}

console.log(`\n${failures ? failures + ' failed' : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
