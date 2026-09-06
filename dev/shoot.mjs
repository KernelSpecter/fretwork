/* Drives the real page in a real browser: boots audio, plays something,
   and takes pictures. node dev/shoot.mjs [--portrait] [--headed] */

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(HERE, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const portrait = process.argv.includes('--portrait');
const headed = process.argv.includes('--headed');
const size = portrait ? { width: 412, height: 900 } : { width: 1440, height: 860 };

/* use the Chrome that is already on the machine rather than pulling a
   second copy down just to take a screenshot */
/* use a Chrome that is already installed when there is one, so a clone
   does not have to download a second copy just to run the tests */
const SYS_CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((q) => fs.existsSync(q));

const browser = await chromium.launch({
  headless: !headed,
  executablePath: SYS_CHROME,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));

await page.goto('file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/'));
await page.waitForTimeout(900);

const tag = portrait ? 'portrait' : 'landscape';
await page.screenshot({ path: path.join(OUT, `${tag}-1-cold.png`) });

/* boot audio the way a person does, by touching the neck */
const box = await page.locator('#neck').boundingBox();
await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.4);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(700);

const ready = await page.evaluate(() => ({
  ready: audio.ready,
  ctxState: audio.ctx ? audio.ctx.state : null,
  rate: audio.ctx ? audio.ctx.sampleRate : null,
  irs: audio.irs ? Object.keys(audio.irs).length : 0,
  chords: CHORDS.length,
  slots: state.slots.map((c) => (c ? c.name : null)),
  frets: L.frets,
  portrait: view.portrait,
  hasRec: !!audio.rec,
  hint: document.getElementById('hint').textContent.replace(/\s+/g, ' ').trim().slice(0, 120),
}));
console.log('boot:', JSON.stringify(ready));
if (logs.length) { for (const l of logs) console.log(l); logs.length = 0; }

/* strum, then let it ring so the strings are visibly moving */
await page.evaluate(() => { strum(1, 0.85); });
await page.waitForTimeout(120);
await page.screenshot({ path: path.join(OUT, `${tag}-2-playing.png`) });

/* drag across the soundhole, the way strumming actually happens */
await page.mouse.move(box.x + box.width * 0.87, box.y + box.height * 0.14);
await page.mouse.down();
for (let i = 0; i <= 10; i++) {
  await page.mouse.move(box.x + box.width * 0.87, box.y + box.height * (0.14 + 0.72 * (i / 10)));
  await page.waitForTimeout(12);
}
await page.mouse.up();
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(OUT, `${tag}-3-strum.png`) });

/* record a couple of seconds and check the tape actually caught something */
let tapeResult = { ok: false, why: 'skipped' };
try {
tapeResult = await page.evaluate(async () => {
  recStart();
  for (let i = 0; i < 4; i++) {
    strum(i % 2 ? -1 : 1, 0.8);
    await new Promise((r) => setTimeout(r, 320));
  }
  recStop();
  await new Promise((r) => setTimeout(r, 500));
  if (!tape.buf) return { ok: false, why: 'no buffer' };
  const d = tape.buf.getChannelData(0);
  let pk = 0, rms = 0, nan = 0;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (!Number.isFinite(v)) nan++;
    const a = Math.abs(v); if (a > pk) pk = a; rms += v * v;
  }
  return {
    ok: true, seconds: +(tape.buf.length / tape.buf.sampleRate).toFixed(2),
    peak: +pk.toFixed(4), rms: +Math.sqrt(rms / d.length).toFixed(4), nan,
    wavBytes: encodeWav(tape.buf).size,
  };
});
} catch (e) { tapeResult = { ok: false, why: String(e.message).slice(0, 200) }; }

/* open the panels so they get looked at too */
await page.click('#chordsBtn');
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(OUT, `${tag}-4-chords.png`) });
await page.keyboard.press('Escape');
await page.click('#helpBtn');
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(OUT, `${tag}-5-keys.png`) });
await page.keyboard.press('Escape');

/* every instrument, so a broken body drawing shows up */
const setupHidden = await page.evaluate(() => getComputedStyle(document.getElementById('fields')).display === 'none');
if (setupHidden) await page.click('#setupBtn');
for (const id of ['nylon', 'electric', 'archtop']) {
  await page.selectOption('#instSel', id);
  await page.waitForTimeout(120);
  await page.evaluate(() => strum(1, 0.85));
  await page.waitForTimeout(140);
  await page.screenshot({ path: path.join(OUT, `${tag}-6-${id}.png`) });
}

console.log(JSON.stringify({ tag, ready, tape: tapeResult }, null, 2));
if (logs.length) { console.log('\n--- console ---'); for (const l of logs) console.log(l); }
else console.log('\nno console output');

await browser.close();
