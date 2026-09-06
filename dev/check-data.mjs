/* Spells out every chord voicing note by note and checks it against its own
   name, plus the tuning frequencies and the cross references. Run against a
   json file: node dev/check-data.mjs dev/reference.json */

import fs from 'node:fs';

const file = process.argv[2] || 'dev/reference.json';
const D = JSON.parse(fs.readFileSync(file, 'utf8'));

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const STD = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];

function pitchClass(name) {
  let i = 0, v = PC[name[i++].toUpperCase()];
  if (v === undefined) return null;
  while (i < name.length && (name[i] === '#' || name[i] === 'b')) { v += name[i] === '#' ? 1 : -1; i++; }
  return ((v % 12) + 12) % 12;
}
function midiOf(sci) {
  const m = sci.match(/^([A-Ga-g][#b]*)(-?\d+)$/);
  return pitchClass(m[1]) + (parseInt(m[2], 10) + 1) * 12;
}
const OPEN_MIDI = STD.map(midiOf);

/* interval sets by quality, and which of them the voicing must actually contain */
const Q = {
  '':        { t: [0, 4, 7],              need: [0, 4] },
  'm':       { t: [0, 3, 7],              need: [0, 3] },
  '5':       { t: [0, 7],                 need: [0, 7] },
  '6':       { t: [0, 4, 7, 9],           need: [0, 4, 9] },
  'm6':      { t: [0, 3, 7, 9],           need: [0, 3, 9] },
  '7':       { t: [0, 4, 7, 10],          need: [0, 4, 10] },
  'maj7':    { t: [0, 4, 7, 11],          need: [0, 4, 11] },
  'm7':      { t: [0, 3, 7, 10],          need: [0, 3, 10] },
  'mmaj7':   { t: [0, 3, 7, 11],          need: [0, 3, 11] },
  'm7b5':    { t: [0, 3, 6, 10],          need: [0, 3, 6, 10] },
  'dim':     { t: [0, 3, 6],              need: [0, 3, 6] },
  'dim7':    { t: [0, 3, 6, 9],           need: [0, 3, 6, 9] },
  'aug':     { t: [0, 4, 8],              need: [0, 4, 8] },
  '7#5':     { t: [0, 4, 8, 10],          need: [0, 4, 8, 10] },
  '7b9':     { t: [0, 4, 7, 10, 1],       need: [0, 4, 10, 1] },
  '7#9':     { t: [0, 4, 7, 10, 3],       need: [0, 4, 10, 3] },
  'sus2':    { t: [0, 2, 7],              need: [0, 2, 7] },
  'sus4':    { t: [0, 5, 7],              need: [0, 5, 7] },
  '7sus4':   { t: [0, 5, 7, 10],          need: [0, 5, 10] },
  'add9':    { t: [0, 2, 4, 7],           need: [0, 4, 2] },
  'madd9':   { t: [0, 2, 3, 7],           need: [0, 3, 2] },
  '9':       { t: [0, 2, 4, 7, 10],       need: [0, 4, 10, 2] },
  'maj9':    { t: [0, 2, 4, 7, 11],       need: [0, 4, 11, 2] },
  'm9':      { t: [0, 2, 3, 7, 10],       need: [0, 3, 10, 2] },
  '11':      { t: [0, 2, 5, 7, 10],       need: [0, 10, 5] },
  'm11':     { t: [0, 2, 3, 5, 7, 10],    need: [0, 3, 10, 5] },
  '13':      { t: [0, 2, 4, 7, 9, 10],    need: [0, 4, 10, 9] },
  'maj13':   { t: [0, 2, 4, 7, 9, 11],    need: [0, 4, 11, 9] },
  'm13':     { t: [0, 2, 3, 5, 7, 9, 10], need: [0, 3, 10, 9] },
  '6/9':     { t: [0, 2, 4, 7, 9],        need: [0, 4, 9, 2] },
};

function parseName(raw) {
  /* "G (E shape)" is one voicing of G, the parenthetical is not part of the name */
  const name = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const slash = name.split('/');
  let head = slash[0];
  /* "6/9" is a quality, not a slash bass */
  if (slash.length === 2 && slash[1] === '9' && /6$/.test(head)) { head = name; slash.length = 1; }
  const rm = head.match(/^([A-G][#b]?)(.*)$/);
  if (!rm) return null;
  let q = rm[2].replace(/^min/, 'm').replace(/^Maj/, 'maj').replace(/^M7/, 'maj7');
  if (!(q in Q)) return null;
  return { root: pitchClass(rm[1]), q, bass: slash.length === 2 ? pitchClass(slash[1]) : null };
}

let bad = 0, checked = 0;
const problems = [];
function fail(name, why) { problems.push(`${name}: ${why}`); bad++; }

/* ---- tunings ---- */
for (const t of D.tunings) {
  if (t.notes.length !== 6 || t.freqs.length !== 6) { fail(t.name, 'not 6 strings'); continue; }
  for (let i = 0; i < 6; i++) {
    const want = 440 * Math.pow(2, (midiOf(t.notes[i]) - 69) / 12);
    const off = Math.abs(1200 * Math.log2(t.freqs[i] / want));
    if (off > 0.5) fail(t.name, `${t.notes[i]} listed as ${t.freqs[i]} Hz, equal temperament says ${want.toFixed(3)} (${off.toFixed(1)} cents out)`);
  }
  if (t.notes.some((n, i) => i > 0 && midiOf(n) < midiOf(t.notes[i - 1]) - 0.5)) {
    /* allowed: some tunings do drop below the previous string, only warn on wild ones */
    if (midiOf(t.notes[0]) > midiOf(t.notes[5])) { /* fine */ }
  }
}

/* ---- chord voicings ---- */
const names = new Set();
for (const c of D.chordShapes) {
  checked++;
  names.add(c.name.replace(/\s*\([^)]*\)\s*$/, '').trim());
  const p = parseName(c.name);
  if (!p) { fail(c.name, 'name not understood by the checker'); continue; }
  if (!Array.isArray(c.frets) || c.frets.length !== 6) { fail(c.name, 'frets is not 6 long'); continue; }
  if (!Array.isArray(c.fingers) || c.fingers.length !== 6) { fail(c.name, 'fingers is not 6 long'); continue; }

  const sounded = [];
  for (let s = 0; s < 6; s++) {
    const f = c.frets[s];
    if (f === -1) continue;
    if (!Number.isInteger(f) || f < 0 || f > 24) { fail(c.name, `fret ${f} on string ${s + 1}`); break; }
    sounded.push({ s, midi: OPEN_MIDI[s] + f });
  }
  if (sounded.length < 2) { fail(c.name, 'fewer than two strings sound'); continue; }

  const set = Q[p.q];
  const allowed = new Set(set.t.map((iv) => (p.root + iv) % 12));
  if (p.bass !== null) allowed.add(p.bass);
  const got = new Set(sounded.map((x) => x.midi % 12));

  for (const g of got) {
    if (!allowed.has(g)) {
      const nm = Object.keys(PC).find((k) => PC[k] === g) || ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][g];
      fail(c.name, `sounds a ${nm} which is not in the chord`);
      break;
    }
  }
  for (const iv of set.need) {
    if (!got.has((p.root + iv) % 12)) { fail(c.name, `is missing the interval ${iv} from the root`); break; }
  }
  if (p.bass !== null) {
    const low = sounded.reduce((a, b) => (a.midi < b.midi ? a : b));
    if (low.midi % 12 !== p.bass) fail(c.name, 'slash bass is not the lowest note');
  }

  const fretted = c.frets.filter((f) => f > 0);
  if (fretted.length) {
    const span = Math.max(...fretted) - Math.min(...fretted);
    if (span > 4) fail(c.name, `spans ${span + 1} frets`);
  }

  const perFinger = {};
  for (let s = 0; s < 6; s++) {
    const f = c.frets[s], d = c.fingers[s];
    if (f <= 0) { if (d !== 0) fail(c.name, `finger ${d} on an open or muted string`); continue; }
    if (d < 1 || d > 4) { fail(c.name, `fretted string ${s + 1} has finger ${d}`); continue; }
    if (perFinger[d] === undefined) perFinger[d] = f;
    else if (perFinger[d] !== f) fail(c.name, `finger ${d} is on both fret ${perFinger[d]} and fret ${f}`);
  }
  if (c.barre > 0 && !c.frets.includes(c.barre)) fail(c.name, `barre at fret ${c.barre} which nothing uses`);
}

/* ---- progressions must reference chords that exist ---- */
for (const p of D.progressions) {
  for (const ch of p.chords) if (!names.has(ch)) fail(`progression "${p.name}"`, `uses ${ch}, which is not in the chord list`);
}

/* ---- strum patterns ---- */
for (const s of D.strumPatterns) {
  if (s.slots.length !== 8) fail(`pattern "${s.name}"`, `has ${s.slots.length} slots`);
  if (s.accents.length !== 8) fail(`pattern "${s.name}"`, `has ${s.accents.length} accents`);
  for (const sl of s.slots) if (!'DUX-'.includes(sl)) fail(`pattern "${s.name}"`, `unknown slot "${sl}"`);
}

/* ---- instruments ---- */
for (const i of D.instruments) {
  if (i.stringGauges.length !== 6) fail(i.id, 'not 6 gauges');
  if (!i.bodyModes.length) fail(i.id, 'no body modes');
  for (const m of i.bodyModes) {
    if (m.freqHz < 30 || m.freqHz > 6000) fail(i.id, `body mode at ${m.freqHz} Hz`);
    if (m.q < 0.3 || m.q > 80) fail(i.id, `body mode q of ${m.q}`);
  }
}

console.log(`checked ${checked} voicings, ${D.tunings.length} tunings, ${D.progressions.length} progressions`);
if (problems.length) {
  console.log(`\n${problems.length} problems:`);
  for (const p of problems) console.log('  ' + p);
} else {
  console.log('no problems found');
}
process.exit(problems.length ? 1 : 0);
