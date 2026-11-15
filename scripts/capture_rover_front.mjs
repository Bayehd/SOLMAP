// Renders the Rover view twice from the same camera, with and without the 3D rover, for the picture of the rover's
// front shown while riding (public/models/rover-front.webp, see ROVER_FRONT in src/map/MapApp.tsx).
// Needs the dev server running and Google Chrome. Then cut the rover out with scripts/cutout_rover_front.py.
// usage: node scripts/capture_rover_front.mjs http://localhost:5173/ /tmp/rover
//   writes /tmp/rover-with.png and /tmp/rover-without.png (1.5× the 1000 × ~1613 px window: a tall window, so the
//   picture also covers tall screens)
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out] = process.argv.slice(2);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=9340', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'solmap-'))}`,
  '--window-size=1000,1700', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch('http://127.0.0.1:9340/json')).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const waitFor = async (e, ms = 90000) => { const t = Date.now(); while (!(await ev(e)) && Date.now() - t < ms) await sleep(100); };

await send('Page.navigate', { url });
await sleep(3000);
await ev("document.querySelectorAll('.home-site')[0].click()"); // Jezero (the rover looks the same at both sites)
await waitFor("!!document.querySelector('.skycrane')");
await waitFor("!document.querySelector('.skycrane')");
await sleep(2000);
await ev("[...document.querySelectorAll('.segmented .btn')].find((b) => b.textContent === 'Rover').click()");
await sleep(12000);
// The picture replaces the 3D model while riding, so show the model again for the captures.
const grab = (show) => ev(`(async () => {
  const v = window.solmap.view; const rover = v.map.findLayerById('rover');
  rover.visible = ${show};
  await new Promise((r) => setTimeout(r, 2500));
  for (let i = 0; i < 75 && v.updating; i++) await new Promise((r) => setTimeout(r, 200));
  window.__cam = JSON.stringify(v.camera.toJSON());
  return (await v.takeScreenshot({ format: 'png', width: Math.round(v.width * 1.5), height: Math.round(v.height * 1.5) })).dataUrl;
})()`);
const withRover = await grab(true);
const cam1 = await ev('window.__cam');
const without = await grab(false);
const cam2 = await ev('window.__cam');
console.log('view', await ev('JSON.stringify({ width: window.solmap.view.width, height: window.solmap.view.height })'));
if (cam1 !== cam2) console.log('WARNING: the camera moved between the two captures; run again');
writeFileSync(`${out}-with.png`, Buffer.from(withRover.split(',')[1], 'base64'));
writeFileSync(`${out}-without.png`, Buffer.from(without.split(',')[1], 'base64'));
chrome.kill();
process.exit(0);
