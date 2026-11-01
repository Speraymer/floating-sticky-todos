// Run with: node tests/window-tray.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
let window, icon;
class Window extends EventEmitter {
  constructor(options) { super(); this.options = options; window = this; }
  loadFile() {}
  setSkipTaskbar(value) { this.skipTaskbar = value; }
}
const electron = {
  app: { whenReady: () => new Promise(() => {}), on() {} },
  BrowserWindow: Window,
  nativeImage: { createFromBitmap(pixels, options) { return { pixels, ...options }; } },
  Tray: class extends EventEmitter {
    constructor(image) { super(); icon = image; }
    setToolTip() {}
  }
};
const context = vm.createContext({
  require: name => name === 'electron' ? electron : require(name),
  __dirname: require('node:path').resolve(__dirname, '../src'),
  process: { platform: 'win32', env: {} }, Buffer, console,
});
vm.runInContext(fs.readFileSync(require.resolve('../src/main.js'), 'utf8'), context);
vm.runInContext(`readData = () => ({}); readWindowState = () => ({});
  refreshTrayMenu = () => {}; createWindow(); createTray();`, context);
assert.equal(window.options.type, 'toolbar');
assert.equal(window.options.skipTaskbar, true);
for (const event of ['show', 'restore', 'always-on-top-changed']) {
  window.skipTaskbar = false;
  window.emit(event);
  assert.equal(window.skipTaskbar, true, event);
}
assert.equal(icon.width, 32);
assert.equal(icon.height, 32);
let opaque = 0, yellow = 0, dark = 0;
for (let i = 0; i < icon.pixels.length; i += 4) {
  if (icon.pixels[i + 3] === 255) opaque++;
  if (icon.pixels[i + 2] === 255) yellow++;
  if (icon.pixels[i + 2] === 41) dark++;
}
assert.ok(opaque > 700 && yellow > 500 && dark > 40, 'visible note and check');
console.log('PASS: tray bitmap and taskbar lifecycle');
