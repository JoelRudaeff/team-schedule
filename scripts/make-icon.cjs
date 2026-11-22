/**
 * Renders resources/icon.svg to resources/icon.png (512px) and resources/icon.ico
 * (16–256px). Run with:  npx electron scripts/make-icon.cjs
 * Only needed again when the SVG changes; the generated files are kept in the project.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resources = path.join(__dirname, '..', 'resources');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'team-schedule-icon-')));
app.disableHardwareAcceleration();

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(resources, 'icon.svg'));
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  const html =
    '<html><body style="margin:0;background:transparent;overflow:hidden">' +
    `<img src="data:image/svg+xml;base64,${svg.toString('base64')}" width="512" height="512" style="display:block">` +
    '</body></html>';
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const master = await win.webContents.capturePage();
  win.destroy();

  const at = (size) => master.resize({ width: size, height: size, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(resources, 'icon.png'), at(512));
  const ico = buildIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: at(size) })));
  fs.writeFileSync(path.join(resources, 'icon.ico'), ico);
  console.log('icon.png and icon.ico written, master capture:', master.getSize());
  app.quit();
});
