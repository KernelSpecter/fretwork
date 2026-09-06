/* Renders the pictures used in the README at plain resolution, so the repo
   does not carry twenty megabytes of retina screenshots. */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'docs');
fs.mkdirSync(OUT, { recursive: true });
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

async function shoot(name, size, steps) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
  await page.waitForTimeout(800);
  const box = await page.locator('#neck').boundingBox();
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.waitForTimeout(700);
  await steps(page, box);
  await page.screenshot({ path: path.join(OUT, name) });
  await page.close();
}

await shoot('neck.png', { width: 1440, height: 820 }, async (page) => {
  await page.evaluate(() => {
    setChord(CHORDS.find((c) => c.name === 'Cadd9') || CHORDS[0]);
    strum(1, 0.9);
  });
  await page.waitForTimeout(90);
});

await shoot('electric.png', { width: 1440, height: 820 }, async (page) => {
  await page.evaluate(() => {
    document.getElementById('instSel').value = 'electric';
    document.getElementById('instSel').dispatchEvent(new Event('change'));
    p.drive = 0.45; p.room = 0.3; onParam('drive'); onParam('room');
    paintKnob('drive'); paintKnob('room');
    setChord(CHORDS.find((c) => c.name === 'Am7') || CHORDS[0]);
    strum(1, 0.9);
  });
  await page.waitForTimeout(140);
});

await shoot('chords.png', { width: 1120, height: 820 }, async (page) => {
  await page.click('#chordsBtn');
  await page.waitForTimeout(250);
});

await shoot('phone.png', { width: 412, height: 880 }, async (page) => {
  await page.evaluate(() => { setChord(CHORDS.find((c) => c.name === 'Em7') || CHORDS[0]); strum(1, 0.9); });
  await page.waitForTimeout(120);
});

await browser.close();
for (const f of fs.readdirSync(OUT)) {
  console.log(f, (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB');
}
