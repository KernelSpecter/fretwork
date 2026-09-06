/* Presses every documented key in a real browser and checks what the engine
   was actually told to do. node dev/keys.mjs */

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
await page.goto('file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/'));
await page.waitForTimeout(700);

/* boot audio, then put a tap on every message the engine receives */
const box = await page.locator('#neck').boundingBox();
await page.mouse.click(box.x + 40, box.y + box.height / 2);
await page.waitForTimeout(600);
await page.evaluate(() => {
  window.__log = [];
  const real = audio.guitar.port.postMessage.bind(audio.guitar.port);
  audio.guitar.port.postMessage = (m) => { window.__log.push(m); real(m); };
  window.__reset = () => { window.__log = []; };
});

const reset = () => page.evaluate(() => { window.__reset(); });
const log = () => page.evaluate(() => window.__log.slice());
const peek = () => page.evaluate(() => ({
  chord: state.chord ? state.chord.name : null,
  held: state.held.slice(),
  vel: +state.vel.toFixed(3),
  capo: state.capo,
  harmonic: state.harmonic,
  palm: state.palm,
  seqOn: seq.on,
  recording: tape.recording,
  litSlot: state.litSlot,
}));

let fails = 0;
function check(name, ok, detail) {
  if (!ok) fails++;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${name}${detail ? '   ' + detail : ''}`);
}
const plucks = (l) => l.filter((m) => m.t === 'pluck');

/* a strum is a downstroke if the low string is scheduled first */
function direction(l) {
  const ps = plucks(l).filter((m) => typeof m.at === 'number');
  if (ps.length < 3) return 'not a strum (' + ps.length + ' plucks)';
  const first = ps.reduce((a, b) => (a.at <= b.at ? a : b));
  const last = ps.reduce((a, b) => (a.at >= b.at ? a : b));
  return first.s < last.s ? 'down' : 'up';
}

await page.click('#neck', { position: { x: 10, y: 10 } }).catch(() => {});
await page.evaluate(() => document.activeElement && document.activeElement.blur());

/* ---- 1. chord slot keys ---- */
for (const [key, want, slot] of [['a', 'G', 0], ['d', 'Em', 2], ['k', 'Cmaj7', 7]]) {
  await reset();
  await page.keyboard.press(key);
  await page.waitForTimeout(60);
  const st = await peek(), l = await log();
  check(`"${key}" holds ${want} and strums it`,
    st.chord === want && st.litSlot === slot && plucks(l).length >= 4 && direction(l) === 'down',
    `chord ${st.chord}, ${plucks(l).length} strings, ${direction(l)}`);
}

/* ---- 2. space and shift space ---- */
await reset();
await page.keyboard.press('Space');
await page.waitForTimeout(60);
let l = await log();
check('space strums downward', direction(l) === 'down', `${plucks(l).length} strings, ${direction(l)}`);

await reset();
await page.keyboard.press('Space');
await page.waitForTimeout(60);
const downCount = plucks(await log()).length;
await reset();
await page.keyboard.press('Shift+Space');
await page.waitForTimeout(60);
l = await log();
const upCount = plucks(l).length;
check('shift and space strums upward', direction(l) === 'up', `${upCount} strings, ${direction(l)}`);
check('the upstroke leaves the bass strings behind, so it sounds different',
  upCount < downCount && upCount >= 2, `${downCount} strings down against ${upCount} up`);

/* the same thing done by hand, in case press() collapses the modifier */
await reset();
await page.keyboard.down('Shift');
await page.keyboard.press(' ');
await page.keyboard.up('Shift');
await page.waitForTimeout(60);
l = await log();
check('holding shift then tapping space also strums upward', direction(l) === 'up', direction(l));

/* ---- 3. single strings ---- */
for (const [key, s] of [['1', 0], ['3', 2], ['6', 5]]) {
  await reset();
  await page.keyboard.press(key);
  await page.waitForTimeout(50);
  const ps = plucks(await log());
  check(`"${key}" picks string ${s + 1} on its own`,
    ps.length === 1 && ps[0].s === s, `${ps.length} plucks, string ${ps.length ? ps[0].s : '-'}`);
}

/* ---- 4. muted chuck ---- */
await reset();
await page.keyboard.press('x');
await page.waitForTimeout(60);
l = await log();
check('"x" damps everything then hits it',
  l.some((m) => m.t === 'allmute' && m.a > 0.9) && plucks(l).length >= 3,
  `${plucks(l).length} strings behind an allmute`);
await page.waitForTimeout(200);

/* ---- 5. palm mute is held, not toggled ---- */
await reset();
await page.keyboard.down('m');
await page.waitForTimeout(40);
const mDown = await peek(), mLog = await log();
await page.keyboard.up('m');
await page.waitForTimeout(40);
const mUp = await peek(), mLog2 = await log();
check('"m" mutes while held and releases after',
  mDown.palm === true && mUp.palm === false &&
  mLog.some((x) => x.t === 'allmute' && x.a > 0.5) &&
  mLog2.some((x) => x.t === 'allmute' && x.a === 0),
  `held ${mDown.palm}, released ${mUp.palm}`);

/* ---- 6. harmonics ---- */
await reset();
await page.keyboard.down('q');
await page.keyboard.press('1');
await page.waitForTimeout(40);
const qLog = plucks(await log());
await page.keyboard.up('q');
check('"q" turns the next pluck into a harmonic',
  qLog.length === 1 && qLog[0].harmonic > 1,
  `harmonic ${qLog.length ? qLog[0].harmonic : 'none'}`);

/* ---- 7. velocity ---- */
const v0 = (await peek()).vel;
await page.keyboard.press('ArrowUp');
await page.keyboard.press('ArrowUp');
const v1 = (await peek()).vel;
await page.keyboard.press('ArrowDown');
const v2 = (await peek()).vel;
check('up and down arrows move the touch', v1 > v0 && v2 < v1, `${v0} then ${v1} then ${v2}`);

/* ---- 8. capo ---- */
await reset();
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
const capo = (await peek()).capo;
const tun = (await log()).filter((m) => m.t === 'tuning');
const rose = tun.length && tun[tun.length - 1].f[0] > 82.5;
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
const capo0 = (await peek()).capo;
const selVal = await page.inputValue('#capoSel');
check('left and right arrows move the capo and retune',
  capo === 2 && capo0 === 0 && rose && selVal === '0',
  `capo went to ${capo} and back to ${capo0}, select reads ${selVal}`);

/* ---- 9. the strum pattern ---- */
await page.keyboard.press('Enter');
await page.waitForTimeout(60);
const seqOn = (await peek()).seqOn;
await page.keyboard.press('Enter');
await page.waitForTimeout(60);
const seqOff = (await peek()).seqOn;
check('enter starts and stops the strum pattern', seqOn === true && seqOff === false,
  `${seqOn} then ${seqOff}`);

/* ---- 10. record ---- */
await page.keyboard.press('r');
await page.waitForTimeout(120);
const rec1 = (await peek()).recording;
await page.keyboard.press('r');
await page.waitForTimeout(400);
const rec2 = await page.evaluate(() => ({ recording: tape.recording, has: !!tape.buf }));
check('"r" records and stops', rec1 === true && rec2.recording === false && rec2.has,
  `recording ${rec1}, then ${rec2.recording}, tape holds audio: ${rec2.has}`);

/* ---- 11. keys must not fire while a control has focus ---- */
await page.evaluate(() => document.getElementById('tempoSel').focus());
await reset();
await page.keyboard.press('Space');
await page.waitForTimeout(50);
const leaked = plucks(await log()).length;
await page.evaluate(() => document.activeElement.blur());
check('typing into a control does not strum', leaked === 0, `${leaked} stray plucks`);

/* ---- 11b. after touching a control, the keys must come back ---- */
for (const [what, how] of [
  ['a dropdown', async () => { await page.selectOption('#irSel', 'hall'); }],
  ['a knob', async () => {
    const k = await page.locator('.knob').first().boundingBox();
    await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
    await page.mouse.down(); await page.mouse.move(k.x + k.width / 2, k.y + 4); await page.mouse.up();
  }],
  ['a chord slot', async () => { await page.locator('.slot').nth(1).click(); }],
  ['the tempo box', async () => { await page.selectOption('#tempoSel', '120'); }],
  ['a panel button', async () => { await page.click('#chordsBtn'); await page.keyboard.press('Escape'); }],
]) {
  await how();
  await page.waitForTimeout(80);
  await reset();
  await page.keyboard.press('1');
  await page.waitForTimeout(60);
  const n = plucks(await log()).length;
  const focus = await page.evaluate(() => document.activeElement.tagName + (document.activeElement.className ? '.' + String(document.activeElement.className).split(' ')[0] : ''));
  check(`the number keys still play after using ${what}`, n === 1, `${n} plucks, focus on ${focus}`);
}

/* ---- 11c. space on a focused button must not do it twice ---- */
{
  await page.locator('.slot').nth(0).click();
  await page.waitForTimeout(80);
  await reset();
  await page.keyboard.press('Space');
  await page.waitForTimeout(80);
  const n = plucks(await log()).length;
  check('space after clicking a chord slot strums once, not twice', n >= 3 && n <= 6, `${n} plucks`);
}

/* ---- 12. escape closes an open panel ---- */
await page.click('#chordsBtn');
await page.waitForTimeout(120);
const openNow = await page.evaluate(() => document.querySelectorAll('.sheet.open').length);
await page.keyboard.press('Escape');
await page.waitForTimeout(120);
const openAfter = await page.evaluate(() => document.querySelectorAll('.sheet.open').length);
check('escape closes an open panel', openNow === 1 && openAfter === 0, `${openNow} then ${openAfter}`);

/* ---- 13. holding a key must not machine gun ---- */
await reset();
await page.keyboard.down('a');
await page.waitForTimeout(500);
await page.keyboard.up('a');
const held = plucks(await log()).length;
check('holding a chord key strums once, not repeatedly', held <= 6, `${held} plucks in half a second`);

console.log(errs.length ? `\npage errors:\n  ${errs.join('\n  ')}` : '\nno page errors');
console.log(`\n${fails ? fails + ' failing' : 'all keys behave'}`);
await browser.close();
process.exit(fails ? 1 : 0);
