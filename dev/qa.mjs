/* Everything the keyboard suite does not reach: pointers, the tape, the
   sequencer, every instrument and tuning and space, knob extremes, resizing,
   and whether any of it produces NaN. node dev/qa.mjs */

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((q) => fs.existsSync(q));

const browser = await chromium.launch({
  headless: true, executablePath: CHROME,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await page.goto('file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/'));
await page.waitForTimeout(700);

let fails = 0;
function check(name, ok, detail) {
  if (!ok) fails++;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${name}${detail ? '   ' + detail : ''}`);
}
const wait = (ms) => page.waitForTimeout(ms);

/* boot */
let box = await page.locator('#neck').boundingBox();
await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);
await wait(600);
check('audio comes up on the first click', await page.evaluate(() => audio.ready));

/* measure what actually reaches the speakers */
await page.evaluate(() => {
  window.__probe = new Float32Array(audio.n.analyser.fftSize);
  window.__worst = { peak: 0, nan: 0 };
  window.__watch = () => {
    audio.n.analyser.getFloatTimeDomainData(window.__probe);
    for (let i = 0; i < window.__probe.length; i++) {
      const v = window.__probe[i];
      if (!Number.isFinite(v)) window.__worst.nan++;
      const a = Math.abs(v);
      if (a > window.__worst.peak) window.__worst.peak = a;
    }
    requestAnimationFrame(window.__watch);
  };
  window.__watch();
});
const worst = () => page.evaluate(() => window.__worst);
const clearWorst = () => page.evaluate(() => { window.__worst = { peak: 0, nan: 0 }; });

/* ---------- 1. pointer: fretting, sliding, strumming ---------- */
{
  await page.evaluate(() => { window.__n = 0; const r = post; window.post = (m) => { if (m.t === 'pluck') window.__n++; return r(m); }; });
  const geo = await page.evaluate(() => ({
    top: L.top, gap: L.gap, nut: L.nutX, neckEnd: L.neckEnd, bridge: L.bridgeX, cy: L.cy,
  }));
  const sy = (s) => box.y + geo.top + s * geo.gap;

  /* a single fret click */
  await page.evaluate(() => { window.__n = 0; });
  await page.mouse.click(box.x + geo.nut + (geo.neckEnd - geo.nut) * 0.2, sy(2));
  await wait(80);
  const one = await page.evaluate(() => window.__n);
  check('clicking a fret plucks exactly one string', one === 1, `${one} plucks`);

  /* a strum drag across all six */
  await page.evaluate(() => { window.__n = 0; });
  const sx = box.x + (geo.neckEnd + geo.bridge) / 2;
  await page.mouse.move(sx, sy(0) - geo.gap * 0.4);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(sx, sy(0) + (geo.gap * 5.4) * (i / 12));
  await page.mouse.up();
  await wait(120);
  const swept = await page.evaluate(() => window.__n);
  check('one drag across the soundhole plays every string', swept >= 6 && swept <= 9, `${swept} plucks`);

  /* sliding along one string should keep it to one string */
  await page.evaluate(() => { window.__n = 0; });
  await page.mouse.move(box.x + geo.nut + 30, sy(3));
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + geo.nut + 30 + i * 40, sy(3));
  await page.mouse.up();
  await wait(80);
  const slid = await page.evaluate(() => ({ n: window.__n, held: state.held.slice() }));
  check('a slide moves the stopped note without jumping strings',
    slid.n >= 3 && slid.held[3] > 1, `${slid.n} plucks, string 4 now at fret ${slid.held[3]}`);

  /* pointer down on the neck, up outside the canvas */
  await page.mouse.move(box.x + geo.nut + 60, sy(1));
  await page.mouse.down();
  await page.mouse.move(box.x + geo.nut + 60, box.y - 60);
  await page.mouse.up();
  await wait(60);
  const stuck = await page.evaluate(() => touches.size);
  check('releasing outside the canvas does not leave a stuck touch', stuck === 0, `${stuck} live touches`);

  /* two fingers at once */
  await page.evaluate(() => { window.__n = 0; });
  await page.evaluate((g) => {
    const cv = document.getElementById('neck');
    const r = cv.getBoundingClientRect();
    const ev = (type, id, x, y) => cv.dispatchEvent(new PointerEvent(type, {
      pointerId: id, clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerType: 'touch',
    }));
    ev('pointerdown', 11, g.nut + 80, g.top + g.gap * 1);
    ev('pointerdown', 12, (g.neckEnd + g.bridge) / 2, g.top - g.gap * 0.3);
    for (let i = 1; i <= 10; i++) ev('pointermove', 12, (g.neckEnd + g.bridge) / 2, g.top + g.gap * 5.3 * (i / 10));
    ev('pointerup', 11, g.nut + 80, g.top + g.gap * 1);
    ev('pointerup', 12, (g.neckEnd + g.bridge) / 2, g.top + g.gap * 5.3);
  }, geo);
  await wait(120);
  const multi = await page.evaluate(() => ({ n: window.__n, live: touches.size }));
  check('two fingers work at once, one fretting and one strumming',
    multi.n >= 6 && multi.live === 0, `${multi.n} plucks, ${multi.live} left over`);
}

/* ---------- 2. every instrument, tuning and space ---------- */
{
  await clearWorst();
  const setupHidden = await page.evaluate(() => getComputedStyle(document.getElementById('fields')).display === 'none');
  if (setupHidden) await page.click('#setupBtn');
  const ids = await page.evaluate(() => INSTS.map((i) => i.id));
  for (const id of ids) {
    await page.selectOption('#instSel', id);
    await page.evaluate(() => { strum(1, 0.9); });
    await wait(90);
  }
  const nT = await page.evaluate(() => TUNINGS.length);
  for (let i = 0; i < nT; i++) {
    await page.selectOption('#tuneSel', String(i));
    await page.evaluate(() => { strum(1, 0.9); });
    await wait(70);
  }
  const spaces = await page.evaluate(() => SPACES.map((s) => s.id));
  for (const sp of spaces) {
    await page.selectOption('#irSel', sp);
    await page.evaluate(() => { strum(1, 0.9); });
    await wait(70);
  }
  await page.selectOption('#instSel', 'steel');
  await page.selectOption('#tuneSel', '0');
  const w = await worst();
  check(`all ${ids.length} guitars, ${nT} tunings and ${spaces.length} spaces stay finite`,
    w.nan === 0 && w.peak < 1.05, `peak ${w.peak.toFixed(3)}, ${w.nan} bad samples`);
}

/* ---------- 3. capo retunes what is already ringing ---------- */
{
  const before = await page.evaluate(async () => {
    let got = null;
    const real = audio.guitar.port.postMessage.bind(audio.guitar.port);
    audio.guitar.port.postMessage = (m) => { if (m.t === 'tuning') got = m.f.slice(); return real(m); };
    setCapo(3);
    audio.guitar.port.postMessage = real;
    return got;
  });
  await page.evaluate(() => setCapo(0));
  const want = 82.407 * Math.pow(2, 3 / 12);
  check('the capo actually retunes the engine',
    before && Math.abs(before[0] - want) < 0.01, before ? `low string went to ${before[0].toFixed(3)} Hz, wanted ${want.toFixed(3)}` : 'no tuning message');
}

/* ---------- 4. knobs at both extremes ---------- */
{
  await clearWorst();
  const keys = await page.evaluate(() => Object.keys(p));
  for (const k of keys) {
    for (const v of [0, 1]) {
      await page.evaluate(([kk, vv]) => { p[kk] = vv; paintKnob(kk); onParam(kk); }, [k, v]);
      await page.evaluate(() => { strum(1, 1); });
      await wait(45);
    }
  }
  /* the nastiest combination: full drive into full level with the echo
     feeding back on itself */
  await page.evaluate(() => {
    p.drive = 1; p.level = 1; p.delay = 1; p.fbk = 1; p.room = 1; p.body = 1; p.symp = 1;
    for (const k of Object.keys(p)) { paintKnob(k); onParam(k); }
  });
  for (let i = 0; i < 8; i++) { await page.evaluate(() => strum(1, 1)); await wait(140); }
  await wait(900);
  const w = await worst();
  check('every knob at both ends, then everything at maximum, stays finite',
    w.nan === 0 && w.peak <= 1.02, `peak ${w.peak.toFixed(3)}, ${w.nan} bad samples`);
  await page.evaluate(() => {
    Object.assign(p, DEFAULTS);
    for (const k of Object.keys(p)) { paintKnob(k); onParam(k); }
    post({ t: 'silence' });
  });
  await wait(300);
}

/* ---------- 5. the tape, including the awkward orders ---------- */
{
  const r = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((q) => setTimeout(q, ms));
    const out = {};
    /* overdub with nothing recorded should be a no-op, not a crash */
    document.getElementById('dubBtn').click();
    out.dubBeforeAnything = !!tape.recording;

    /* record silence */
    recStart(); await sleep(300); recStop(); await sleep(400);
    out.silentTake = tape.buf ? +(tape.buf.length / tape.buf.sampleRate).toFixed(2) : 0;

    /* erase then record for real */
    document.getElementById('clearBtn').click();
    out.erased = !tape.buf;
    recStart();
    for (let i = 0; i < 3; i++) { strum(1, 0.85); await sleep(300); }
    recStop(); await sleep(500);
    out.take = tape.buf ? +(tape.buf.length / tape.buf.sampleRate).toFixed(2) : 0;
    const d = tape.buf.getChannelData(0);
    let pk = 0, nan = 0;
    for (let i = 0; i < d.length; i++) { if (!Number.isFinite(d[i])) nan++; const a = Math.abs(d[i]); if (a > pk) pk = a; }
    out.takePeak = +pk.toFixed(3); out.takeNan = nan;

    /* the wav header has to describe the buffer it came from */
    const blob = encodeWav(tape.buf);
    const buf = await blob.arrayBuffer();
    const v = new DataView(buf);
    const txt = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    out.wav = {
      riff: txt(0), wave: txt(8), fmt: txt(12), data: txt(36),
      riffSize: v.getUint32(4, true), expectRiff: buf.byteLength - 8,
      channels: v.getUint16(22, true),
      rate: v.getUint32(24, true), expectRate: tape.buf.sampleRate,
      byteRate: v.getUint32(28, true), expectByteRate: tape.buf.sampleRate * 4,
      blockAlign: v.getUint16(32, true),
      bits: v.getUint16(34, true),
      dataSize: v.getUint32(40, true), expectData: tape.buf.length * 4,
      totalBytes: buf.byteLength, expectTotal: 44 + tape.buf.length * 4,
    };

    /* play, loop, erase mid playback */
    const len = tape.buf.length;
    playStart(true); await sleep(200);
    out.loopingNow = tape.playing && tape.loop;
    document.getElementById('clearBtn').click(); await sleep(120);
    out.erasedWhilePlaying = !tape.buf && !tape.playing;

    /* overdub: record a base, then layer on top and confirm it grew louder
       without changing length */
    recStart(); for (let i = 0; i < 2; i++) { strum(1, 0.8); await sleep(320); }
    recStop(); await sleep(450);
    const baseLen = tape.buf.length;
    let baseE = 0; { const b = tape.buf.getChannelData(0); for (let i = 0; i < b.length; i++) baseE += b[i] * b[i]; }
    document.getElementById('dubBtn').click();
    for (let i = 0; i < 2; i++) { strum(-1, 0.8); await sleep(300); }
    recStop(); await sleep(500);
    let dubE = 0; { const b = tape.buf.getChannelData(0); for (let i = 0; i < b.length; i++) dubE += b[i] * b[i]; }
    playStop();
    out.overdub = {
      sameLength: tape.buf.length === baseLen,
      louder: dubE > baseE * 1.02,
      baseE: +Math.sqrt(baseE / baseLen).toFixed(4),
      dubE: +Math.sqrt(dubE / tape.buf.length).toFixed(4),
    };
    void len;
    return out;
  });

  check('overdub before anything is recorded does nothing', r.dubBeforeAnything === false);
  check('a take of silence is still a take', r.silentTake > 0.2, `${r.silentTake}s`);
  check('erase clears the tape', r.erased === true);
  check('a real take holds audio', r.take > 0.7 && r.takePeak > 0.02 && r.takeNan === 0,
    `${r.take}s, peak ${r.takePeak}, ${r.takeNan} bad samples`);
  const w = r.wav;
  check('the wav header describes the buffer it came from',
    w.riff === 'RIFF' && w.wave === 'WAVE' && w.fmt === 'fmt ' && w.data === 'data' &&
    w.riffSize === w.expectRiff && w.channels === 2 && w.rate === w.expectRate &&
    w.byteRate === w.expectByteRate && w.blockAlign === 4 && w.bits === 16 &&
    w.dataSize === w.expectData && w.totalBytes === w.expectTotal,
    `${w.rate} Hz, ${w.channels} ch, ${w.bits} bit, data ${w.dataSize} of ${w.expectData}, file ${w.totalBytes} of ${w.expectTotal}`);
  check('loop plays and erase stops it', r.loopingNow === true && r.erasedWhilePlaying === true,
    `looping ${r.loopingNow}, cleared cleanly ${r.erasedWhilePlaying}`);
  check('an overdub layers onto the take without changing its length',
    r.overdub.sameLength && r.overdub.louder,
    `same length ${r.overdub.sameLength}, rms ${r.overdub.baseE} to ${r.overdub.dubE}`);
}

/* ---------- 6. the sequencer under churn ---------- */
{
  const r = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((q) => setTimeout(q, ms));
    document.getElementById('clearBtn').click();
    document.getElementById('strumBtn').click();
    document.getElementById('metroBtn').click();
    await sleep(400);
    const running = seq.timer !== 0;
    /* change everything underneath it */
    document.getElementById('tempoSel').value = '144';
    document.getElementById('tempoSel').dispatchEvent(new Event('change'));
    document.getElementById('patSel').value = '3';
    document.getElementById('patSel').dispatchEvent(new Event('change'));
    setChord(CHORDS.find((c) => c.name === 'Am'));
    await sleep(500);
    document.getElementById('instSel').value = 'electric';
    document.getElementById('instSel').dispatchEvent(new Event('change'));
    await sleep(400);
    const stillRunning = seq.timer !== 0 && seq.on;
    /* metronome off must not kill the pattern */
    document.getElementById('metroBtn').click();
    await sleep(200);
    const afterMetroOff = seq.timer !== 0 && seq.on;
    document.getElementById('strumBtn').click();
    await sleep(150);
    const stopped = seq.timer === 0 && !seq.on;
    document.getElementById('instSel').value = 'steel';
    document.getElementById('instSel').dispatchEvent(new Event('change'));
    post({ t: 'silence' });
    return { running, stillRunning, afterMetroOff, stopped };
  });
  check('the pattern survives tempo, pattern, chord and instrument changes',
    r.running && r.stillRunning, `started ${r.running}, still going ${r.stillRunning}`);
  check('turning the metronome off leaves the pattern running',
    r.afterMetroOff === true);
  check('stopping the pattern clears its timer', r.stopped === true);
  await wait(400);
}

/* ---------- 7. resize, including sizes nobody should use ---------- */
{
  await clearWorst();
  const sizes = [[320, 480], [412, 900], [768, 1024], [2560, 700], [1024, 300], [1440, 860]];
  const bad = [];
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await wait(160);
    await page.evaluate(() => strum(1, 0.8));
    await wait(120);
    const g = await page.evaluate(() => {
      const vals = [L.gap, L.top, L.nutX, L.neckEnd, L.scale, L.bodyHalf, L.holeR, L.cy, L.bridgeX];
      const blank = (() => {
        const c = document.getElementById('neck');
        const gx = c.getContext('2d');
        try {
          const d = gx.getImageData(Math.round(c.width / 2), Math.round(c.height / 2), 1, 1).data;
          return d[0] + d[1] + d[2] < 12;
        } catch (e) { return false; }
      })();
      return { ok: vals.every((v) => Number.isFinite(v) && v > 0), vals, blank, frets: L.frets };
    });
    if (!g.ok || g.blank) bad.push(`${w}x${h} ${g.blank ? 'blank canvas' : 'bad geometry ' + JSON.stringify(g.vals)}`);
  }
  const w2 = await worst();
  check('every viewport from 320x480 to 2560x700 lays out and draws',
    bad.length === 0 && w2.nan === 0, bad.length ? bad.join('; ') : `${sizes.length} sizes, no NaN`);
}

/* ---------- 8. the chord browser ---------- */
{
  await page.setViewportSize({ width: 1440, height: 860 });
  await wait(200);
  const r = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((q) => setTimeout(q, ms));
    openChords();
    const counts = {};
    for (const [id] of FILTERS) {
      chordFilter = id; buildChordGrid();
      counts[id] = document.querySelectorAll('#chordGrid .cbtn').length;
    }
    chordFilter = 'all'; buildChordGrid();
    state.litSlot = 1;
    const before = state.slots[1] ? state.slots[1].name : null;
    document.querySelectorAll('#chordGrid .cbtn')[7].click();
    await sleep(120);
    const after = state.slots[1] ? state.slots[1].name : null;
    document.querySelector('#chordSheet [data-close]').click();
    return { counts, before, after, advanced: state.litSlot === 2 };
  });
  const empty = Object.entries(r.counts).filter(([, n]) => n === 0).map(([k]) => k);
  check('every chord filter shows something', empty.length === 0,
    Object.entries(r.counts).map(([k, n]) => `${k} ${n}`).join(', '));
  check('picking a chord fills the lit slot and moves on',
    r.after && r.after !== r.before && r.advanced, `${r.before} became ${r.after}`);
}

/* ---------- 9. a long run, watching for growth ---------- */
{
  const before = await page.evaluate(() => ({
    q: audio.ctx ? 0 : 0,
    chunks: tape.chunks.length,
    listeners: document.querySelectorAll('.slot').length,
  }));
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((q) => setTimeout(q, ms));
    for (let i = 0; i < 220; i++) {
      if (i % 7 === 0) strum(i % 2 ? -1 : 1, 0.8);
      else pluck(i % 6, (i % 12), 0.7);
      if (i % 40 === 0) await sleep(30);
    }
    await sleep(600);
  });
  const after = await page.evaluate(() => ({
    chunks: tape.chunks.length,
    slots: document.querySelectorAll('.slot').length,
    queued: 0,
  }));
  const w = await worst();
  check('two hundred notes leave nothing growing and nothing broken',
    after.chunks === before.chunks && after.slots === 8 && w.nan === 0,
    `${after.slots} slots, ${after.chunks} stray chunks, peak ${w.peak.toFixed(3)}`);
}

/* ---------- 10. knobs are reachable without a mouse ---------- */
{
  const r = await page.evaluate(() => {
    const k = document.querySelector('.knob');
    k.focus();
    const was = p.tone;
    k.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    const up = p.tone;
    k.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const back = p.tone;
    return {
      focusable: document.activeElement === k,
      moved: up > was && back < up,
      role: k.getAttribute('role'),
      aria: k.getAttribute('aria-valuenow'),
      labelled: !!k.getAttribute('aria-label'),
    };
  });
  check('a knob takes focus and answers the arrow keys',
    r.focusable && r.moved && r.role === 'slider' && r.labelled && r.aria !== null,
    `role ${r.role}, value ${r.aria}`);
}

console.log(errs.length ? `\npage errors:\n  ${errs.join('\n  ')}` : '\nno page errors');
if (errs.length) fails++;
console.log(`\n${fails ? fails + ' failing' : 'everything behaves'}`);
await browser.close();
process.exit(fails ? 1 : 0);
