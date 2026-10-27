/*
 * ThermaLabel driver: MUNBYN ITPP130B (130B) 4" label printer, over Bluetooth LE
 *
 * Protocol: TSPL (text commands), 203 dpi, 4 x 6 in die-cut labels with a gap.
 *   SIZE w mm,h mm / GAP g mm,0 mm / SPEED 1-6 / DENSITY 0-15 / DIRECTION 0 / REFERENCE 0,0 / CLS
 *   BITMAP 0,0,widthBytes,height,0,<packed rows, MSB first, bit 1 = WHITE> / PRINT 1,1
 * The bitmap polarity was confirmed on the real printer (a USB TSPL app printed reversed until
 * it sent PIL "1"-mode bytes as-is, where 1 = white).
 *
 * BLE: the GATT layout is not confirmed yet, so connect() asks for the services TSPL/ESC-POS
 * BLE printers commonly use and picks the first writable characteristic, logging what it found.
 *
 * Two connections, same TSPL job:
 *   munbyn130b_usb  USB cable through a local bridge that hands the bytes to the Windows RAW print queue:
 *                   tools/usb_bridge (127.0.0.1:5758, preferred) or the MUNBYN Label Printer app 1.2.0+
 *                   (127.0.0.1:5757, /api/bridge/*).
 *   munbyn130b      Bluetooth LE through the ISSC UART service (UUIDs from MUNBYN's own web editor), beta.
 *
 * Registers window.ThermaLabelDrivers.munbyn130b_usb and .munbyn130b
 */
(function () {
'use strict';

const VERSION = '0.1.0';
const DPI = 203;
const DOTS_PER_MM = 8;              // 203 dpi
const LABEL_W_MM = 101.5;           // 4 in
const DOTS_PER_LINE = 812;          // 4 in at 203 dpi
const GAP_MM = 2;                   // provisional, from the USB app (die-cut gap stock)

// Services used by common BLE thermal label / receipt printers (short UUIDs expand to 0000xxxx-...).
const CANDIDATES = [
  ['49535343-fe7d-4ae5-8fa9-9fafd205e455', 'ISSC transparent UART'],
  ['000018f0-0000-1000-8000-00805f9b34fb', 'Printer service 18F0'],
  ['e7810a71-73ae-499d-8c15-faa9aef0c3f2', 'ESC/POS-TSPL BLE'],
  ['0000ff00-0000-1000-8000-00805f9b34fb', 'Vendor FF00'],
  ['0000fff0-0000-1000-8000-00805f9b34fb', 'Vendor FFF0'],
  ['0000ffe0-0000-1000-8000-00805f9b34fb', 'HM-10 UART FFE0'],
  ['0000ae30-0000-1000-8000-00805f9b34fb', 'Vendor AE30'],
  ['6e400001-b5a3-f393-e0a9-e50e24dcca9e', 'Nordic UART'],
  ['0000fee7-0000-1000-8000-00805f9b34fb', 'Vendor FEE7'],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const short = u => { const m = u.match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/); return m ? '0x' + m[1].toUpperCase() : u; };

// Same luminance threshold the preview uses; output 1 = black (app convention).
function monoFromRgba(rgba, width, height) {
  const bpr = (width + 7) >> 3, out = new Uint8Array(bpr * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const g = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    if (g < 128) out[y * bpr + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return out;
}

const ascii = s => new TextEncoder().encode(s);
function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Build a TSPL job. mono: packed rows, 1 = black. */
function buildTsplJob(mono, width, height, { density = 3, speed = 3, copies = 1, gapMm = GAP_MM } = {}) {
  const bpr = (width + 7) >> 3;
  const data = new Uint8Array(bpr * height);
  for (let i = 0; i < data.length; i++) data[i] = ~mono[i] & 0xff;   // TSPL bitmap: 1 = white
  const wMm = (width / DOTS_PER_MM).toFixed(1), hMm = (height / DOTS_PER_MM).toFixed(1);
  const head = [
    `SIZE ${wMm} mm,${hMm} mm`,
    `GAP ${gapMm} mm,0 mm`,
    `SPEED ${Math.max(1, Math.min(6, speed | 0))}`,
    `DENSITY ${Math.max(0, Math.min(15, density | 0))}`,
    'DIRECTION 0',
    'REFERENCE 0,0',
    'CLS',
    `BITMAP 0,0,${bpr},${height},0,`,
  ].join('\r\n');
  return concat([ascii(head), data, ascii(`\r\nPRINT ${Math.max(1, copies | 0)},1\r\n`)]);
}

// GATT layout used by MUNBYN's own web editor (editor.munbyn.com) for the ITPP130B:
// Microchip ISSC transparent UART. The printer also exposes a WeChat AirSync service (0xFEE7),
// which is NOT the print channel (writing there gives "GATT Error Unknown").
const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const ISSC_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
const ISSC_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3';

async function connect({ log, onStatus }) {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'ITPP130B' }, { namePrefix: 'ITPP' }, { namePrefix: 'MUNBYN' }],
    optionalServices: CANDIDATES.map(c => c[0]),
  });
  log(`Selected "${device.name || 'unnamed'}"`);
  const server = await device.gatt.connect();
  let write = null, notify = null;
  try {
    const svc = await server.getPrimaryService(ISSC_SERVICE);
    write = await svc.getCharacteristic(ISSC_WRITE);
    try { notify = await svc.getCharacteristic(ISSC_NOTIFY); } catch { /* optional */ }
    log('Using ISSC UART service (same as the MUNBYN web editor)');
  } catch (e) {
    log('ISSC service not found (' + e.message + '), scanning other services', 'warn');
    let services = [];
    try { services = await server.getPrimaryServices(); } catch (e2) { log('No known printer service: ' + e2.message, 'err'); }
    for (const s of services) {
      if (s.uuid === '0000fee7-0000-1000-8000-00805f9b34fb') continue;   // WeChat AirSync, not for printing
      let chars = [];
      try { chars = await s.getCharacteristics(); } catch { continue; }
      log(`Service ${short(s.uuid)}: ` + chars.map(c => `${short(c.uuid)}[${['write', 'writeWithoutResponse', 'notify', 'indicate'].filter(k => c.properties[k]).join(',')}]`).join(' '));
      for (const c of chars) {
        if (!write && (c.properties.write || c.properties.writeWithoutResponse)) write = c;
        if (!notify && (c.properties.notify || c.properties.indicate)) notify = c;
      }
      if (write) break;
    }
  }
  if (!write) { device.gatt.disconnect(); throw new Error('No print channel found. Send the log to add this printer\'s service.'); }
  log(`Write ${short(write.uuid)} [${['write', 'writeWithoutResponse'].filter(k => write.properties[k]).join(',')}]`);
  if (notify) {
    try {
      notify.oncharacteristicvaluechanged = ev => {
        const b = new Uint8Array(ev.target.value.buffer.slice(0));
        log('RX ' + [...b].map(x => x.toString(16).padStart(2, '0')).join(' '));
      };
      await notify.startNotifications();
    } catch { /* optional */ }
  }
  onStatus({ ready: true });
  return { device, server, write, notify, chunk: 180 };
}

async function send(conn, bytes, { mode = 'auto', rate = 20000, log = () => {}, onProgress = () => {} } = {}) {
  const ch = conn.write, p = ch.properties;
  const noResp = mode !== 'safe' && p.writeWithoutResponse;
  const t0 = performance.now();
  let sent = 0, n = 0, o = 0;
  while (o < bytes.length) {
    const part = bytes.slice(o, Math.min(o + conn.chunk, bytes.length));
    try {
      if (noResp) await ch.writeValueWithoutResponse(part); else await ch.writeValueWithResponse(part);
    } catch (e) {
      // first write too big for this link's MTU: drop to the BLE minimum and retry
      if (n === 0 && conn.chunk > 20) { conn.chunk = 20; log('Write failed with large chunks, retrying with 20 bytes', 'warn'); continue; }
      throw e;
    }
    o += part.length; sent += part.length; n++;
    if (noResp) {
      const wait = t0 + sent * 1000 / rate - performance.now();
      if (wait > 1) await sleep(wait);
    }
    if ((n & 7) === 0) onProgress(sent / bytes.length);
  }
  log(`BLE: ${n} writes of ${conn.chunk} B ${noResp ? 'without' : 'with'} response`);
  return { ms: performance.now() - t0, pacedBytes: noResp ? sent : 0, safeBytes: noResp ? 0 : sent, creditWait: 0, forced: 0 };
}

// ---------------------------------------------------------------------------
// USB through the local MUNBYN app (bridge)
// ---------------------------------------------------------------------------
const BRIDGES = [
  { name: 'ThermaLabel USB bridge', ping: 'http://127.0.0.1:5758/ping', tspl: 'http://127.0.0.1:5758/tspl' },
  { name: 'MUNBYN Label Printer app', ping: 'http://127.0.0.1:5757/api/bridge/ping', tspl: 'http://127.0.0.1:5757/api/bridge/tspl' },
];

async function bridgeConnect({ log, onStatus }) {
  for (const b of BRIDGES) {
    let info;
    try {
      const r = await fetch(b.ping, { headers: { 'X-ThermaLabel': '1' } });
      info = await r.json();
    } catch { continue; }
    if (!info.ok) { log(`${b.name} answered: ${info.error || 'error'}`, 'warn'); continue; }
    if (!info.printer) log(`${b.name}: no MUNBYN queue found in Windows`, 'warn');
    log(`${b.name} ${info.version} found, printer queue "${info.printer}"`);
    onStatus({ ready: true });
    return { device: { name: 'MUNBYN 130B (USB)' }, usb: true, bridge: b };
  }
  throw new Error('USB bridge not running. Open tools/usb_bridge/RUN_ThermaLabel_USB_Bridge_v0.1.0.bat and try again.');
}

let lastBridge = BRIDGES[0];
async function bridgeSend(bytes, { onProgress = () => {} } = {}, bridge = lastBridge) {
  const t0 = performance.now();
  onProgress(0.1);
  const r = await fetch(bridge.tspl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-ThermaLabel': '1' },
    body: bytes,
  });
  const res = await r.json().catch(() => ({}));
  if (!r.ok || !res.ok) throw new Error(bridge.name + ': ' + (res.error || 'HTTP ' + r.status));
  onProgress(1);
  return { ms: performance.now() - t0, pacedBytes: 0, safeBytes: bytes.length, creditWait: 0, forced: 0 };
}

const common = {
  protocolVersion: 'TSPL ' + VERSION,
  dotsPerLine: DOTS_PER_LINE,
  dotsPerMm: DOTS_PER_MM,
  paperWidthMm: 104,
  densities: [['2', 2], ['3 (default)', 3], ['5', 5], ['8', 8], ['12', 12], ['15', 15]],
  defaultDensity: 3,
  speeds: [1, 2, 3, 4, 5, 6],
  defaultSpeed: 3,
  defaultLengthMm: 152,
  monoFromRgba,
};

window.ThermaLabelDrivers = window.ThermaLabelDrivers || {};
window.ThermaLabelDrivers.munbyn130b_usb = {
  ...common,
  id: 'munbyn130b_usb',
  name: 'MUNBYN 130B, USB cable',
  transfers: [['usb', 'USB print queue']],
  needsBluetooth: false,
  async connect(o) { const c = await bridgeConnect(o); lastBridge = c.bridge; return c; },
  async print(conn, job, opts) {
    const bytes = buildTsplJob(job.mono, job.width, job.height, { density: opts.density, speed: opts.speed });
    const stats = await bridgeSend(bytes, opts, conn.bridge);
    stats.bytes = bytes.length;
    return stats;
  },
  // TSPL feed through the bridge = one blank label (the bridge only accepts SIZE ... PRINT jobs)
  async feed(conn) { await bridgeSend(ascii('SIZE 101.5 mm,152 mm\r\nGAP 2 mm,0 mm\r\nCLS\r\nPRINT 1,1\r\n'), {}, conn.bridge); },
  disconnect(conn) { conn?.device?.ongattserverdisconnected?.(); },
  _test: { buildTsplJob, monoFromRgba },
};

window.ThermaLabelDrivers.munbyn130b = {
  id: 'munbyn130b',
  name: 'MUNBYN 130B, Bluetooth (beta)',
  protocolVersion: 'TSPL ' + VERSION,
  dotsPerLine: DOTS_PER_LINE,
  dotsPerMm: DOTS_PER_MM,
  paperWidthMm: 104,
  densities: [['2', 2], ['3 (default)', 3], ['5', 5], ['8', 8], ['12', 12], ['15', 15]],
  defaultDensity: 3,
  speeds: [1, 2, 3, 4, 5, 6],
  defaultSpeed: 3,
  transfers: [['auto', 'Auto (no response, paced)'], ['safe', 'Safe (waits each chunk)']],
  defaultLengthMm: 152,
  monoFromRgba,
  connect,
  async print(conn, job, opts) {
    const bytes = buildTsplJob(job.mono, job.width, job.height, { density: opts.density, speed: opts.speed });
    const stats = await send(conn, bytes, { ...opts, rate: 20000 });
    stats.bytes = bytes.length;
    return stats;
  },
  async feed(conn) {
    const b = ascii('FORMFEED\r\n'), c = conn.write;
    if (c.properties.write) await c.writeValueWithResponse(b); else await c.writeValueWithoutResponse(b);
  },
  disconnect(conn) { if (conn?.device?.gatt?.connected) conn.device.gatt.disconnect(); },
  _test: { buildTsplJob, monoFromRgba },
};
})();
