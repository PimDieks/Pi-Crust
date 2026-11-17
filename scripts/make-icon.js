// Regenerates build/icon.png (1024) and build/icon.ico (16..256) from build/icon.svg.
// Usage: node scripts/make-icon.js
// Rasterises with the repo's own Electron (offscreen, transparent). Every size is
// rendered straight from the SVG, nothing is downscaled from a bigger bitmap.
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'build', 'icon.svg');
const PNG_SIZE = 1024;
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

if (!process.versions.electron) {
  const r = require('child_process').spawnSync(require('electron'), [__filename], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

function icoFrom(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, png }, i) => {
    const o = 6 + 16 * i;
    head[o] = size >= 256 ? 0 : size; head[o + 1] = size >= 256 ? 0 : size;
    head[o + 2] = 0; head[o + 3] = 0;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(png.length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.png)]);
}

let win;
async function render(size) {
  if (!win) {
    win = new BrowserWindow({
      show: false, width: PNG_SIZE, height: PNG_SIZE, useContentSize: true,
      transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true },
    });
    const svgUri = 'data:image/svg+xml;base64,' + fs.readFileSync(SVG).toString('base64');
    const html = `<html><body style="margin:0;background:transparent"><img id="m" src="${svgUri}" style="display:block"></body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  }
  // The SVG is re-laid-out at the target size, so each raster is a fresh render.
  await win.webContents.executeJavaScript(`new Promise(r => { const i = document.getElementById('m'); i.width = ${size}; i.height = ${size}; (i.decode ? i.decode() : Promise.resolve()).then(() => requestAnimationFrame(() => requestAnimationFrame(r))); })`);
  await new Promise((r) => setTimeout(r, 250));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  if (img.getSize().width !== size) throw new Error(`bad capture size ${JSON.stringify(img.getSize())} for ${size}`);
  return img.toPNG();
}

app.whenReady().then(async () => {
  try {
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), await render(PNG_SIZE));
    const entries = [];
    for (const size of ICO_SIZES) entries.push({ size, png: await render(size) });
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), icoFrom(entries));
    console.log('wrote build/icon.png and build/icon.ico (' + ICO_SIZES.join(', ') + ')');
    app.quit();
  } catch (e) { console.error(e); app.exit(1); }
});
