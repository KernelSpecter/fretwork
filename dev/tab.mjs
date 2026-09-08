/* Loads the tab reader out of index.html and checks it against MusicXML this
   file writes, so the expected answer is spelled out here rather than trusted.

   The thing being protected: a tab is the only input to this page that is not
   a guess. The listener infers, the arranger invents, the MIDI importer works
   out where on the neck a pitch might go. A tab already knows. So the checks
   that matter most are the ones saying nothing downstream quietly improves on
   it: if the file says string three fret two, that is what gets played, at
   the moment the file says, with the finger the file names.

   Run: node dev/tab.mjs */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const block = (id) => {
  const m = html.match(new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)</script>`));
  if (!m) { console.error(`no ${id} block in index.html`); process.exit(1); }
  return m[1];
};
const T = new Function(`${block('tab')}\nreturn TAB;`)();
const I = new Function(`${block('importer')}\nreturn IMPORTER;`)();

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${name}${detail ? '   ' + detail : ''}`);
}

/* ---------- writing MusicXML, so the answers are known ---------- */

const STEPS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
function pitchXml(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  const alter = ALTER[pc] ? '<alter>1</alter>' : '';
  return `<pitch><step>${STEPS[pc]}</step>${alter}<octave>${oct}</octave></pitch>`;
}

/* n: { midi, div, chord, rest, string, fret, finger, tie } */
function noteXml(n) {
  if (n.rest) return `<note><rest/><duration>${n.div}</duration></note>`;
  const tech = (n.string !== undefined && n.fret !== undefined)
    ? `<notations><technical><string>${n.string}</string><fret>${n.fret}</fret>${n.finger ? `<fingering>${n.finger}</fingering>` : ''}</technical></notations>`
    : '';
  const tie = n.tie ? `<tie type="${n.tie}"/>` : '';
  return `<note>${n.chord ? '<chord/>' : ''}${pitchXml(n.midi)}<duration>${n.div}</duration>${tie}${tech}</note>`;
}

function scoreXml(measures, opts) {
  const o = Object.assign({ divisions: 4, beats: 4, beatType: 4, tempo: 0, title: '', parts: null }, opts || {});
  const attrs = `<attributes><divisions>${o.divisions}</divisions><time><beats>${o.beats}</beats><beat-type>${o.beatType}</beat-type></time></attributes>`;
  const sound = o.tempo ? `<direction><sound tempo="${o.tempo}"/></direction>` : '';
  const body = measures.map((notes, i) =>
    `<measure number="${i + 1}">${i === 0 ? attrs + sound : ''}${notes.map(noteXml).join('')}</measure>`).join('');

  const partList = o.parts
    ? o.parts.map((p, i) => `<score-part id="P${i + 1}"><part-name>${p}</part-name></score-part>`).join('')
    : '<score-part id="P1"><part-name>Guitar</part-name></score-part>';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
${o.title ? `<work><work-title>${o.title}</work-title></work>` : ''}
<part-list>${partList}</part-list>
<part id="P1">${body}</part>
</score-partwise>`;
}

/* ---------- the XML parser ---------- */

{
  const doc = T.parseXml('<a x="1" y=\'two\'><b>hi &amp; bye</b><c/><!-- note --><d><![CDATA[<raw>]]></d></a>');
  const a = doc.kids[0];
  check('attributes read, in either kind of quote', a.attrs.x === '1' && a.attrs.y === 'two', JSON.stringify(a.attrs));
  check('entities are decoded', T.txt(a, 'b') === 'hi & bye', T.txt(a, 'b'));
  check('a self-closing tag is an empty element', !!T.kid(a, 'c') && T.kid(a, 'c').kids.length === 0);
  check('comments are skipped', a.kids.filter((k) => k.name === 'c' || k.name === 'b' || k.name === 'd').length === 3,
    a.kids.map((k) => k.name).join(','));
  check('CDATA is taken literally', T.txt(a, 'd') === '<raw>', T.txt(a, 'd'));

  const withDoctype = T.parseXml('<!DOCTYPE x [ <!ENTITY q "z"> ]><r><v>1</v></r>');
  check('a DOCTYPE with an internal subset does not eat the document',
    !!T.kid(withDoctype, 'r') && T.txt(T.kid(withDoctype, 'r'), 'v') === '1');

  const deepDoc = T.parseXml('<a><b><c><d>found</d></c></b></a>');
  check('a descendant is found at any depth', T.deep(deepDoc, 'd').text === 'found');
}

/* ---------- pitch ---------- */

{
  const cases = [[60, 'C4'], [61, 'C#4'], [69, 'A4'], [40, 'E2'], [64, 'E4'], [79, 'G5']];
  const wrong = [];
  for (const [midi] of cases) {
    const got = T.midiOf(T.parseXml(pitchXml(midi)).kids[0]);
    if (got !== midi) wrong.push(`${midi} came back as ${got}`);
  }
  check('a pitch reads back as the note it was', wrong.length === 0, wrong.join('; '));
}

/* ---------- the string numbering, which runs the other way ---------- */

{
  /* MusicXML counts strings from the highest sounding one. This page counts
     from the lowest. Getting this backwards plays a tune upside down and
     nothing else in the pipeline would notice. */
  const xml = scoreXml([[{ midi: 40, div: 16, string: 6, fret: 0 }]], {});
  const tab = T.fromMusicXml(xml);
  check('string 6 in the file is the low E here', tab.notes[0].s === 0, `s=${tab.notes[0].s}`);

  const high = T.fromMusicXml(scoreXml([[{ midi: 64, div: 16, string: 1, fret: 0 }]], {}));
  check('string 1 in the file is the high E here', high.notes[0].s === 5, `s=${high.notes[0].s}`);
}

/* ---------- timing ---------- */

{
  /* four quarter notes: one per beat, in order, each a quarter long */
  const xml = scoreXml([[
    { midi: 60, div: 4 }, { midi: 62, div: 4 }, { midi: 64, div: 4 }, { midi: 65, div: 4 },
  ]], { divisions: 4 });
  const tab = T.fromMusicXml(xml);
  check('notes land one per beat', String(tab.notes.map((n) => n.startQ)) === String([0, 1, 2, 3]),
    tab.notes.map((n) => n.startQ).join(','));
  check('and each is as long as it says', tab.notes.every((n) => n.q === 1), tab.notes.map((n) => n.q).join(','));
}

{
  /* a chord: three notes, one moment */
  const xml = scoreXml([[
    { midi: 60, div: 16 }, { midi: 64, div: 16, chord: true }, { midi: 67, div: 16, chord: true },
    { midi: 65, div: 16 },
  ]], { divisions: 16, beats: 2 });
  const tab = T.fromMusicXml(xml);
  const at0 = tab.notes.filter((n) => n.startQ === 0).length;
  check('a chord sounds all at once, and does not advance the clock three times',
    at0 === 3 && tab.notes.length === 4 && tab.notes[3].startQ === 1,
    tab.notes.map((n) => `${n.pitch}@${n.startQ}`).join(' '));
}

{
  /* a rest takes up its time without sounding */
  const xml = scoreXml([[
    { midi: 60, div: 4 }, { rest: true, div: 4 }, { midi: 64, div: 4 },
  ]], { divisions: 4 });
  const tab = T.fromMusicXml(xml);
  check('a rest moves the clock on without making a note',
    tab.notes.length === 2 && tab.notes[1].startQ === 2,
    tab.notes.map((n) => `${n.pitch}@${n.startQ}`).join(' '));
}

{
  /* a tie is one note held, not two struck */
  const xml = scoreXml([
    [{ midi: 60, div: 16, tie: 'start' }],
    [{ midi: 60, div: 16, tie: 'stop' }],
  ], { divisions: 16, beats: 4 });
  const tab = T.fromMusicXml(xml);
  check('a tie is one long note rather than two',
    tab.notes.length === 1 && Math.abs(tab.notes[0].q - 2) < 1e-9,
    `${tab.notes.length} notes, first is ${tab.notes[0] && tab.notes[0].q} quarters`);
}

{
  /* two voices in one measure, which is what backup is for */
  const xml = `<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>G</part-name></score-part></part-list>
<part id="P1"><measure number="1">
<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
<note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration></note>
<backup><duration>16</duration></backup>
<note><pitch><step>G</step><octave>3</octave></pitch><duration>8</duration></note>
<note><pitch><step>A</step><octave>3</octave></pitch><duration>8</duration></note>
</measure></part></score-partwise>`;
  const tab = T.fromMusicXml(xml);
  const at = tab.notes.map((n) => n.startQ).sort((a, b) => a - b);
  check('backup puts a second voice under the first',
    tab.notes.length === 3 && at[0] === 0 && at[1] === 0 && at[2] === 2,
    tab.notes.map((n) => `${n.pitch}@${n.startQ}`).join(' '));
}

{
  const tab = T.fromMusicXml(scoreXml([[{ midi: 60, div: 4 }]], { tempo: 132, title: 'A Study' }));
  check('the tempo and title come out of the file', tab.bpm === 132 && tab.title === 'A Study',
    `${tab.bpm} bpm, "${tab.title}"`);

  const three = T.fromMusicXml(scoreXml([[{ midi: 60, div: 4 }]], { beats: 3, beatType: 4 }));
  check('a time signature other than four four is kept', three.beatsPerBar === 3, String(three.beatsPerBar));
  const six = T.fromMusicXml(scoreXml([[{ midi: 60, div: 4 }]], { beats: 6, beatType: 8 }));
  check('and one counted in eighths is converted to quarters', six.beatsPerBar === 3, String(six.beatsPerBar));
}

/* ---------- which part ---------- */

{
  /* a tab file often has more than one part; the one with frets is the guitar */
  const xml = `<?xml version="1.0"?><score-partwise>
<part-list>
<score-part id="P1"><part-name>Voice</part-name></score-part>
<score-part id="P2"><part-name>Guitar</part-name></score-part>
</part-list>
<part id="P1"><measure number="1"><attributes><divisions>4</divisions></attributes>
<note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration></note></measure></part>
<part id="P2"><measure number="1"><attributes><divisions>4</divisions></attributes>
<note><pitch><step>E</step><octave>2</octave></pitch><duration>16</duration>
<notations><technical><string>6</string><fret>0</fret></technical></notations></note></measure></part>
</score-partwise>`;
  const tab = T.fromMusicXml(xml);
  check('the part with strings and frets in it is the one played',
    tab.notes.length === 1 && tab.notes[0].s === 0 && tab.parts.length === 2,
    `played "${tab.part}" of ${tab.parts.join(', ')}`);
}

/* ---------- refusals ---------- */

{
  const bad = [
    ['not xml at all', 'hello there'],
    ['xml that is not a score', '<html><body>no</body></html>'],
    ['a score with no notes', scoreXml([[{ rest: true, div: 16 }]], {})],
  ];
  let refused = 0;
  for (const [, src] of bad) {
    try { T.fromMusicXml(src); } catch (e) { refused++; }
  }
  check('a file it cannot use is refused rather than half played', refused === bad.length, `${refused} of ${bad.length}`);
}

/* ---------- the promise: nothing downstream second-guesses a tab ---------- */

{
  /* A little fingerstyle shape: a bass note with two above it at the same
     moment, then a run up one string. Every note is written by naming the
     string and the fret and deriving the pitch from those, so the two cannot
     contradict each other. Writing a pitch by hand next to a string and a
     fret is how the first version of this test came to claim the open second
     string sounds an E when it sounds a B: the code was right and the test
     was wrong. Real files carry that same contradiction, which is why
     fromTab now counts it. */
  const OPEN_MIDI = [40, 45, 50, 55, 59, 64];
  const on = (string, fret, div, extra) => Object.assign({
    midi: OPEN_MIDI[6 - string] + fret, div: div, string: string, fret: fret,
  }, extra || {});

  const measures = [
    [
      on(5, 0, 8),                       // the open A string
      on(2, 0, 8, { chord: true }),      // and two over it, struck together
      on(3, 5, 8, { chord: true }),
      on(5, 2, 8),
    ],
    [
      on(4, 0, 4, { finger: 1 }),
      on(4, 2, 4, { finger: 2 }),
      on(4, 4, 4, { finger: 3 }),
      on(4, 5, 4, { finger: 4 }),
    ],
  ];
  const xml = scoreXml(measures, { divisions: 4, tempo: 100, title: 'Exactly This' });
  const tab = T.fromMusicXml(xml);
  const out = I.fromTab(tab, 'exactly.musicxml');

  check('a tab imports to a playable song',
    out.data.kind === 'tab' && out.data.tempo === 100 && out.data.title === 'Exactly This',
    `${out.data.notes} notes over ${out.data.barCount} bars at ${out.data.tempo} bpm`);

  /* Every note played where the file put it, at the moment the file put it.
     Compared as a set per moment rather than by position: notes struck
     together come out ordered by pitch, which is the order a hand meets them
     and not the order they sit in the file. */
  const flat = measures.flat().filter((n) => !n.rest);
  const beatOfNote = [0, 0, 0, 2, 4, 5, 6, 7];
  const wantAt = new Map();
  flat.forEach((n, i) => {
    const key = beatOfNote[i];
    if (!wantAt.has(key)) wantAt.set(key, new Set());
    wantAt.get(key).add(`${6 - n.string}/${n.fret}`);
  });
  const gotAt = new Map();
  for (const e of out.events) {
    const key = +e.beat.toFixed(3);
    if (!gotAt.has(key)) gotAt.set(key, new Set());
    gotAt.get(key).add(`${e.string}/${e.fret}`);
  }
  const examples = [];
  for (const [beat, want] of wantAt) {
    const got = gotAt.get(beat) || new Set();
    for (const w of want) if (!got.has(w)) examples.push(`beat ${beat}: file says ${w}, not played`);
    for (const g of got) if (!want.has(g)) examples.push(`beat ${beat}: played ${g}, not in the file`);
  }
  check('every note is played on the string and fret the file names',
    examples.length === 0, examples.slice(0, 3).join('; ') || `${out.events.length} notes`);
  check('and a file that agrees with its own tab reports no argument',
    out.data.mismatched === 0, `${out.data.mismatched} disagreed`);

  /* the chord in bar one is one moment, and bar two is one note per beat */
  const beats = out.events.map((e) => +e.beat.toFixed(3));
  check('the timing is the file’s timing',
    String(beats) === String([0, 0, 0, 2, 4, 5, 6, 7]), beats.join(','));
  check('and the bars are the file’s bars',
    String(out.events.map((e) => e.bar)) === String([0, 0, 0, 0, 1, 1, 1, 1]),
    out.events.map((e) => e.bar).join(','));

  /* the file's own fingering is kept rather than derived */
  const second = out.events.slice(4);
  check('a finger named in the file is the finger shown',
    second.every((e, i) => e.fingers[e.string] === [1, 2, 3, 4][i] || e.fret === 0),
    second.map((e) => `${e.fret}:${e.fingers[e.string]}`).join(' '));

  /* nothing octave-shifted: a tab is already on the neck */
  check('a tab is never moved by an octave to make it fit', out.data.dropped === 0);
  const pitchesBack = out.events.map((e) => I.OPEN[e.string] + e.fret).sort((a, b) => a - b);
  const pitchesWanted = flat.map((n) => n.midi).sort((a, b) => a - b);
  check('and every note still sounds its own pitch',
    String(pitchesBack) === String(pitchesWanted),
    `${pitchesBack.join(',')} against ${pitchesWanted.join(',')}`);
}

{
  /* A file that argues with itself: the tab says one place, the written pitch
     says another. The tab is what a guitarist plays, so the tab wins, and the
     argument is reported rather than hidden. */
  const xml = scoreXml([[{ midi: 64, div: 16, string: 2, fret: 0 }]], { divisions: 16, beats: 1 });
  const out = I.fromTab(T.fromMusicXml(xml), 'argues.musicxml');
  check('where a file disagrees with its own tab, the tab is played',
    out.events[0].string === 4 && out.events[0].fret === 0,
    `played string ${out.events[0].string} fret ${out.events[0].fret}`);
  check('and the disagreement is counted, not hidden',
    out.data.mismatched === 1, String(out.data.mismatched));
}

{
  /* a tab with no string or fret in it is still playable: the importer works
     out positions the way it does for a MIDI file */
  const xml = scoreXml([[
    { midi: 64, div: 4 }, { midi: 66, div: 4 }, { midi: 68, div: 4 }, { midi: 69, div: 4 },
  ]], { divisions: 4, tempo: 96 });
  const out = I.fromTab(T.fromMusicXml(xml), 'plain.musicxml');
  check('a score with no tab staff is still laid out and played',
    out.events.length === 4 && out.events.every((e) => e.fret >= 0 && e.string >= 0),
    out.events.map((e) => `${e.string}/${e.fret}`).join(' '));
  check('and its notes sound the pitches the score asked for',
    String(out.events.map((e) => I.OPEN[e.string] + e.fret)) === String([64, 66, 68, 69]),
    out.events.map((e) => I.OPEN[e.string] + e.fret).join(','));
}

console.log(`\n${failures ? failures + ' failed' : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
