/* Loads the arranger straight out of index.html and checks the things that go
   wrong quietly in a generative arrangement: a song that wanders out of key, a
   chord with no shape to play it with, a section that stops in the middle of a
   phrase, a barre nobody can see on a 12 fret neck, and events whose chord does
   not match the bar they land in.

   That last one is the seam. The player runs a seventh of a second ahead of the
   speakers, so an event that looked up the held chord when it fired would strum
   the previous one across every bar line. compile() is the only thing that
   knows which frets belong to which beat, so this is where that gets checked.

   Run: node dev/song.mjs            (add --show to print a derived song) */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const m = html.match(/<script id="arranger"[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.error('no arranger block in index.html'); process.exit(1); }

const A = new Function(`${m[1]}\nreturn ARRANGER;`)();
const REF = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'reference.json'), 'utf8'));

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${name}${detail ? '   ' + detail : ''}`);
}

/* A spread of seeds rather than one: everything below is a property of the
   arranger, not of a lucky number. Fixed list so a failure is reproducible. */
const SEEDS = [];
for (let i = 0; i < 240; i++) SEEDS.push(i * 7919 + 3);

const BPB = A.BEATS_PER_BAR;
const idx = A.shapeIndex(REF);

/* ---------- the data the arranger leans on ---------- */

{
  const missing = REF.progressions.filter((p) => !A.keyOf(p)).map((p) => p.name);
  check('every progression names its key', missing.length === 0, missing.join(', '));
}

{
  const fam = {};
  for (const p of REF.progressions) {
    const k = A.keyOf(p);
    if (k) (fam[k] = fam[k] || []).push(p.name);
  }
  const thin = Object.entries(fam).filter(([, v]) => v.length < 2).map(([k]) => k);
  check('every key has a second progression to build a chorus from',
        thin.length === 0, thin.length ? 'only one in ' + thin.join(', ') : Object.keys(fam).join(' '));

  const noTonic = Object.keys(fam).filter((k) => !A.voice(idx, k, false));
  check('every key has a shape for its own tonic chord', noTonic.length === 0, noTonic.join(', '));
}

{
  const bad = [];
  for (const p of REF.progressions) {
    for (const n of p.chords) {
      const v = A.voice(idx, n, false);
      if (!v) bad.push(`${n} (${p.name}) has no shape`);
      else if (Math.max(...v.frets) > A.MAX_FRET) bad.push(`${n} voiced at fret ${Math.max(...v.frets)}`);
    }
  }
  check(`every progression chord is playable below fret ${A.MAX_FRET}`, bad.length === 0, bad.slice(0, 3).join('; '));
}

{
  /* check-data.mjs verifies the chord cross references but not this one. */
  const names = new Set(REF.strumPatterns.map((p) => p.name));
  const bad = REF.progressions.filter((p) => !names.has(p.suggestedPattern)).map((p) => `${p.name} -> ${p.suggestedPattern}`);
  check('every suggested pattern exists', bad.length === 0, bad.join('; '));
}

{
  /* The picked/strummed split is read off the accent numbers rather than the
     pattern's name, so this pins down what that rule currently selects. If a
     pattern is renamed the rule still holds; if its accents are rewritten,
     this is the line that says so. */
  const picked = REF.strumPatterns.filter(A.isPicked).map((p) => p.name);
  const expected = REF.strumPatterns.filter((p) => /Fingerstyle/.test(p.name)).map((p) => p.name);
  check('peak accent under 0.8 picks out exactly the fingerstyle patterns',
        picked.length === expected.length && picked.every((n) => expected.includes(n)),
        `picked: ${picked.join(', ')}`);
}

/* ---------- a song comes back the same, and songs differ ---------- */

{
  const a = JSON.stringify(A.derive(REF, 20260907));
  const b = JSON.stringify(A.derive(REF, 20260907));
  check('the same seed derives the same song', a === b, a === b ? '' : 'two runs disagreed');

  const keys = new Set(), forms = new Set(), tempos = new Set(), titles = new Set();
  for (const s of SEEDS) {
    const song = A.derive(REF, s);
    keys.add(song.key); forms.add(song.form); tempos.add(song.tempo); titles.add(JSON.stringify(song.bars.map((x) => x.chord)));
  }
  check('seeds reach every key in the data', keys.size >= 6, [...keys].join(' '));
  check('seeds reach every form', forms.size === A.FORMS.length, [...forms].join(' / '));
  check('tempo is not fixed', tempos.size >= 5, [...tempos].sort((x, y) => x - y).join(' '));
  check('different seeds give different chord sequences', titles.size >= 20, `${titles.size} distinct over ${SEEDS.length} seeds`);
}

/* ---------- every derived song holds together ---------- */

{
  const problems = [];
  const note = (seed, what) => { if (problems.length < 6) problems.push(`seed ${seed}: ${what}`); };

  for (const seed of SEEDS) {
    const song = A.derive(REF, seed);
    if (!song) { note(seed, 'derived nothing'); continue; }

    if (!song.bars.length) note(seed, 'no bars');
    if (song.barCount !== song.bars.length) note(seed, 'barCount disagrees with bars');
    if (song.barCount < 16 || song.barCount > 96) note(seed, `${song.barCount} bars`);

    const secs = song.sections.map((s) => s.name);
    if (secs[0] !== 'Intro') note(seed, 'does not start with an intro');
    if (secs[secs.length - 1] !== 'Outro') note(seed, 'does not end with an outro');

    /* the sections must tile the bars exactly, in order, with no gap or overlap */
    let expect = 0;
    for (const s of song.sections) {
      if (s.from !== expect) note(seed, `section ${s.name} starts at ${s.from}, expected ${expect}`);
      expect += s.bars;
      for (let b = s.from; b < s.from + s.bars; b++) {
        if (!song.bars[b] || song.bars[b].sectionName !== s.name) note(seed, `bar ${b} is not in ${s.name}`);
      }
    }
    if (expect !== song.bars.length) note(seed, `sections cover ${expect} of ${song.bars.length} bars`);

    for (let b = 0; b < song.bars.length; b++) {
      const bar = song.bars[b];
      if (bar.shape < 0) note(seed, `bar ${b} (${bar.chord}) has no shape`);
      const sounding = bar.frets.filter((f) => f >= 0);
      if (sounding.length < 2) note(seed, `bar ${b} sounds ${sounding.length} strings`);
      if (Math.max(...bar.frets) > A.MAX_FRET) note(seed, `bar ${b} reaches fret ${Math.max(...bar.frets)}`);
      const shape = REF.chordShapes[bar.shape];
      if (!shape) note(seed, `bar ${b} shape index ${bar.shape} is out of range`);
      else if (String(shape.frets) !== String(bar.frets)) note(seed, `bar ${b} frets are not the shape's own`);
      if (bar.dyn <= 0 || bar.dyn > 1) note(seed, `bar ${b} dynamic ${bar.dyn}`);
    }

    /* only the very last bar rings out, and nothing turns around into nothing */
    const ringing = song.bars.filter((b) => b.ring).length;
    if (ringing !== 1) note(seed, `${ringing} bars marked as the ending`);
    if (!song.bars[song.bars.length - 1].ring) note(seed, 'the last bar is not the ending');
    if (song.bars[song.bars.length - 1].fill) note(seed, 'the last bar turns around into nothing');

    const dur = (song.barCount * BPB * 60) / song.tempo;
    if (dur < 40 || dur > 330) note(seed, `runs ${dur.toFixed(0)}s`);
  }
  check(`all ${SEEDS.length} derived songs hold together`, problems.length === 0, problems.join('\n      '));
}

/* ---------- whole-cycle sections ---------- */

{
  const problems = [];
  for (const seed of SEEDS) {
    const song = A.derive(REF, seed);
    for (const s of song.sections) {
      if (s.name === 'Intro' || s.name === 'Outro') continue;
      const prog = REF.progressions.find((p) => p.name === s.source);
      const cycle = prog ? A.cycleBars(prog) : null;
      /* a rotated progression is not in the data by name; its cycle is the
         base one, and the section is still built by fitted() */
      if (cycle && s.bars % cycle !== 0 && problems.length < 5) {
        problems.push(`seed ${seed}: ${s.name} is ${s.bars} bars on a ${cycle} bar cycle`);
      }
    }
  }
  check('every verse, chorus and bridge is a whole number of cycles', problems.length === 0, problems.join('\n      '));
}

/* ---------- the seam: compiled events against the chart ---------- */

{
  const problems = [];
  const note = (seed, what) => { if (problems.length < 8) problems.push(`seed ${seed}: ${what}`); };

  for (const seed of SEEDS) {
    const song = A.derive(REF, seed);
    const { events, endBeat } = A.compile(song);

    if (!events.length) { note(seed, 'compiled to nothing'); continue; }
    if (endBeat !== song.barCount * BPB + A.RING_BEATS) note(seed, 'endBeat is wrong');

    let lastBeat = -1, lastBar = -1;
    for (const e of events) {
      if (e.beat < lastBeat - 1e-9) note(seed, `beat went backwards at bar ${e.bar}`);
      lastBeat = e.beat;

      if (e.bar < lastBar) note(seed, `bar went backwards to ${e.bar}`);
      lastBar = e.bar;

      const bar = song.bars[e.bar];
      if (!bar) { note(seed, `event in bar ${e.bar}, which does not exist`); continue; }

      /* the seam. The chord an event strums has to be the chord the chart
         says is in that bar, because the player will not look it up again. */
      if (String(e.frets) !== String(bar.frets)) note(seed, `bar ${e.bar} event carries the wrong frets`);
      if (e.chord !== bar.chord) note(seed, `bar ${e.bar} event says ${e.chord}, chart says ${bar.chord}`);

      /* and it has to land inside that bar */
      const lo = e.bar * BPB, hi = lo + BPB;
      if (e.beat < lo - 1e-9 || e.beat >= hi + 1e-9) note(seed, `bar ${e.bar} event at beat ${e.beat} is outside ${lo}..${hi}`);

      if (!(e.vel > 0 && e.vel <= 1)) note(seed, `velocity ${e.vel} in bar ${e.bar}`);
      if (!'DUXP'.includes(e.kind)) note(seed, `unknown event kind ${e.kind}`);

      if (e.kind === 'P') {
        if (bar.frets[e.string] < 0) note(seed, `bar ${e.bar} picks muted string ${e.string}`);
        if (e.fret !== bar.frets[e.string]) note(seed, `bar ${e.bar} picks string ${e.string} at the wrong fret`);
      }
    }

    /* a picked bar is picked all the way through, a strummed one is not picked
       at all: a pattern does not change hands halfway down the bar */
    for (let b = 0; b < song.bars.length; b++) {
      const bar = song.bars[b];
      if (bar.ring) continue;
      const mine = events.filter((e) => e.bar === b);
      if (!mine.length) { note(seed, `bar ${b} is silent`); continue; }
      const picks = mine.filter((e) => e.kind === 'P').length;
      const strums = mine.filter((e) => e.kind === 'D' || e.kind === 'U').length;
      if (A.isPicked(bar.pat)) {
        if (strums > 0) note(seed, `picked bar ${b} has ${strums} full strums in it`);
      } else if (picks > 0) {
        note(seed, `strummed bar ${b} has ${picks} single notes in it`);
      }
    }

    /* the ending is one chord and then silence */
    const lastIdx = song.barCount - 1;
    const tail = events.filter((e) => e.bar === lastIdx);
    if (tail.length !== 1) note(seed, `the last bar has ${tail.length} events`);
    if (tail.length && tail[0].kind !== 'D') note(seed, 'the last chord is not struck downward');

    /* a turnaround adds strokes, it does not take them away */
    for (const s of song.sections) {
      const last = s.from + s.bars - 1;
      const bar = song.bars[last];
      if (!bar || !bar.fill) continue;
      const got = events.filter((e) => e.bar === last).length;
      const plain = A.density(bar.pat);
      if (got < plain) note(seed, `the turnaround in bar ${last} has fewer strokes than the pattern`);
    }
  }
  check(`compiled events match the chart across ${SEEDS.length} songs`, problems.length === 0, problems.join('\n      '));
}

/* ---------- the arrangement actually does something ---------- */

{
  const problems = [];
  let sawPicking = 0, sawChuck = 0, sawBarre = 0, sawSwing = 0;

  for (const seed of SEEDS) {
    const song = A.derive(REF, seed);
    const { events } = A.compile(song);

    const verse = song.sections.find((s) => s.name === 'Verse');
    const chorus = song.sections.find((s) => s.name === 'Chorus');
    if (verse && chorus && chorus.dyn <= verse.dyn && problems.length < 4) {
      problems.push(`seed ${seed}: the chorus (${chorus.dyn.toFixed(2)}) is no louder than the verse (${verse.dyn.toFixed(2)})`);
    }

    /* the whole song is in one key, so every chord in it has to be a chord one
       of that key's own progressions uses */
    const allowed = new Set();
    for (const p of REF.progressions) if (A.keyOf(p) === song.key) for (const c of p.chords) allowed.add(c);
    if (song.tonic) allowed.add(song.tonic);
    const strays = [...new Set(song.bars.map((b) => b.chord))].filter((c) => !allowed.has(c));
    if (strays.length && problems.length < 4) problems.push(`seed ${seed}: ${song.key} song plays ${strays.join(', ')}`);

    if (events.some((e) => e.kind === 'P')) sawPicking++;
    if (events.some((e) => e.kind === 'X')) sawChuck++;
    if (song.bars.some((b) => REF.chordShapes[b.shape] && !REF.chordShapes[b.shape].openPosition)) sawBarre++;
    if (song.feel === 'swung') sawSwing++;
  }

  check('no song leaves its key', problems.length === 0, problems.join('\n      '));
  check('some songs are picked rather than strummed', sawPicking > 0, `${sawPicking}/${SEEDS.length}`);
  check('some songs use the muted chuck', sawChuck > 0, `${sawChuck}/${SEEDS.length}`);
  check('some songs go up the neck for a chorus', sawBarre > 0, `${sawBarre}/${SEEDS.length}`);
  check('some songs swing', sawSwing > 0, `${sawSwing}/${SEEDS.length}`);
}

/* ---------- swing lands where it should ---------- */

{
  const swung = A.derive(REF, SEEDS.find((s) => A.derive(REF, s).feel === 'swung') ?? SEEDS[0]);
  const { events } = A.compile(swung);
  const off = events.filter((e) => Math.abs((e.beat % 1) - 0.5 - A.SWING) < 1e-9).length;
  const on = events.filter((e) => Math.abs(e.beat % 1) < 1e-9).length;
  if (swung.feel === 'swung') {
    check('a swung song delays its off beats and not its down beats', off > 0 && on > 0, `${on} on the beat, ${off} pushed late`);
  } else {
    check('a swung song delays its off beats and not its down beats', false, 'no swung song in the seed list');
  }
}

if (process.argv.includes('--show')) {
  const seed = Number(process.argv[process.argv.indexOf('--show') + 1]) || 20260907;
  const song = A.derive(REF, seed);
  const { events } = A.compile(song);
  console.log(`\n${song.title} · ${song.tempo} bpm · ${song.feel} · ${song.barCount} bars · from "${song.source}"`);
  for (const s of song.sections) {
    console.log(`  ${(s.name + ' ' + s.pass).padEnd(9)} ${String(s.bars).padStart(2)} bars  ${s.chords.join(' ')}`);
    console.log(`  ${''.padEnd(9)} ${s.pattern}${s.picked ? ' (picked)' : ''} at ${s.dyn.toFixed(2)}`);
  }
  console.log(`  ${events.length} events over ${((song.barCount * BPB * 60) / song.tempo).toFixed(0)}s`);
}

console.log(`\n${failures ? failures + ' failed' : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
