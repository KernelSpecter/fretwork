/* Everything the keyboard suite does not reach: pointers, the tape, the
   sequencer, every instrument and tuning and space, knob extremes, resizing,
   and whether any of it produces NaN. node dev/qa.mjs */

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
/* use a Chrome that is already installed when there is one, so a clone
   does not have to download a second copy just to run the tests */
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
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

/* ---------- 5b. the capo, measured from the audio it produces ----------
   Not "did a message go out" but "does the string that comes back out of
   the tape actually sound two semitones higher". */
{
  const r = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((q) => setTimeout(q, ms));
    /* period by autocorrelation over a steady stretch of the take */
    const pitch = (d, rate, expect) => {
      const P = rate / expect;
      const s0 = Math.round(rate * 0.12);
      const win = Math.min(8192, Math.round(P * 8));
      if (s0 + win + Math.ceil(P * 1.5) >= d.length) return null;
      const corr = (l) => {
        let n = 0, a = 0, b = 0;
        for (let i = 0; i < win; i++) { const x = d[s0 + i], y = d[s0 + i + l]; n += x * y; a += x * x; b += y * y; }
        const q = Math.sqrt(a * b);
        return q < 1e-20 ? 0 : n / q;
      };
      let best = -1, bv = -2;
      for (let l = Math.floor(P * 0.6); l <= Math.ceil(P * 1.5); l++) { const v = corr(l); if (v > bv) { bv = v; best = l; } }
      if (bv < 0.3) return null;
      const y0 = corr(best - 1), y2 = corr(best + 1);
      const den = y0 - 2 * bv + y2;
      const f = Math.abs(den) < 1e-12 ? 0 : 0.5 * (y0 - y2) / den;
      return rate / (best + Math.max(-1, Math.min(1, f)));
    };

    const out = [];
    for (const capo of [0, 2, 5]) {
      document.getElementById('clearBtn').click();
      post({ t: 'silence' });
      await sleep(120);
      setCapo(capo);
      await sleep(120);
      recStart();
      await sleep(40);
      pluck(0, 0, 0.95);            // open low E, whatever the capo says that is
      await sleep(1400);
      recStop();
      await sleep(450);
      const want = 82.407 * Math.pow(2, capo / 12);
      const got = tape.buf ? pitch(tape.buf.getChannelData(0), tape.buf.sampleRate, want) : null;
      out.push({ capo, want: +want.toFixed(2), got: got ? +got.toFixed(2) : null,
                 cents: got ? +(1200 * Math.log2(got / want)).toFixed(1) : null });
    }
    setCapo(0);
    document.getElementById('clearBtn').click();
    return out;
  });
  const ok = r.every((x) => x.got !== null && Math.abs(x.cents) < 15);
  check('the capo moves the pitch you actually hear',
    ok, r.map((x) => `capo ${x.capo}: ${x.got} Hz against ${x.want} (${x.cents} cents)`).join(', '));
}

/* ---------- 5c. what gets recorded matches what you heard ---------- */
{
  const r = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((q) => setTimeout(q, ms));
    const takePeak = async () => {
      document.getElementById('clearBtn').click();
      post({ t: 'silence' });
      await sleep(150);
      recStart();
      for (let i = 0; i < 3; i++) { strum(1, 0.9); await sleep(280); }
      recStop(); await sleep(450);
      const d = tape.buf.getChannelData(0);
      let pk = 0, over = 0;
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; if (a >= 0.999) over++; }
      return { pk: +pk.toFixed(3), over };
    };
    p.level = 0.2; onParam('level'); paintKnob('level');
    const quiet = await takePeak();
    p.level = 1.0; onParam('level'); paintKnob('level');
    const loud = await takePeak();

    /* now push everything and make sure the export cannot clip */
    let hot;
    try {
      Object.assign(p, { drive: 1, level: 1, delay: 1, fbk: 1, room: 1, chorus: 1, body: 1, bass: 1, treble: 1, mid: 1 });
      for (const k of Object.keys(p)) { paintKnob(k); onParam(k); }
      hot = await takePeak();
    } finally {
      /* whatever happened, do not leave the knobs pinned for every later check */
      Object.assign(p, DEFAULTS);
      for (const k of Object.keys(p)) { paintKnob(k); onParam(k); }
      document.getElementById('clearBtn').click();
      post({ t: 'silence' });
    }
    return { quiet, loud, hot };
  });
  check('the Level knob reaches the tape', r.loud.pk > r.quiet.pk * 1.8,
    `peak ${r.quiet.pk} at low level against ${r.loud.pk} at full`);
  check('an export cannot clip, however hard the knobs are pushed',
    r.hot.pk <= 0.985 && r.hot.over === 0,
    `worst recorded peak ${r.hot.pk}, ${r.hot.over} samples at full scale`);
}

/* ---------- 5d. an aborted overdub must not stay armed ---------- */
{
  const r = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((q) => setTimeout(q, ms));
    document.getElementById('clearBtn').click();
    recStart(); strum(1, 0.8); await sleep(400); recStop(); await sleep(450);
    const baseLen = tape.buf.length;
    /* start an overdub and abandon it immediately */
    document.getElementById('dubBtn').click();
    await sleep(5);
    recStop();
    await sleep(400);
    const stuck = tape.dub || document.getElementById('dubBtn').classList.contains('on');
    /* the next plain record must replace, not layer */
    recStart(); strum(1, 0.8); await sleep(700); recStop(); await sleep(450);
    playStop();
    const replaced = tape.buf.length !== baseLen;
    document.getElementById('clearBtn').click();
    return { stuck, replaced, baseLen, now: tape.buf ? tape.buf.length : 0 };
  });
  check('an abandoned overdub does not stay armed and quietly layer the next take',
    !r.stuck && r.replaced, `still armed ${r.stuck}, take replaced ${r.replaced}`);
}

/* ---------- 5e. scheduling, measured through the real worklet clock ----------
   The engine queues on the worklet's own frame counter; the interface hands
   it an AudioContext timestamp. Node never exercises that join, because
   currentFrame does not exist there, so it gets checked here instead. This
   is the seam where every strum once collapsed into a block chord. */
{
  const r = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((q) => setTimeout(q, ms));
    const onset = (thresh) => {
      if (!tape.buf) return null;
      const d = tape.buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > thresh) return i / tape.buf.sampleRate;
      return null;
    };
    const take = async (fn, ms) => {
      document.getElementById('clearBtn').click();
      post({ t: 'silence' });
      await sleep(160);
      recStart(); await sleep(60);
      fn(audio.ctx.currentTime);
      await sleep(ms);
      recStop(); await sleep(420);
      return onset(0.01);
    };
    const now = await take(() => post({ t: 'pluck', s: 0, vel: 0.95, pos: 0.17, freq: 82.407 }), 800);
    const later = await take((t) => post({ t: 'pluck', s: 0, vel: 0.95, pos: 0.17, freq: 82.407, at: t + 0.3 }), 1100);

    /* and every string of a real strum, one at a time so each onset is clean */
    p.spread = 1; onParam('spread');
    const onsets = [];
    for (let s = 0; s < 6; s++) {
      onsets.push(await take((t) => post({
        t: 'pluck', s, vel: 0.8, pos: 0.17, freq: noteFreq(s, 0), at: t + 0.02 + s * 0.034,
      }), 700));
    }
    Object.assign(p, DEFAULTS);
    for (const k of Object.keys(p)) { paintKnob(k); onParam(k); }
    document.getElementById('clearBtn').click();
    return { now, later, onsets };
  });
  const shift = r.later - r.now;
  check('a note asked for later actually arrives later',
    shift > 0.27 && shift < 0.33,
    `scheduled 0.3s ahead, landed ${shift.toFixed(3)}s after the unscheduled one`);
  const gaps = [];
  for (let i = 1; i < 6; i++) gaps.push(r.onsets[i] - r.onsets[i - 1]);
  const sweep = r.onsets[5] - r.onsets[0];
  check('a strum sweeps across the strings instead of landing as a block chord',
    gaps.every((g) => g > 0.02 && g < 0.06) && sweep > 0.13,
    `${gaps.map((g) => Math.round(g * 1000)).join(', ')} ms between strings, ${Math.round(sweep * 1000)} ms across`);
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
  const sizes = [[320, 480], [412, 900], [768, 1024], [2560, 700], [1024, 300],
                 [200, 200], [360, 260], [1440, 860]];
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

/* ---------- 11. the arranger, and the seam it has to cross ----------
   The page schedules a seventh of a second ahead of the speakers, so the one
   thing worth checking is not that the arranger derives a sane chart, which
   dev/song.mjs already does in node, nor that the engine plays what it is
   told, which dev/verify.mjs does. It is that the messages leaving this page
   carry the chord belonging to the bar they land in, and carry their own
   timing rather than firing the moment they were queued. So this records the
   real message stream out of the real page. */
{
  /* the same seed must give the same song here as it does in node, which also
     says the embedded reference data and dev/reference.json have not drifted */
  const derived = await page.evaluate(() => {
    const d = compose(20260907);
    return {
      title: d.title, tempo: d.tempo, barCount: d.barCount, seed: d.seed,
      source: d.source, feel: d.feel,
      chords: d.bars.map((b) => b.chord),
      sections: d.sections.map((s) => `${s.name}:${s.bars}`),
    };
  });

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const block = html.match(/<script id="arranger"[^>]*>([\s\S]*?)<\/script>/)[1];
  const A = new Function(`${block}\nreturn ARRANGER;`)();
  const REF = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'reference.json'), 'utf8'));
  const node = A.derive(REF, 20260907);

  check('the page derives the same song from a seed as node does',
    derived.title === node.title && derived.tempo === node.tempo
    && String(derived.chords) === String(node.bars.map((b) => b.chord)),
    `${derived.title}, ${derived.tempo} bpm, ${derived.barCount} bars`);

  check('composing lands a whole arrangement, not a loop',
    derived.sections.length >= 5 && derived.barCount >= 20,
    derived.sections.join(' '));

  /* the chord shapes are standard-tuning fingerings, so composing has to put
     the instrument back rather than play something else and call it a G */
  const tuned = await page.evaluate(() => {
    state.tuning = TUNINGS[2];
    $('tuneSel').value = '2';
    applyTuning();
    setCapo(3);
    const d = compose(4242);
    return { tuning: state.tuning.name, capo: state.capo, tempo: state.tempo, want: d.tempo, note: song.note };
  });
  check('composing returns to standard tuning with no capo',
    tuned.tuning === 'Standard' && tuned.capo === 0 && tuned.note !== '',
    `${tuned.tuning}, capo ${tuned.capo}, note "${tuned.note}"`);
  check('composing takes the song’s tempo', tuned.tempo === tuned.want, `${tuned.tempo} vs ${tuned.want}`);

  /* Now the seam. Record the stream instead of forwarding it: the engine is
     covered elsewhere, and queueing a whole song into it at once would just
     make a noise. */
  const seam = await page.evaluate(() => {
    const real = window.post;
    const stream = [];
    window.post = (m) => { stream.push(Object.assign({}, m)); };

    compose(20260907);
    const d = song.data;
    song.i = 0;
    song.queued = -1;
    song.t0 = audio.ctx.currentTime + 0.2;
    song.playing = true;
    songSchedule(Infinity);          // queue the entire song
    song.playing = false;
    window.post = real;

    const bar = (i) => ({ lo: songTime(i * d.beatsPerBar), hi: songTime((i + 1) * d.beatsPerBar) });
    const out = {
      msgs: stream.length, plucks: 0, noAt: 0, outOfBar: 0, wrongChord: 0,
      chuckBars: 0, undamped: 0, examples: [],
      barsHeard: new Set(), lastBarStart: -Infinity, barsOutOfOrder: 0,
    };

    /* every message in a scheduled song carries its own moment */
    for (const m of stream) if (m.at === undefined) out.noAt++;

    /* the windows in which a chuck is holding everything down */
    const chucks = stream
      .filter((m) => m.t === 'allmute' && m.a > 0.9 && m.at !== undefined)
      .map((m) => ({ from: m.at, to: m.at + 0.09 }));

    for (const m of stream) {
      if (m.t === 'mute' && m.a === 0 && m.at !== undefined
          && chucks.some((c) => m.at >= c.from - 1e-6 && m.at < c.to - 1e-6)) {
        out.undamped++;
      }
      if (m.t !== 'pluck' || m.at === undefined) continue;
      out.plucks++;

      const barSec = (d.beatsPerBar * 60) / state.tempo;
      const found = Math.floor((m.at - song.t0 + 1e-3) / barSec);
      if (found < 0 || found >= d.barCount) { out.outOfBar++; continue; }
      out.barsHeard.add(found);

      /* The frequency has to be one that bar's own shape can make. A hand
         takes a moment to cross six strings, so a stroke struck on the last
         slot of the bar before is still arriving here: that one is allowed to
         be the previous chord, and only within the time a strum takes. */
      const playable = (i) => {
        const bb = d.bars[i];
        if (!bb) return false;
        for (let s = 0; s < 6; s++) {
          if (bb.frets[s] < 0) continue;
          if (Math.abs(noteFreq(s, bb.frets[s]) - m.freq) < 0.02) return true;
        }
        return false;
      };
      const into = m.at - (song.t0 + found * barSec);
      const ok = playable(found) || (into < 0.2 && playable(found - 1));
      if (!ok) {
        out.wrongChord++;
        if (out.examples.length < 4) {
          out.examples.push(`bar ${found} (${d.bars[found].chord}) heard ${m.freq.toFixed(2)} Hz at +${(into * 1000).toFixed(0)}ms`);
        }
      }
    }

    out.chuckBars = chucks.length;
    out.bars = d.barCount;
    out.heard = out.barsHeard.size;
    delete out.barsHeard;
    return out;
  });

  check('a scheduled song posts nothing without a time on it', seam.noAt === 0, `${seam.noAt} of ${seam.msgs} messages fired at once`);
  check('every note lands inside the bar it belongs to', seam.outOfBar === 0, `${seam.outOfBar} strays`);
  check('every note is one its own bar’s chord can make',
    seam.wrongChord === 0,
    seam.wrongChord ? seam.examples.join('; ') : `${seam.plucks} notes over ${seam.heard}/${seam.bars} bars`);
  check('every bar of the chart gets played', seam.heard === seam.bars, `${seam.heard} of ${seam.bars}`);
  check('a chuck stays damped through its own strokes', seam.undamped === 0, `${seam.undamped} strokes lifted the scrape`);

  /* and it really plays: run a few bars through the actual engine */
  await clearWorst();
  const played = await page.evaluate(async () => {
    compose(20260907);
    state.tempo = 160;
    await songStart();
    const first = song.data.bars[0].chord;
    await new Promise((r) => setTimeout(r, 2600));
    return {
      playing: song.playing,
      bar: song.bar,
      first,
      now: song.bar >= 0 ? song.data.bars[song.bar].chord : null,
      held: state.held.slice(),
      readout: $('songRd').textContent,
    };
  });
  const heard = await worst();
  check('the song plays and walks forward through its bars', played.playing && played.bar > 0, `reached bar ${played.bar + 1}`);
  check('the neck follows the chart', String(played.held) === String(await page.evaluate((b) => song.data.bars[b].frets, played.bar)),
    `bar ${played.bar + 1} is ${played.now}`);
  check('the readout says where it is', /bar \d+ of \d+/.test(played.readout), played.readout);
  check('a playing song makes a sound and no NaN', heard.peak > 0.01 && heard.nan === 0, `peak ${heard.peak.toFixed(3)}, ${heard.nan} NaN`);

  /* the chart is the song written down */
  const chart = await page.evaluate(() => {
    $('chartBtn').click();
    const cells = [...document.querySelectorAll('#chartBody .cbar')];
    return {
      open: $('chartSheet').classList.contains('open'),
      cells: cells.length,
      bars: song.data.barCount,
      names: cells.map((c) => c.textContent),
      chart: song.data.bars.map((b) => b.chord),
      lit: document.querySelectorAll('#chartBody .cbar.on').length,
      rings: document.querySelectorAll('#chartBody .cbar.ring').length,
    };
  });
  check('the chart writes out one cell per bar, in order',
    chart.open && chart.cells === chart.bars && String(chart.names) === String(chart.chart),
    `${chart.cells} cells for ${chart.bars} bars`);
  check('the chart marks where the song has got to and where it ends',
    chart.lit === 1 && chart.rings === 1, `${chart.lit} lit, ${chart.rings} ending`);

  /* stopping stops, and hands the guitar back */
  const stopped = await page.evaluate(() => {
    $('chartSheet').classList.remove('open');
    songStop();
    return { playing: song.playing, timer: seq.timer, readout: $('songRd').textContent };
  });
  check('stopping the song stops the clock with it', !stopped.playing && stopped.timer === 0, `timer ${stopped.timer}`);

  /* a song and the pattern strummer are two answers to the same question */
  const exclusive = await page.evaluate(async () => {
    $('strumBtn').click();
    const wasOn = seq.on;
    await songStart();
    const after = { seqOn: seq.on, lit: $('strumBtn').classList.contains('on'), songOn: song.playing };
    songStop();
    return { wasOn, after };
  });
  check('starting a song turns the strum pattern off',
    exclusive.wasOn && !exclusive.after.seqOn && !exclusive.after.lit && exclusive.after.songOn,
    JSON.stringify(exclusive.after));

  /* the seed in the address bar is the song */
  const seeded = await page.evaluate(() => ({ hash: location.hash, seed: song.data.seed }));
  check('the seed goes in the address bar', seeded.hash === '#s=' + seeded.seed, `${seeded.hash} vs seed ${seeded.seed}`);

  await page.evaluate(() => { songStop(); seq.metro = false; $('metroBtn').classList.remove('on'); maybeStopSeq(); });
}

/* ---------- 12. opening a file, and the hand it puts on the neck ----------
   dev/import.mjs already checks that the importer picks playable places for
   the notes. What can only be checked here is the rest of the journey: a real
   file going through a real file input, the notes reaching the engine at the
   right pitch, and the fingering on the neck being the fingering of the note
   you can hear rather than the one queued a seventh of a second later. */
{
  /* the same synthetic file the node harness uses, built here so nothing
     binary lives in the repo */
  const vlq = (n) => { const o = [n & 0x7f]; n >>= 7; while (n > 0) { o.unshift((n & 0x7f) | 0x80); n >>= 7; } return o; };
  const be16 = (n) => [(n >> 8) & 0xff, n & 0xff];
  const be32 = (n) => [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const tune = [];
  /* a plain ascending line, one note per beat, inside the guitar's own range */
  const pitches = [40, 45, 50, 55, 59, 64, 62, 57, 52, 47, 43, 48, 53, 58, 61, 64];
  pitches.forEach((pitch, i) => tune.push({ at: i * 480, dur: 440, pitch }));

  const body = [];
  let last = 0;
  const us = Math.round(60000000 / 120);
  body.push(...vlq(0), 0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff);
  body.push(...vlq(0), 0xff, 0x58, 0x04, 4, 2, 24, 8);
  const flat = [];
  for (const e of tune) {
    flat.push({ at: e.at, order: 1, bytes: [0x90, e.pitch, 92] });
    flat.push({ at: e.at + e.dur, order: 2, bytes: [0x80, e.pitch, 0] });
  }
  flat.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const e of flat) { body.push(...vlq(e.at - last)); last = e.at; body.push(...e.bytes); }
  body.push(...vlq(0), 0xff, 0x2f, 0x00);
  const midiBytes = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, ...be32(6), ...be16(1), ...be16(1), ...be16(480),
    0x4d, 0x54, 0x72, 0x6b, ...be32(body.length), ...body,
  ]);

  /* a chord sheet, which is the other thing a guitarist actually has */
  const sheet = Buffer.from('title: Sheet Test\nbpm: 104\npattern: Folk down-up\n| G | D | Em | C |\n| Am | F | C | G |\n', 'utf8');

  /* --- the MIDI path, through the real input --- */
  await page.setInputFiles('#songFile', { name: 'ascend.mid', mimeType: 'audio/midi', buffer: midiBytes });
  await wait(250);
  const opened = await page.evaluate(() => ({
    kind: song.data && song.data.kind,
    title: song.data && song.data.title,
    tempo: song.data && song.data.tempo,
    notes: song.data && song.data.notes,
    bars: song.data && song.data.barCount,
    events: song.ev.length,
    playable: !$('songBtn').disabled,
    readout: $('songRd').textContent,
  }));
  check('a MIDI file dropped on the page becomes a playable song',
    opened.kind === 'midi' && opened.events === 16 && opened.playable && opened.tempo === 120,
    `${opened.title}: ${opened.events} notes, ${opened.bars} bars, ${opened.tempo} bpm`);
  check('the readout says what it read', /ascend/.test(opened.readout) && /16 notes/.test(opened.readout), opened.readout);

  /* --- the seam again: the pitches that reach the engine, and the hand --- */
  const seam = await page.evaluate(() => {
    const real = window.post;
    const stream = [];
    window.post = (m) => { stream.push(Object.assign({}, m)); };

    song.i = 0;
    song.queued = -1;
    song.t0 = audio.ctx.currentTime + 0.2;
    song.playing = true;
    songSchedule(Infinity);
    song.playing = false;
    window.post = real;

    const plucks = stream.filter((m) => m.t === 'pluck');
    const out = { plucks: plucks.length, noAt: 0, wrongPitch: 0, examples: [], handWrong: 0 };
    for (const m of stream) if (m.at === undefined) out.noAt++;

    /* every note must sound the pitch the file asked for, at the place the
       importer chose for it */
    song.ev.forEach((e, i) => {
      const want = noteFreq(e.string, e.fret);
      const got = plucks[i];
      if (!got || Math.abs(got.freq - want) > 0.02) {
        out.wrongPitch++;
        if (out.examples.length < 3) out.examples.push(`note ${i} wanted ${want.toFixed(2)} got ${got ? got.freq.toFixed(2) : 'nothing'}`);
      }
      /* and the hand it carries has to hold that note */
      if (e.held[e.string] !== e.fret) out.handWrong++;
      if (e.fingers.some((f, s) => (e.held[s] <= 0 ? f !== 0 : f < 1 || f > 4))) out.handWrong++;
    });
    return out;
  });
  check('every imported note reaches the engine with its own time on it', seam.noAt === 0, `${seam.noAt} fired at once`);
  check('every imported note sounds the pitch the file asked for',
    seam.wrongPitch === 0, seam.wrongPitch ? seam.examples.join('; ') : `${seam.plucks} notes`);
  check('every note carries a hand that is actually holding it', seam.handWrong === 0, `${seam.handWrong} wrong`);

  /* --- fingers mode, on the real neck --- */
  const hand = await page.evaluate(async () => {
    state.showFingers = true;
    $('fingersBtn').classList.add('on');
    await songStart();
    /* far enough in to be past the open strings this tune starts on, so the
       fingering is actually doing something */
    const seen = [];
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 160));
      if (state.fingers && state.fingers.some((f) => f > 0)) {
        seen.push({ held: state.held.slice(), fingers: state.fingers.slice() });
      }
    }
    const snap = {
      held: state.held.slice(), fingers: state.fingers && state.fingers.slice(),
      chord: state.chord, fretted: seen.length, sample: seen[0] || null,
    };
    songStop();
    return snap;
  });
  check('playing an imported file puts a derived hand on the neck',
    Array.isArray(hand.fingers) && hand.fingers.length === 6 && hand.chord === null
    && hand.fingers.every((f, s) => (hand.held[s] <= 0 ? f === 0 : f >= 1 && f <= 4)),
    `held ${hand.held.join(',')} fingers ${hand.fingers && hand.fingers.join(',')}`);
  check('and names a finger for the notes that need one',
    hand.fretted > 0 && hand.sample
    && hand.sample.fingers.every((f, s) => (hand.sample.held[s] <= 0 ? f === 0 : f >= 1 && f <= 4)),
    hand.sample ? `held ${hand.sample.held.join(',')} fingers ${hand.sample.fingers.join(',')} (${hand.fretted} moments)` : 'never fretted anything');

  const toggled = await page.evaluate(() => {
    $('fingersBtn').click();
    const off = { on: state.showFingers, lit: $('fingersBtn').classList.contains('on') };
    $('fingersBtn').click();
    return { off, on: state.showFingers };
  });
  check('the fingers toggle turns the numbers off and back on',
    toggled.off.on === false && toggled.off.lit === false && toggled.on === true,
    JSON.stringify(toggled));

  /* a named chord keeps the fingering the reference data gives it */
  const named = await page.evaluate(() => {
    const c = CHORDS.find((x) => x.name === 'C' && x.openPosition);
    setChord(c);
    return { derived: state.fingers, dataFingers: c.fingers, held: state.held.slice() };
  });
  check('a named chord uses the fingering from the reference data, not a derived one',
    named.derived === null && String(named.held) === String([-1, 3, 2, 0, 1, 0]),
    `state.fingers is ${JSON.stringify(named.derived)}`);

  /* --- the chord sheet path --- */
  await page.setInputFiles('#songFile', { name: 'sheet.txt', mimeType: 'text/plain', buffer: sheet });
  await wait(250);
  const chart = await page.evaluate(() => ({
    kind: song.data.kind,
    title: song.data.title,
    tempo: song.data.tempo,
    bars: song.data.bars.map((b) => b.chord).join(' '),
    events: song.ev ? song.ev.length : 0,
    pattern: song.data.sections[0].pattern,
    strums: song.ev ? song.ev.filter((e) => e.kind === 'D' || e.kind === 'U').length : 0,
  }));
  check('a chord sheet becomes strummed bars',
    chart.kind === 'chart' && chart.bars === 'G D Em C Am F C G' && chart.tempo === 104 && chart.strums > 0,
    `${chart.title}: ${chart.bars} on ${chart.pattern}, ${chart.strums} strums`);

  const sheetPlay = await page.evaluate(async () => {
    await songStart();
    await new Promise((r) => setTimeout(r, 1200));
    const snap = { playing: song.playing, bar: song.bar, chord: state.chord && state.chord.name };
    songStop();
    return snap;
  });
  check('a chord sheet plays with real chord shapes on the neck',
    sheetPlay.playing && sheetPlay.chord !== null, `bar ${sheetPlay.bar + 1}, holding ${sheetPlay.chord}`);

  /* --- a file it cannot read says so and changes nothing --- */
  const before = await page.evaluate(() => song.data.title);
  await page.setInputFiles('#songFile', { name: 'junk.txt', mimeType: 'text/plain', buffer: Buffer.from('lorem ipsum dolor sit amet', 'utf8') });
  await wait(200);
  const refused = await page.evaluate(() => ({ readout: $('songRd').textContent, title: song.data.title }));
  check('a file with nothing playable in it is refused out loud, and keeps the old song',
    /Could not read junk\.txt/.test(refused.readout) && refused.title === before,
    refused.readout);

  await page.evaluate(() => { songStop(); });
}

console.log(errs.length ? `\npage errors:\n  ${errs.join('\n  ')}` : '\nno page errors');
if (errs.length) fails++;
console.log(`\n${fails ? fails + ' failing' : 'everything behaves'}`);
await browser.close();
process.exit(fails ? 1 : 0);
