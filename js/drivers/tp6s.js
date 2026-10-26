/*
 * ThermaLabel driver: Vretti TP6-S (BLE name "TP6-S")
 *
 * Protocol (reverse engineered for interoperability, validated byte for byte against the
 * vendor library in an emulator, see docs/PROTOCOL_TP6S.md):
 *   64 | cmd | seq | len u16 LE | payload | 00 00 00 00 | 9B
 *   job = set speed, set density, image rows (4 x 72 bytes per message), feed
 *
 * Transport (see docs/TRANSFER_NOTES.md):
 *   paced = 20-byte writes without response, FF03 credits, byte-rate cap
 *   safe  = 180-byte writes with response
 *   auto  = start paced, switch to safe mid-stream when credits come back slowly
 *           (default Windows link), keep paced on fast links (Android, macOS, Windows + boost)
 *
 * Registers window.ThermaLabelDrivers.tp6s
 */
(function () {
'use strict';

/*
 * tp6s_protocol.js  v1.0.0
 *
 * Vretti TP6-S (BLE name "TP6-S") print protocol, reimplemented from
 * XLife Pro 3.18.1 (com.printer.printer.pocket.PrinterTwoInch ->
 * libykDataPacket.so getPrintSepImgWithTypeCommand("EM_300DPI_2INCH", ...)).
 *
 * No dependencies. Works in browsers (Web Bluetooth) and Node (for tests).
 * The image path for this printer uses NO compression, NO checksum and NO crypto:
 * every message is  64 | cmd | seq | lenLo lenHi | payload | 00 00 00 00 | 9B
 * (see TP6S_PROTOCOL.md for the full spec and the evidence behind each byte).
 */

const TP6S = Object.freeze({
  VERSION: '1.0.0',
  // GATT (com.yk.helper.YKBleManager.UUID_CUS)
  SERVICE_UUID: '0000ff00-0000-1000-8000-00805f9b34fb',
  WRITE_UUID: '0000ff02-0000-1000-8000-00805f9b34fb',   // app writes here (write WITH response)
  NOTIFY_UUID: '0000ff01-0000-1000-8000-00805f9b34fb',  // app subscribes here (status / replies)
  AUX_NOTIFY_UUID: '0000ff03-0000-1000-8000-00805f9b34fb', // not used by the app for TP6-S
  // config "EM_300DPI_2INCH" (getPrinterConfigByName in libykDataPacket.so)
  DOTS_PER_LINE: 576,        // dotsNum
  BYTES_PER_LINE: 72,        // 576 / 8
  LINES_PER_PACKET: 4,       // pkgLength
  DOTS_PER_MM: 12,           // pointsPerMM (~300 dpi)
  FEED_DOTS: 172,            // feed (sent after every image)
  CONFIG_SPEED: 50,          // used only when the given speed is out of range
  CONFIG_DENSITY: 12,        // used only when the given density is out of range
  APP_SPEED: 85,             // PrinterTwoInch.r0() for TP6_S
  // PrintConfig$DensityType.DENSITY_7_12_15 (PrinterUtils.O): level 1 / 2 / 3
  DENSITY_BY_LEVEL: Object.freeze({ 1: 7, 2: 12, 3: 15 }),
});

// Message types (CusMsgType values seen in libykDataPacket.so)
const CMD = Object.freeze({
  IMAGE_ROWS: 0x00,      // cusGetImgPrintDataWithPaddingOffsetR -> cusPkgMsg(type@0x1abdc8 = 0)
  FEED: 0x02,            // AstraP1::feedPaper, payload u16 LE dots
  SET_AUTO_OFF: 0x08,    // getSetAutoOffTimeCommand, payload u8
  SET_DENSITY: 0x09,     // AstraP1::setDensity, payload u8 (0..15)
  SET_SPEED: 0x0a,       // AstraP1::setSpeed, payload u8 (0..255)
  GET_STATUS: 0x10,      // getPrinterStatusCommand
  GET_FIRMWARE: 0x11,    // getFirmwareVersionCommand
  GET_SN: 0x12,          // first part of getSnCommand
  QUERY_17: 0x17,        // getSnCommand also sends 17[10] and 17[01]
  GET_PAPER_TYPE: 0x72,  // getPaperTypeCommand, payload [01]
  BLE_TOKEN: 0x80,       // getBleTokenBytesCommand, payload [01] (sent right after MTU exchange)
  STATUS_REPORT: 0xff,   // printer -> host heartbeat (every ~5 s on FF01)
});

// ---------------------------------------------------------------------------
// Sequence counter: libykDataPacket keeps ONE global 6-bit counter (byte at
// .bss 0x1abdcc) that is pre-incremented for every message it builds:
// seq = (seq + 1) & 0x3f. The first message after load has seq = 1.
// ---------------------------------------------------------------------------
let _seq = 0;
function setSequence(n) { _seq = n & 0x3f; }
function getSequence() { return _seq; }
function nextSeq() { _seq = (_seq + 1) & 0x3f; return _seq; }

/** Build one framed message (cusPkgMsg @0xe1f20). */
function packMsg(cmd, payload = new Uint8Array(0), seq = nextSeq()) {
  const p = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  const len = p.length & 0xffff;
  const out = new Uint8Array(len + 10);
  out[0] = 0x64;
  out[1] = cmd & 0xff;
  out[2] = seq & 0x3f;
  out[3] = len & 0xff;
  out[4] = len >> 8;
  out.set(p.subarray(0, len), 5);
  // out[5+len .. 8+len] = 00 00 00 00 (checksum slot, left zero by the app)
  out[len + 9] = 0x9b;
  return out;
}

function concat(list) {
  let n = 0;
  for (const a of list) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

// --- simple commands (byte-identical to the native getters) ---------------
const cmdBleToken = () => packMsg(CMD.BLE_TOKEN, [0x01]);
const cmdGetSn = () => concat([
  packMsg(CMD.GET_SN), packMsg(CMD.QUERY_17, [0x10]), packMsg(CMD.QUERY_17, [0x01])]);
const cmdGetFirmwareVersion = () => packMsg(CMD.GET_FIRMWARE);
const cmdGetPrinterStatus = () => packMsg(CMD.GET_STATUS);
const cmdGetPaperType = () => packMsg(CMD.GET_PAPER_TYPE, [0x01]);
const cmdSetAutoOffTime = (code) => packMsg(CMD.SET_AUTO_OFF, [code & 0xff]);
const cmdSetSpeed = (v) => packMsg(CMD.SET_SPEED, [v & 0xff]);
const cmdSetDensity = (v) => packMsg(CMD.SET_DENSITY, [v & 0xff]);
const cmdFeed = (dots) => packMsg(CMD.FEED, [dots & 0xff, (dots >> 8) & 0xff]);

/**
 * Messages the app writes right after connecting (PrinterManager):
 *   onMtuChanged -> YkBleDataSplitManager.setCurMtu -> getBleTokenBytesCommand
 *   +100 ms  -> PrinterCus.t()  = getSnCommand (3 messages)
 *   +200 ms  -> PrinterCus.w()  = getFirmwareVersionCommand
 * Returned as [{delayMs, bytes}] relative to the moment notifications + MTU are ready.
 */
function buildConnectSequence() {
  return [
    { delayMs: 0, bytes: cmdBleToken() },
    { delayMs: 100, bytes: cmdGetSn() },
    { delayMs: 200, bytes: cmdGetFirmwareVersion() },
  ];
}

// --- image -----------------------------------------------------------------

/**
 * Convert RGBA pixels to packed 1-bpp rows exactly like the native
 * cusConvertImgDataWithPadding (@0xe21f0):
 *   gray = (R*171>>9) + (G*171>>9) + (B*171>>9);  black when gray < 128.
 * Alpha is ignored (a transparent pixel with RGB 0,0,0 prints black!).
 * Output: MSB-first, 1 = black, ceil(w/8) bytes per row.
 */
function rgbaToMonoRows(rgba, width, height) {
  const bpr = (width + 7) >> 3;
  const out = new Uint8Array(bpr * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const g = ((rgba[i] * 171) >> 9) + ((rgba[i + 1] * 171) >> 9) + ((rgba[i + 2] * 171) >> 9);
      if (g < 128) out[y * bpr + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/**
 * Place packed rows (ceil(widthDots/8) bytes per row, MSB-first, 1=black) into
 * 576-dot printer lines. Like the app: RIGHT-aligned (left padding = 576 - width);
 * if wider than 576 the LEFT part is cropped. The app always scales the bitmap to
 * 576 px wide first (YkUtil.scalingBitmap), so normally width == 576.
 */
function toPrinterLines(mono, widthDots, heightDots) {
  const W = TP6S.DOTS_PER_LINE, BPL = TP6S.BYTES_PER_LINE;
  const srcBpr = (widthDots + 7) >> 3;
  const out = new Uint8Array(BPL * heightDots);
  const pad = W - widthDots;
  if (pad === 0 && srcBpr === BPL) { out.set(mono.subarray(0, out.length)); return out; }
  for (let y = 0; y < heightDots; y++) {
    for (let x = 0; x < W; x++) {
      const sx = x - pad;
      if (sx < 0 || sx >= widthDots) continue;
      if (mono[y * srcBpr + (sx >> 3)] & (0x80 >> (sx & 7))) out[y * BPL + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/**
 * Build the complete print job for one label/page, byte-identical to
 * YkDataPacket.getPrintImgWithTypeCommand("EM_300DPI_2INCH", bmp, 85, density, isFirst, isLast, false, 0, 0, 576, true).
 *
 * @param {Uint8Array} mono   packed rows, ceil(widthDots/8) bytes each, MSB first, 1 = black
 * @param {number} widthDots  normally 576
 * @param {number} heightDots number of rows (any value, no padding to 4)
 * @param {object} opts {density (0..15, default 12), speed (10..255, default 85),
 *                       feedDots (default 172), isFirst, isLast (accepted, no effect
 *                       for this printer config)}
 * @returns {{packets: Uint8Array[], bytes: Uint8Array}}
 */
function buildTp6sPrintJob(mono, widthDots, heightDots, opts = {}) {
  let speed = opts.speed ?? TP6S.APP_SPEED;
  let density = opts.density ?? TP6S.CONFIG_DENSITY;
  const feed = opts.feedDots ?? TP6S.FEED_DOTS;
  // native (pkgPrintLabelWithConfig @0xd2008): a speed outside 10..255 or a density
  // outside 0..15 is replaced by the config default (setSpeed 50 / setDensity 12)
  if (!(speed >= 10 && speed <= 255)) speed = TP6S.CONFIG_SPEED;
  if (!(density >= 0 && density <= 15)) density = TP6S.CONFIG_DENSITY;

  const packets = [];
  packets.push(cmdSetSpeed(speed));
  packets.push(cmdSetDensity(density));
  const lines = toPrinterLines(mono, widthDots, heightDots);
  const chunk = TP6S.LINES_PER_PACKET * TP6S.BYTES_PER_LINE; // 288 bytes
  for (let o = 0; o < lines.length; o += chunk) {
    packets.push(packMsg(CMD.IMAGE_ROWS, lines.subarray(o, Math.min(o + chunk, lines.length))));
  }
  if (feed >= 1) packets.push(cmdFeed(feed));
  return { packets, bytes: concat(packets) };
}

/** Convenience: RGBA (e.g. canvas ImageData.data) straight to a job. */
function buildTp6sPrintJobFromRgba(rgba, width, height, opts = {}) {
  return buildTp6sPrintJob(rgbaToMonoRows(rgba, width, height), width, height, opts);
}

// --- incoming messages -----------------------------------------------------

/** Checksum the printer puts in its own messages (cusCalChecksum @0xe0a90):
 *  0x12345678 + sum(bytes[0 .. len-6]) + 0x9B, stored LE in bytes[len-5 .. len-2]. */
function calcChecksum(frame) {
  let s = 0x12345678;
  for (let i = 0; i < frame.length - 5; i++) s += frame[i];
  s += frame[frame.length - 1];
  return s >>> 0;
}

/** Split a notification buffer into frames (64 .. 9B with valid length). */
function splitFrames(buf) {
  const frames = [];
  let i = 0;
  while (i + 10 <= buf.length) {
    if (buf[i] !== 0x64) { i++; continue; }
    const len = buf[i + 3] | (buf[i + 4] << 8);
    const end = i + len + 10;
    if (end > buf.length) break;
    if (buf[end - 1] === 0x9b) { frames.push(buf.subarray(i, end)); i = end; } else i++;
  }
  return frames;
}

/**
 * Decode one printer frame. For the 18-byte status heartbeat (cmd 0xFF, payload 8 bytes)
 * the field layout follows cusUnpkgPrinterStatus (@0xe8ce4) + YkPrinterInfo field names.
 */
function parseFrame(f) {
  const len = f[3] | (f[4] << 8);
  const payload = f.subarray(5, 5 + len);
  const stored = (f[5 + len] | (f[6 + len] << 8) | (f[7 + len] << 16) | (f[8 + len] << 24)) >>> 0;
  const res = { cmd: f[1], seq: f[2], payload, checksumOk: stored === calcChecksum(f) };
  if (f.length === 17 || f.length === 18) {
    const raw = (payload[0] | (payload[1] << 8)) << 16 >> 16; // int16
    const flags = payload[2] | (payload[3] << 8);
    const b = (n) => !!(flags & (1 << n));
    res.status = {
      voltageRaw: raw,
      voltage: raw * 3340 * 280 / 409600, // float the app stores in YkPrinterInfo.voltage
      isTurnOn: b(0), isCutterReady: b(0), isBtConnected: b(1), isCharging: b(2),
      isPrinting: b(3), isSuspent: b(4), isUsbBusy: b(5), isBtBusy: b(6),
      isMotorOutSync: b(7), isUncap: b(8), isLowBattery: b(9), isOverHeating: b(10),
      isPaperOut: b(11), isAllowPrint: b(12), isValidPaper: b(13), isUpgrading: b(14),
      isUsbConnected: b(15), isPaperLoaded: b(15),
      density: payload[4], autoOffTime: payload[5], speed: payload[6],
      batteryPercentage: f.length === 18 ? payload[7] : null,
    };
  }
  return res;
}

// --- Web Bluetooth transport -----------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Write a byte stream like YkBleDataSplitManager does: cut it into chunks of
 * (MTU - 3) bytes regardless of message boundaries and write them one after the
 * other WITH response (BluetoothGatt.writeCharacteristic, default write type;
 * the next chunk only goes after onCharacteristicWrite). The app asks for MTU 512;
 * Web Bluetooth cannot choose the MTU, so keep chunks small (printer reports 192
 * on FF03 -> 189 max; 180 is a safe default).
 */
async function writeStream(characteristic, bytes, { chunkSize = 180, withResponse = true, gapMs = 0 } = {}) {
  for (let o = 0; o < bytes.length; o += chunkSize) {
    const part = bytes.slice(o, Math.min(o + chunkSize, bytes.length));
    if (withResponse && characteristic.writeValueWithResponse) await characteristic.writeValueWithResponse(part);
    else if (!withResponse && characteristic.writeValueWithoutResponse) await characteristic.writeValueWithoutResponse(part);
    else await characteristic.writeValue(part);
    if (gapMs) await sleep(gapMs);
  }
}

/** Connect + replicate the app's connect-time traffic. Returns {device, server, write, notify}. */
async function connectTp6s({ onFrame, onStatus, filters } = {}) {
  const device = await navigator.bluetooth.requestDevice({
    filters: filters ?? [{ namePrefix: 'TP6' }],
    optionalServices: [TP6S.SERVICE_UUID],
  });
  const server = await device.gatt.connect();
  const svc = await server.getPrimaryService(TP6S.SERVICE_UUID);
  const write = await svc.getCharacteristic(TP6S.WRITE_UUID);
  const notify = await svc.getCharacteristic(TP6S.NOTIFY_UUID);
  let pending = new Uint8Array(0);
  notify.addEventListener('characteristicvaluechanged', (ev) => {
    const v = new Uint8Array(ev.target.value.buffer.slice(0));
    const buf = new Uint8Array(pending.length + v.length);
    buf.set(pending); buf.set(v, pending.length);
    const frames = splitFrames(buf);
    let used = 0;
    for (const f of frames) {
      used = f.byteOffset - buf.byteOffset + f.length;
      const p = parseFrame(f);
      onFrame?.(p);
      if (p.status) onStatus?.(p.status);
    }
    pending = buf.slice(used);
    if (pending.length > 4096) pending = new Uint8Array(0);
  });
  await notify.startNotifications();
  let t = 0;
  for (const step of buildConnectSequence()) {
    if (step.delayMs > t) { await sleep(step.delayMs - t); t = step.delayMs; }
    await writeStream(write, step.bytes);
  }
  return { device, server, write, notify };
}

/** Print one page. mono = packed rows (576 wide normally). */
async function printTp6s(conn, mono, widthDots, heightDots, opts = {}) {
  const job = buildTp6sPrintJob(mono, widthDots, heightDots, opts);
  await writeStream(conn.write, job.bytes, opts);
  return job;
}


// ---------------------------------------------------------------------------
// Precise waits that background/efficiency throttling doesn't stretch
// (MessageChannel callbacks are not clamped like setTimeout).
// ---------------------------------------------------------------------------
const mc = new MessageChannel(); const mcQueue = [];
mc.port1.onmessage = () => { const r = mcQueue.shift(); if (r) r(); };
const yieldMC = () => new Promise(r => { mcQueue.push(r); mc.port2.postMessage(0); });
async function waitUntil(deadline) { while (performance.now() < deadline) await yieldMC(); }

const PACED_SIZE = 20;      // BLE chip limit for writes without response (40+ makes it power off)
const SAFE_SIZE = 180;      // write with response, below the 192 MTU the chip reports
// Auto mode: a safe-mode 180 B round trip on a slow Windows link takes ~190 ms (~950 B/s).
// If paced throughput after the probe window is below this, safe is faster.
const AUTO_PROBE_PACKETS = 60;
const AUTO_MIN_PACED_BPS = 1500;

async function connect({ log, onStatus }) {
  setSequence(0);
  const flow = { credits: 0, mtu: 0, seen: false };
  const conn = await connectTp6s({
    filters: [{ namePrefix: 'TP6' }, { namePrefix: 'eTP6' }],
    onFrame: f => { if (f.cmd !== CMD.STATUS_REPORT) log(`RX cmd 0x${f.cmd.toString(16)} [${[...f.payload].map(b => b.toString(16).padStart(2, '0')).join(' ')}]`); },
    onStatus: s => onStatus({
      battery: s.batteryPercentage, charging: s.isCharging, paperOut: s.isPaperOut, coverOpen: s.isUncap,
      overheat: s.isOverHeating, lowBattery: s.isLowBattery, printing: s.isPrinting, ready: s.isAllowPrint,
    }),
  });
  try {
    const svc = await conn.server.getPrimaryService(TP6S.SERVICE_UUID);
    const aux = await svc.getCharacteristic(TP6S.AUX_NOTIFY_UUID);
    aux.oncharacteristicvaluechanged = ev => {
      const b = new Uint8Array(ev.target.value.buffer.slice(0));
      if (b[0] === 0x01 && b.length >= 2) { flow.credits += b[1]; flow.seen = true; }
      else if (b[0] === 0x02 && b.length >= 3) flow.mtu = b[1] | (b[2] << 8);
    };
    await aux.startNotifications();
  } catch (e) { log('FF03 flow control unavailable: ' + e.message, 'warn'); }
  conn.flow = flow;
  return conn;
}

async function takeCredit(flow, stats, log) {
  if (flow.credits > 0) { flow.credits--; return; }
  const t0 = performance.now();
  while (flow.credits <= 0) {
    if (performance.now() - t0 > 1000) { flow.credits = 1; stats.forced++; log('No credit for 1 s, forcing one', 'warn'); break; }
    await yieldMC();
  }
  stats.creditWait += performance.now() - t0;
  flow.credits--;
}

/**
 * Send a job. mode: 'auto' | 'paced' | 'safe'. Returns a stats object.
 * Safe and paced can be mixed mid-job because the printer reads one continuous byte stream.
 */
async function send(conn, bytes, { mode = 'auto', rate = 10000, log = () => {}, onProgress = () => {} } = {}) {
  const ch = conn.write, flow = conn.flow;
  const stats = { mode, creditWait: 0, paceWait: 0, forced: 0, switchedAt: null, pacedBytes: 0, safeBytes: 0 };
  let usePaced = (mode === 'paced' || mode === 'auto') && flow.seen;
  if (mode !== 'safe' && !flow.seen) log('No FF03 credits seen, using safe transfer', 'warn');
  const t0 = performance.now();
  let o = 0, n = 0, pacedStart = t0;
  while (o < bytes.length) {
    if (usePaced) {
      await takeCredit(flow, stats, log);
      const end = Math.min(o + PACED_SIZE, bytes.length);
      await ch.writeValueWithoutResponse(bytes.slice(o, end));
      stats.pacedBytes += end - o; o = end; n++;
      const deadline = pacedStart + stats.pacedBytes * 1000 / rate;
      if (deadline > performance.now()) { const w0 = performance.now(); await waitUntil(deadline); stats.paceWait += performance.now() - w0; }
      if (mode === 'auto' && n === AUTO_PROBE_PACKETS) {
        const bps = stats.pacedBytes / ((performance.now() - pacedStart) / 1000);
        if (bps < AUTO_MIN_PACED_BPS) {
          usePaced = false; stats.switchedAt = o;
          log(`Auto: paced runs at ${Math.round(bps)} B/s on this link, switching to safe`);
        } else log(`Auto: paced runs at ${Math.round(bps)} B/s, keeping it`);
      }
    } else {
      const end = Math.min(o + SAFE_SIZE, bytes.length);
      await ch.writeValueWithResponse(bytes.slice(o, end));
      stats.safeBytes += end - o; o = end;
    }
    if ((n & 15) === 0 || !usePaced) onProgress(o / bytes.length);
  }
  stats.ms = performance.now() - t0;
  return stats;
}

window.ThermaLabelDrivers = window.ThermaLabelDrivers || {};
window.ThermaLabelDrivers.tp6s = {
  id: 'tp6s',
  name: 'Vretti TP6-S (panda)',
  protocolVersion: TP6S.VERSION,
  dotsPerLine: TP6S.DOTS_PER_LINE,     // 576
  dotsPerMm: TP6S.DOTS_PER_MM,         // 12 (300 dpi)
  paperWidthMm: 57,
  densities: [['Light', 7], ['Medium', 12], ['Dark', 15]],
  defaultDensity: 12,
  speeds: [50, 85, 120, 180, 255],
  defaultSpeed: TP6S.APP_SPEED,
  transfers: [['auto', 'Auto (recommended)'], ['paced', 'Paced (fast links)'], ['safe', 'Safe (waits each chunk)']],
  defaultLengthMm: 30,
  monoFromRgba: rgbaToMonoRows,
  connect,
  async print(conn, job, opts) {
    const built = buildTp6sPrintJob(job.mono, job.width, job.height, { density: opts.density, speed: opts.speed });
    const stats = await send(conn, built.bytes, opts);
    stats.bytes = built.bytes.length;
    return stats;
  },
  async feed(conn) { await conn.write.writeValueWithResponse(cmdFeed(TP6S.FEED_DOTS)); },
  disconnect(conn) { if (conn?.device?.gatt?.connected) conn.device.gatt.disconnect(); },
  // exposed for self-tests
  _test: { buildTp6sPrintJob, rgbaToMonoRows, setSequence, packMsg, parseFrame, send },
};
})();
