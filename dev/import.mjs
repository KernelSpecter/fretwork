/* Loads the importer straight out of index.html and checks the part that has
   no single right answer: a MIDI file says which notes and when, never where
   on the neck. Six strings, fifteen frets, one note per string at a time, and
   a hand that reaches about four frets. So what gets checked here is that
   every note it decides on is actually playable, that a string is never asked
   to sound two notes at once, that the fingering it reads back is a hand
   rather than a wish, and that a file it cannot use is refused rather than
   half played.

   The MIDI files are built here rather than committed, so there is nothing
   binary in the repo and the parser is checked against bytes this file is
   explicit about.

   Run: node dev/import.mjs */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const block = html.match(/<script id="importer"[^>]*>([\s\S]*?)<\/script>/);
if (!block) { console.error('no importer block in index.html'); process.exit(1); }
const I = new Function(`${block[1]}\nreturn IMPORTER;`)();
const REF = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'reference.json'), 'utf8'));

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${name}${detail ? '   ' + detail : ''}`);
}

/* ---------- a standard MIDI file, written out byte by byte ---------- */

function vlq(n) {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
}
const be16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n) => [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/* events: { at, dur, pitch, vel, chan }, ticks. tempos: { at, bpm }. */
function midiFile(opts) {
  const o = Object.assign({ division: 480, events: [], tempos: [{ at: 0, bpm: 120 }], timeSig: null, running: false }, opts);
  const flat = [];
  for (const t of o.tempos) flat.push({ at: t.at, order: 0, bytes: [0xff, 0x51, 0x03, (Math.round(60000000 / t.bpm) >> 16) & 0xff, (Math.round(60000000 / t.bpm) >> 8) & 0xff, Math.round(60000000 / t.bpm) & 0xff] });
  if (o.timeSig) flat.push({ at: 0, order: 0, bytes: [0xff, 0x58, 0x04, o.timeSig.num, Math.log2(o.timeSig.den), 24, 8] });
  for (const e of o.events) {
    const chan = e.chan || 0;
    flat.push({ at: e.at, order: 1, bytes: [0x90 | chan, e.pitch, e.vel === undefined ? 90 : e.vel] });
    flat.push({ at: e.at + e.dur, order: 2, bytes: [0x80 | chan, e.pitch, 0] });
  }
  flat.sort((a, b) => a.at - b.at || a.order - b.order);

  const body = [];
  let last = 0;
  let prevStatus = -1;
  for (const e of flat) {
    body.push(...vlq(e.at - last));
    last = e.at;
    /* running status: drop the status byte when it repeats, which real files do
       and a parser that ignores it silently mangles */
    if (o.running && e.bytes[0] === prevStatus && e.bytes[0] < 0xf0) body.push(...e.bytes.slice(1));
    else { body.push(...e.bytes); prevStatus = e.bytes[0] < 0xf0 ? e.bytes[0] : -1; }
  }
  body.push(...vlq(0), 0xff, 0x2f, 0x00);

  const bytes = [
    ...[0x4d, 0x54, 0x68, 0x64], ...be32(6), ...be16(o.format === undefined ? 1 : o.format), ...be16(1), ...be16(o.division),
    ...[0x4d, 0x54, 0x72, 0x6b], ...be32(body.length), ...body,
  ];
  return new Uint8Array(bytes);
}

/* ---------- the parser ---------- */

{
  const file = midiFile({
    division: 480,
    tempos: [{ at: 0, bpm: 120 }],
    events: [
      { at: 0, dur: 480, pitch: 40 },      // E2, the open low string
      { at: 480, dur: 480, pitch: 52 },
      { at: 960, dur: 960, pitch: 64 },    // E4, the open high string
    ],
  });
  const mid = I.parseMidi(file);
  check('a MIDI file parses to its notes', mid.notes.length === 3, `${mid.notes.length} notes, division ${mid.division}`);
  check('note ticks and lengths survive',
    mid.notes[0].tick === 0 && mid.notes[0].dur === 480 && mid.notes[2].tick === 960,
    mid.notes.map((n) => `${n.pitch}@${n.tick}+${n.dur}`).join(' '));

  const at = I.secondsOf(mid);
  check('ticks become seconds at the file’s own tempo', Math.abs(at(480) - 0.5) < 1e-9, `${at(480)}s at a quarter note, 120bpm`);
}

{
  /* running status, which most real files use and a naive parser mangles */
  const plain = I.parseMidi(midiFile({ running: false, events: [{ at: 0, dur: 240, pitch: 45 }, { at: 240, dur: 240, pitch: 47 }, { at: 480, dur: 240, pitch: 49 }] }));
  const run = I.parseMidi(midiFile({ running: true, events: [{ at: 0, dur: 240, pitch: 45 }, { at: 240, dur: 240, pitch: 47 }, { at: 480, dur: 240, pitch: 49 }] }));
  check('running status parses to the same notes as spelling every one out',
    JSON.stringify(plain.notes) === JSON.stringify(run.notes),
    `${plain.notes.length} vs ${run.notes.length}`);
}

{
  /* A note-on at velocity zero is how a great many files end a note, so it must
     not sound. On its own that leaves nothing to play, which is a refusal. */
  let sounded = -1;
  try { sounded = I.parseMidi(midiFile({ events: [{ at: 0, dur: 480, pitch: 55, vel: 0 }] })).notes.length; } catch (e) { sounded = 0; }
  check('a note-on at velocity zero is a note-off, not a note', sounded === 0, `${sounded} notes`);

  /* and one real note alongside it still comes through */
  const mixed = I.parseMidi(midiFile({ events: [{ at: 0, dur: 480, pitch: 55, vel: 0 }, { at: 0, dur: 480, pitch: 57, vel: 80 }] }));
  check('a real note beside it still sounds', mixed.notes.length === 1 && mixed.notes[0].pitch === 57,
    mixed.notes.map((n) => n.pitch).join(' '));
}

{
  /* the drum channel has no pitch worth playing on a guitar */
  const mid = I.parseMidi(midiFile({ events: [{ at: 0, dur: 240, pitch: 38, chan: 9 }, { at: 0, dur: 240, pitch: 52, chan: 0 }] }));
  check('the drum channel is left out', mid.notes.length === 1 && mid.notes[0].pitch === 52, `${mid.notes.length} notes kept`);
}

{
  /* a tempo change halfway must not be flattened */
  const mid = I.parseMidi(midiFile({
    division: 480,
    tempos: [{ at: 0, bpm: 60 }, { at: 960, bpm: 120 }],
    events: [{ at: 0, dur: 240, pitch: 45 }, { at: 960, dur: 240, pitch: 45 }, { at: 1440, dur: 240, pitch: 45 }],
  }));
  const at = I.secondsOf(mid);
  check('a tempo change partway through is honoured',
    Math.abs(at(960) - 2) < 1e-9 && Math.abs(at(1440) - 2.5) < 1e-9,
    `bar two at ${at(960)}s, then ${at(1440)}s`);
}

{
  const bad = [
    ['an empty file', new Uint8Array(0)],
    ['something that is not MIDI', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])],
    ['a MIDI file with no notes in it', midiFile({ events: [] })],
  ];
  let refused = 0;
  for (const [, bytes] of bad) {
    try { I.parseMidi(bytes); } catch (e) { refused++; }
  }
  check('a file it cannot use is refused rather than half played', refused === bad.length, `${refused} of ${bad.length}`);
}

/* ---------- putting notes on the neck ---------- */

{
  const every = [];
  for (let p = 40; p <= 79; p++) every.push(p);
  const unplayable = every.filter((p) => !I.places(p).length);
  check('every pitch the guitar has is reachable somewhere', unplayable.length === 0, unplayable.join(' '));

  for (const p of every) {
    for (const c of I.places(p)) {
      if (I.OPEN[c.s] + c.fret !== p) { check('a place on the neck sounds its own pitch', false, `string ${c.s} fret ${c.fret} is not ${p}`); break; }
    }
  }
  check('a place on the neck sounds its own pitch', true, `${every.length} pitches checked`);
}

{
  /* a tune well below the guitar's range must be moved into it, not dropped */
  const low = [];
  for (let i = 0; i < 24; i++) low.push({ t: i * 0.25, d: 0.24, pitch: 28 + (i % 12), vel: 0.8 });
  const { shift, lost } = I.bestShift(low);
  check('a part below the guitar is shifted into range by octaves',
    shift > 0 && shift % 12 === 0 && lost === 0, `shifted ${shift} semitones, ${lost} still out of range`);
}

{
  /* a six note chord has to go on six different strings */
  const chord = [40, 45, 50, 55, 59, 64].map((p) => ({ t: 0, d: 1, pitch: p, vel: 0.8 }));
  const laid = I.assign(chord, 0, 0.03);
  const strings = new Set(laid.notes.map((n) => n.s));
  check('a six note chord takes six different strings',
    laid.notes.length === 6 && strings.size === 6 && laid.dropped === 0,
    `${laid.notes.length} notes on ${strings.size} strings`);
}

{
  /* a scale run should stay in one place on the neck rather than leaping about */
  const scale = [];
  const steps = [0, 2, 4, 5, 7, 9, 11, 12];
  steps.forEach((k, i) => scale.push({ t: i * 0.25, d: 0.2, pitch: 55 + k, vel: 0.8 }));
  const laid = I.assign(scale, 0, 0.03);
  const frets = laid.notes.filter((n) => n.fret > 0).map((n) => n.fret);
  const span = frets.length ? Math.max(...frets) - Math.min(...frets) : 0;
  check('a scale run keeps the hand in one place',
    laid.notes.length === steps.length && span <= I.HAND_SPAN + 2,
    `${frets.length} fretted notes spanning ${span + 1} frets`);
}

{
  /* the real test of the cost model: a whole piece, and nothing impossible in it */
  const piece = [];
  let t = 0;
  for (let bar = 0; bar < 32; bar++) {
    const root = 45 + [0, 5, 7, 3][bar % 4];
    for (const k of [0, 4, 7, 12, 7, 4]) { piece.push({ t, d: 0.22, pitch: root + k, vel: 0.7 }); t += 0.25; }
    for (const p of [root, root + 7, root + 12]) piece.push({ t, d: 0.9, pitch: p, vel: 0.9 });
    t += 1;
  }
  const laid = I.assign(piece, 0, 0.03);

  let badFret = 0, doubled = 0;
  const lastEnd = [-1, -1, -1, -1, -1, -1];
  for (const n of laid.notes) {
    if (!(n.fret >= 0 && n.fret <= I.MAX_FRET) || I.OPEN[n.s] + n.fret !== n.pitch) badFret++;
  }
  /* two notes on one string at the same moment is the thing that cannot happen */
  const byTime = new Map();
  for (const n of laid.notes) {
    const key = n.t.toFixed(4);
    if (!byTime.has(key)) byTime.set(key, new Set());
    const set = byTime.get(key);
    if (set.has(n.s)) doubled++;
    set.add(n.s);
  }
  void lastEnd;
  check('every note in a whole piece is playable where it was put', badFret === 0, `${badFret} of ${laid.notes.length}`);
  check('no string is asked for two notes at once', doubled === 0, `${doubled} collisions`);
  check('nothing is quietly dropped from a piece in range', laid.dropped === 0, `${laid.dropped} dropped`);
}

/* ---------- the fingering ---------- */

{
  /* The rule is one finger per distinct fret, lowest fret first, which means
     several strings at the same fret are one finger barring them. That is the
     right reading for a handful of notes nobody has named, which is what an
     imported file is. It is not always what a player would choose for a chord
     they know: an open A is three fingers in a row by convention and a barre
     at the second fret by this rule, and both are playable. Where a shape is
     in the reference data, the data's own fingering wins, checked below. */
  const cases = [
    [[-1, 0, 2, 2, 2, 0], 'A, barred at the second fret', 1],
    [[-1, 3, 2, 0, 1, 0], 'C', 3],
    [[0, 2, 2, 1, 0, 0], 'E', 2],
    [[1, 3, 3, 2, 1, 1], 'F barre', 3],
    [[0, 0, 0, 0, 0, 0], 'all open', 0],
  ];
  let wrong = [];
  for (const [frets, name, want] of cases) {
    const f = I.fingersFor(frets);
    const used = new Set(f.filter((x) => x > 0)).size;
    if (used !== want) wrong.push(`${name}: ${used} fingers, expected ${want}`);
    for (let s = 0; s < 6; s++) {
      if (frets[s] <= 0 && f[s] !== 0) wrong.push(`${name}: finger on an open or muted string`);
      if (f[s] > 4) wrong.push(`${name}: finger ${f[s]}`);
    }
  }
  check('a shape gets one finger per fret, and none on an open string', wrong.length === 0, wrong.join('; '));

  const barre = I.fingersFor([1, 3, 3, 2, 1, 1]);
  const ones = barre.filter((x) => x === 1).length;
  check('one finger barres every string at the same fret', ones === 3, `${ones} strings under finger 1`);

  const wide = I.fingersFor([1, 3, 5, 7, 9, 11]);
  check('a shape wider than a hand still names four fingers at most',
    Math.max(...wide) <= 4, wide.join(','));

  /* same fret, same finger, every time */
  let split = 0;
  for (const [frets] of cases) {
    const f = I.fingersFor(frets);
    const byFret = new Map();
    for (let s2 = 0; s2 < 6; s2++) {
      if (frets[s2] <= 0) continue;
      if (byFret.has(frets[s2]) && byFret.get(frets[s2]) !== f[s2]) split++;
      byFret.set(frets[s2], f[s2]);
    }
  }
  check('two strings at the same fret are never given different fingers', split === 0, `${split} splits`);

  /* and the reference data's own fingerings are the ones a named chord uses,
     so the derivation is only ever reached for notes with no name */
  let unusable = [];
  for (const c of REF.chordShapes) {
    for (let s2 = 0; s2 < 6; s2++) {
      if (c.frets[s2] > 0 && (c.fingers[s2] < 1 || c.fingers[s2] > 4)) unusable.push(c.name);
      if (c.frets[s2] <= 0 && c.fingers[s2] !== 0) unusable.push(c.name);
    }
  }
  check('every named shape in the data carries a usable fingering of its own',
    unusable.length === 0, [...new Set(unusable)].join(', '));
}

/* ---------- the whole import, end to end ---------- */

{
  const file = midiFile({
    division: 480,
    timeSig: { num: 4, den: 4 },
    tempos: [{ at: 0, bpm: 96 }],
    events: (() => {
      const out = [];
      for (let bar = 0; bar < 8; bar++) {
        for (let beat = 0; beat < 4; beat++) {
          out.push({ at: (bar * 4 + beat) * 480, dur: 440, pitch: 52 + ((bar + beat) % 8) });
        }
      }
      return out;
    })(),
  });

  const out = I.fromMidi(file, 'a-tune.mid');
  const d = out.data;

  check('a MIDI file imports to a playable song',
    d.kind === 'midi' && d.tempo === 96 && out.events.length === 32 && d.barCount === 8,
    `${out.events.length} notes over ${d.barCount} bars at ${d.tempo} bpm`);
  check('the title comes off the file name', d.title === 'a-tune', d.title);

  let bad = 0, backwards = 0, outsideBar = 0;
  let last = -1;
  for (const e of out.events) {
    if (e.beat < last - 1e-9) backwards++;
    last = e.beat;
    if (e.kind !== 'P') bad++;
    if (!(e.vel > 0 && e.vel <= 1)) bad++;
    if (e.fret < 0 || e.fret > I.MAX_FRET) bad++;
    if (e.string < 0 || e.string > 5) bad++;
    if (e.held[e.string] !== e.fret) bad++;
    if (e.fingers.length !== 6) bad++;
    /* the hand travels with the event, because the player queues ahead */
    if (e.fingers.some((f, s) => (e.held[s] <= 0 ? f !== 0 : f < 1 || f > 4))) bad++;
    if (Math.floor(e.beat / d.beatsPerBar) !== e.bar) outsideBar++;
  }
  check('every imported note carries a playable place and the whole hand with it', bad === 0, `${bad} of ${out.events.length}`);
  check('imported notes are in time order', backwards === 0, `${backwards} out of order`);
  check('every note is filed under the bar it falls in', outsideBar === 0, `${outsideBar} misfiled`);
  check('the chart has a cell for every bar', d.bars.length === d.barCount && d.bars.every((b) => b.chord), `${d.bars.length} bars`);

  /* 3/4 has to come out as 3/4 */
  const waltz = I.fromMidi(midiFile({
    division: 480, timeSig: { num: 3, den: 4 }, tempos: [{ at: 0, bpm: 120 }],
    events: [0, 1, 2, 3, 4, 5].map((i) => ({ at: i * 480, dur: 460, pitch: 50 + i })),
  }), 'waltz.mid');
  check('a time signature other than four four is kept',
    waltz.data.beatsPerBar === 3 && waltz.data.barCount === 2,
    `${waltz.data.beatsPerBar} beats per bar, ${waltz.data.barCount} bars`);
}

/* ---------- a chord sheet ---------- */

{
  const text = [
    '# a comment',
    'title: Something Borrowed',
    'bpm: 104',
    'pattern: Folk down-up',
    '| G | D | Em | C |',
    'Am F C G',
    '| Cmaj7 | % |',
    '| Wobble | Q7 |',
  ].join('\n');

  const out = I.fromChart(text, REF, 'sheet.txt');
  const d = out.data;
  check('a chord sheet reads its header', d.title === 'Something Borrowed' && d.tempo === 104 && d.sections[0].pattern === 'Folk down-up',
    `${d.title}, ${d.tempo} bpm, ${d.sections[0].pattern}`);
  check('a chord sheet reads its bars, bar lines or not',
    d.barCount === 10 && d.bars.map((b) => b.chord).join(' ') === 'G D Em C Am F C G Cmaj7 Cmaj7',
    d.bars.map((b) => b.chord).join(' '));
  check('a percent repeats the bar before it', d.bars[9].chord === 'Cmaj7', d.bars[9].chord);
  check('names it does not know are reported, not guessed',
    d.unknown.length === 2 && d.unknown.includes('Wobble'), d.unknown.join(' '));

  let bad = 0;
  for (const b of d.bars) {
    const shape = REF.chordShapes[b.shape];
    if (!shape || String(shape.frets) !== String(b.frets)) bad++;
    if (b.frets.filter((f) => f >= 0).length < 2) bad++;
    if (!b.pat) bad++;
  }
  check('every bar of a chord sheet gets a real shape and a pattern', bad === 0, `${bad} of ${d.barCount}`);
  check('the last bar of a sheet is left to ring', d.bars[d.barCount - 1].ring === true);

  let refused = 0;
  for (const junk of ['', 'lorem ipsum dolor\nsit amet', 'bpm: 90']) {
    try { I.fromChart(junk, REF, 'x.txt'); } catch (e) { refused++; }
  }
  check('a text file with no chords in it is refused', refused === 3, `${refused} of 3`);
}

console.log(`\n${failures ? failures + ' failed' : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
