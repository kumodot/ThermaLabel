/*
 * ThermaLabel main.js
 *
 * Label editor for small thermal printers over Web Bluetooth.
 * Pipeline: design (elements in mm per cell) -> canvas at the printer's native dots ->
 * exact 1-bit image (driver's own conversion) -> driver builds and sends the print job.
 *
 * CHANGELOG (newest first)
 *   0.7.1  Each label remembers the size it was designed for; layout and printer changes rescale from it,
 *          and mismatched designs (old saves, templates from another printer) fix themselves on load.
 *   0.7.0  MUNBYN 130B drivers: USB cable through a local bridge, BLE (experimental). iOS Bluefy hint. Switching printers keeps the design proportional.
 *   0.6.0  Renamed to ThermaLabel. Printer driver selector, Auto transfer mode, About dialog,
 *          repo layout without a build step.
 *   0.5.2  Paced transfer waits no longer use setTimeout. Transfer diagnostics in the log.
 *   0.5.1  Layout changes scale text reversibly.
 *   0.5.0  First label maker (TP6-S Label Maker).
 */
'use strict';

const APP_VERSION = '0.7.1';
const DRIVERS = window.ThermaLabelDrivers || {};
const PLANNED_DRIVERS = [];
let driver = DRIVERS.tp6s;
let DPM = driver.dotsPerMm;                       // dots per mm (12 = 300 dpi)
let PRINT_W_MM = driver.dotsPerLine / DPM;        // printable width (48 mm on the TP6-S)
const SNAP = 0.5;                              // mm
const STORE_CUR = 'thermalabel.current.v1';
const STORE_TPL = 'thermalabel.templates.v1';
const STORE_SET = 'thermalabel.settings.v1';
// carry over designs from the TP6-S Label Maker (0.5.x), same origin
const LEGACY = { 'thermalabel.current.v1': 'tp6s.current.v1', 'thermalabel.templates.v1': 'tp6s.templates.v1', 'thermalabel.settings.v1': 'tp6s.settings.v1' };

const FONTS = [
  { id: 'inter-400', name: 'Inter', family: 'LS Inter', weight: 400 },
  { id: 'inter-700', name: 'Inter Bold', family: 'LS Inter', weight: 700 },
  { id: 'inter-900', name: 'Inter Black', family: 'LS Inter', weight: 900 },
  { id: 'robotoc-700', name: 'Roboto Condensed Bold', family: 'LS Roboto Condensed', weight: 700 },
  { id: 'bebas', name: 'Bebas Neue', family: 'LS Bebas Neue', weight: 400 },
  { id: 'archivo', name: 'Archivo Black', family: 'LS Archivo Black', weight: 400 },
  { id: 'fredoka', name: 'Fredoka', family: 'LS Fredoka', weight: 600 },
  { id: 'caveat', name: 'Caveat (handwritten)', family: 'LS Caveat', weight: 700 },
  { id: 'marker', name: 'Permanent Marker', family: 'LS Permanent Marker', weight: 400 },
  { id: 'pacifico', name: 'Pacifico (script)', family: 'LS Pacifico', weight: 400 },
  { id: 'spacemono', name: 'Space Mono Bold', family: 'LS Space Mono', weight: 700 },
];
const fontById = id => FONTS.find(f => f.id === id) || FONTS[2];

const FRAME_STYLES = [
  ['single', 'Single line'], ['double', 'Double line'], ['dashed', 'Dashed'], ['dotted', 'Dotted'],
  ['scallop', 'Scalloped'], ['corners', 'Corner brackets'], ['ticket', 'Ticket (notched corners)'],
  ['stamp', 'Stamp (perforated)'], ['thickthin', 'Thick + thin'],
];

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const snap = v => Math.round(v / SNAP) * SNAP;
const uid = () => Math.random().toString(36).slice(2, 9);
const deep = o => JSON.parse(JSON.stringify(o));
function store(k, v) {
  try {
    if (v !== undefined) { localStorage.setItem(k, JSON.stringify(v)); return; }
    const raw = localStorage.getItem(k) ?? (LEGACY[k] ? localStorage.getItem(LEGACY[k]) : null);
    return raw == null ? null : JSON.parse(raw);
  } catch { return null; }
}

/* ---------- state ---------- */
let settings = Object.assign({ printer: 'tp6s', dateFmt: 'DD/MM', transfer: 'auto', rate: 10000, speed: driver.defaultSpeed, density: driver.defaultDensity }, store(STORE_SET) || {});
if (settings.transfer === 'paced' && !settings.transferChosen) settings.transfer = 'auto';  // 0.5.x default was paced
if (DRIVERS[settings.printer]) driver = DRIVERS[settings.printer];
let doc = null;           // { page:{lengthMm,cols,rows,gapMm,marginMm,cutLines}, cells:[{elements:[]}] }
let active = 0;           // active cell index
let selId = null;         // selected element id

function defaultDoc() {
  const d = { page: { lengthMm: driver.defaultLengthMm, cols: 1, rows: 1, gapMm: 2, marginMm: 1, cutLines: true }, cells: [{ elements: [] }] };
  const c = cellRects(d.page)[0];
  d.cells[0].elements = foodPreset(c.w, c.h);
  d.cells[0].size = { w: c.w, h: c.h };
  d.widthMm = PRINT_W_MM;
  return d;
}

// Scale a cell's elements from the size they were designed for to a new cell size.
// Geometric mean for text and corners keeps round trips exact (2x2 and back restores the original).
function scaleCell(cell, from, to) {
  const sx = to.w / from.w, sy = to.h / from.h, sm = Math.sqrt(sx * sy);
  const elements = cell.elements.map(el => {
    const c = deep(el); c.x *= sx; c.w *= sx; c.y *= sy; c.h *= sy;
    if (c.type === 'text') c.size *= sm;
    if ('radius' in c) c.radius *= sm;
    return c;
  });
  return { elements, size: { w: to.w, h: to.h } };
}

// Make every cell match the current layout. Designs saved by older versions, templates made for another
// printer width, or anything that got out of step are rescaled from the size they were made for.
function normalizeDoc(d) {
  const rects = cellRects(d.page);
  const legacyRects = cellRects(d.page, d.widthMm || 48);   // 0.5/0.6 saves were laid out on the 48 mm TP6-S
  d.cells = rects.map((r, i) => {
    const cell = d.cells[i] || { elements: deep((d.cells[0] || { elements: [] }).elements).map(e => Object.assign(e, { id: uid() })), size: d.cells[0]?.size };
    const from = cell.size || legacyRects[i] || legacyRects[0];
    if (Math.abs(from.w - r.w) < 0.01 && Math.abs(from.h - r.h) < 0.01) return { elements: cell.elements, size: { w: r.w, h: r.h } };
    return scaleCell(cell, from, r);
  });
  d.widthMm = PRINT_W_MM;
  return d;
}

/* ---------- layout ---------- */
function cellRects(p, widthMm = PRINT_W_MM) {
  const cols = clamp(p.cols | 0, 1, 6), rows = clamp(p.rows | 0, 1, 10);
  const m = +p.marginMm || 0, g = +p.gapMm || 0;
  const w = (widthMm - 2 * m - (cols - 1) * g) / cols;
  const h = (p.lengthMm - 2 * m - (rows - 1) * g) / rows;
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
    out.push({ x: m + c * (w + g), y: m + r * (h + g), w, h, i: r * cols + c });
  return out;
}

/* ---------- presets & element factories ---------- */
function foodPreset(w, h) {
  const pad = Math.min(2.4, w * 0.065);  // clears double / thick frames too
  const big = h * 0.34;
  const small = clamp(h * 0.17, 2.2, 6);
  return [
    { id: uid(), type: 'frame', x: 0, y: 0, w, h, style: 'single', stroke: 0.5, radius: Math.min(2.5, h * 0.12) },
    { id: uid(), type: 'text', field: 'Food', text: 'Black beans', font: 'inter-900', size: big, align: 'center', valign: 'middle', fit: true,
      x: pad, y: pad, w: w - 2 * pad, h: h * 0.52 - pad, invert: false, radius: 0, lineHeight: 1.05 },
    { id: uid(), type: 'line', x: pad + 1, y: h * 0.56, w: w - 2 * pad - 2, h: 0, stroke: 0.3, dash: false },
    { id: uid(), type: 'text', field: 'Made', text: 'Made {today}', font: 'inter-700', size: small, align: 'left', valign: 'middle', fit: true,
      x: pad + 0.5, y: h * 0.6, w: w * 0.48 - pad, h: h * 0.4 - pad - 0.5, invert: false, radius: 0, lineHeight: 1.05 },
    { id: uid(), type: 'text', field: 'Use by', text: 'Use by {+3}', font: 'inter-900', size: small, align: 'center', valign: 'middle', fit: true,
      x: w * 0.5, y: h * 0.6 + 0.3, w: w * 0.5 - pad - 0.5, h: h * 0.4 - pad - 1, invert: true, radius: 1.2, lineHeight: 1.05 },
  ];
}

function newElement(type, cell) {
  const w = cell.w, h = cell.h;
  const bw = Math.min(w * 0.5, 20), bh = Math.min(h * 0.5, 14);
  const base = { id: uid(), type, x: snap((w - bw) / 2), y: snap((h - bh) / 2), w: snap(bw), h: snap(bh) };
  switch (type) {
    case 'text': return Object.assign(base, { w: snap(w * 0.8), x: snap(w * 0.1), h: snap(Math.min(h * 0.35, 10)), y: snap(h * 0.3),
      text: 'Text', field: '', font: 'inter-700', size: Math.min(h * 0.3, 8), align: 'center', valign: 'middle', fit: true, invert: false, radius: 0, lineHeight: 1.1 });
    case 'rect': return Object.assign(base, { fill: false, stroke: 0.5, radius: 1.5 });
    case 'ellipse': { const s = Math.min(bw, bh); return Object.assign(base, { w: s, h: s, x: snap((w - s) / 2), y: snap((h - s) / 2), fill: true, stroke: 0.5 }); }
    case 'triangle': return Object.assign(base, { fill: true, stroke: 0.5, radius: 0.8, dir: 'up' });
    case 'line': return Object.assign(base, { h: 0, y: snap(h / 2), x: snap(w * 0.1), w: snap(w * 0.8), stroke: 0.4, dash: false, orient: 'h' });
    case 'frame': return Object.assign(base, { x: 0, y: 0, w, h, style: 'double', stroke: 0.5, radius: 2 });
  }
}

/* ---------- date tokens ---------- */
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function fmtDate(d) {
  const dd = String(d.getDate()).padStart(2, '0'), mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(2), yyyy = d.getFullYear(), mmm = MONTHS[d.getMonth()];
  switch (settings.dateFmt) {
    case 'DD/MM/YY': return `${dd}/${mm}/${yy}`;
    case 'MM/DD': return `${mm}/${dd}`;
    case 'MM/DD/YY': return `${mm}/${dd}/${yy}`;
    case 'YYYY-MM-DD': return `${yyyy}-${mm}-${dd}`;
    case 'DD MMM': return `${dd} ${mmm}`;
    case 'MMM DD': return `${mmm} ${dd}`;
    default: return `${dd}/${mm}`;
  }
}
function resolveTokens(s) {
  const now = new Date();
  return String(s ?? '').replace(/\{(today|weekday|[+-]\d{1,3})d?\}/gi, (_, t) => {
    if (/^today$/i.test(t)) return fmtDate(now);
    if (/^weekday$/i.test(t)) return WEEKDAYS[now.getDay()];
    const d = new Date(now); d.setDate(d.getDate() + parseInt(t, 10)); return fmtDate(d);
  });
}

/* ---------- drawing primitives (all in dots) ---------- */
function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function roundPolyPath(ctx, pts, r) {
  const n = pts.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
    if (i === 0) ctx.moveTo(mx, my);
    ctx.arcTo(p1[0], p1[1], (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, r);
  }
  ctx.closePath();
}
function paint(ctx, fill, strokeDots) {
  if (fill) { ctx.fillStyle = '#000'; ctx.fill(); }
  else if (strokeDots > 0) { ctx.lineWidth = strokeDots; ctx.strokeStyle = '#000'; ctx.stroke(); }
}

function drawFrame(ctx, el, X, Y, W, H) {
  const s = Math.max(1, el.stroke * DPM), r = (el.radius || 0) * DPM;
  ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; ctx.lineWidth = s;
  const ins = s / 2;
  const x = X + ins, y = Y + ins, w = W - s, h = H - s;
  switch (el.style) {
    case 'double': {
      roundRectPath(ctx, x, y, w, h, r); ctx.stroke();
      const g = s * 2.5;
      roundRectPath(ctx, x + g, y + g, w - 2 * g, h - 2 * g, Math.max(0, r - g)); ctx.stroke();
      break;
    }
    case 'thickthin': {
      ctx.lineWidth = s * 2; roundRectPath(ctx, x + s / 2, y + s / 2, w - s, h - s, r); ctx.stroke();
      ctx.lineWidth = Math.max(1, s * 0.6); const g = s * 3.2;
      roundRectPath(ctx, x + g, y + g, w - 2 * g, h - 2 * g, Math.max(0, r - g)); ctx.stroke();
      break;
    }
    case 'dashed': ctx.setLineDash([s * 4, s * 3]); roundRectPath(ctx, x, y, w, h, r); ctx.stroke(); ctx.setLineDash([]); break;
    case 'dotted': {
      const step = s * 2.6, rad = s * 0.75;
      const per = perimeterPoints(x, y, w, h, r, step);
      for (const [px, py] of per) { ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2); ctx.fill(); }
      break;
    }
    case 'scallop': {
      const bump = Math.max(s * 2.2, 10);
      const per = perimeterPoints(x + bump / 2, y + bump / 2, w - bump, h - bump, 0, bump);
      for (const [px, py] of per) { ctx.beginPath(); ctx.arc(px, py, bump / 2, 0, Math.PI * 2); ctx.stroke(); }
      // clear the inner overlap so only the outer bumps remain
      ctx.save(); ctx.fillStyle = '#fff'; ctx.fillRect(x + bump / 2 + s, y + bump / 2 + s, w - bump - 2 * s, h - bump - 2 * s); ctx.restore();
      ctx.lineWidth = s; ctx.strokeRect(x + bump / 2 + s / 2, y + bump / 2 + s / 2, w - bump - s, h - bump - s);
      break;
    }
    case 'corners': {
      const L = Math.min(w, h) * 0.28;
      ctx.lineCap = 'square';
      const seg = (pts) => { ctx.beginPath(); ctx.moveTo(...pts[0]); for (const p of pts.slice(1)) ctx.lineTo(...p); ctx.stroke(); };
      seg([[x, y + L], [x, y], [x + L, y]]);
      seg([[x + w - L, y], [x + w, y], [x + w, y + L]]);
      seg([[x + w, y + h - L], [x + w, y + h], [x + w - L, y + h]]);
      seg([[x + L, y + h], [x, y + h], [x, y + h - L]]);
      ctx.lineCap = 'butt';
      break;
    }
    case 'ticket': {
      const n = Math.max(r, Math.min(w, h) * 0.14);
      ctx.beginPath();
      ctx.moveTo(x + n, y); ctx.lineTo(x + w - n, y);
      ctx.arc(x + w, y, n, Math.PI, Math.PI / 2, true);
      ctx.lineTo(x + w, y + h - n);
      ctx.arc(x + w, y + h, n, -Math.PI / 2, Math.PI, true);
      ctx.lineTo(x + n, y + h);
      ctx.arc(x, y + h, n, 0, -Math.PI / 2, true);
      ctx.lineTo(x, y + n);
      ctx.arc(x, y, n, Math.PI / 2, 0, true);
      ctx.closePath(); ctx.stroke();
      break;
    }
    case 'stamp': {
      const hole = Math.max(s * 1.6, 6), step = hole * 2.2;
      ctx.fillRect(X, Y, W, H);
      ctx.save(); ctx.fillStyle = '#fff';
      const per = perimeterPoints(X, Y, W, H, 0, step);
      for (const [px, py] of per) { ctx.beginPath(); ctx.arc(px, py, hole / 2, 0, Math.PI * 2); ctx.fill(); }
      const inset = hole * 1.2 + s;
      roundRectPath(ctx, X + inset, Y + inset, W - 2 * inset, H - 2 * inset, r); ctx.fill();
      ctx.restore();
      break;
    }
    default: roundRectPath(ctx, x, y, w, h, r); ctx.stroke();
  }
}
// Evenly spaced points along a (rounded) rectangle perimeter.
function perimeterPoints(x, y, w, h, r, step) {
  const pts = [];
  const nx = Math.max(1, Math.round(w / step)), ny = Math.max(1, Math.round(h / step));
  for (let i = 0; i <= nx; i++) { const px = x + w * i / nx; pts.push([px, y], [px, y + h]); }
  for (let j = 1; j < ny; j++) { const py = y + h * j / ny; pts.push([x, py], [x + w, py]); }
  return pts;
}

function drawText(ctx, el, X, Y, W, H) {
  const f = fontById(el.font);
  const lines = resolveTokens(el.text).split('\n');
  const padX = el.invert ? Math.max(4, H * 0.08) : W * 0.02;
  const lh = el.lineHeight || 1.1;
  let size = Math.max(4, el.size * DPM);
  const setFont = sz => { ctx.font = `${f.weight} ${sz}px "${f.family}"`; };
  setFont(size);
  if (el.fit) {
    for (let i = 0; i < 60; i++) {
      const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
      const tall = lines.length * size * lh;
      if (widest <= W - 2 * padX && tall <= H) break;
      size *= 0.94; setFont(size);
    }
  }
  if (el.invert) {
    roundRectPath(ctx, X, Y, W, H, (el.radius || 0) * DPM);
    ctx.fillStyle = '#000'; ctx.fill();
  }
  ctx.fillStyle = el.invert ? '#fff' : '#000';
  ctx.textBaseline = 'alphabetic';
  // vertical metrics from a reference glyph set, so text sits visually centered
  const m = ctx.measureText('Hgjy');
  const asc = m.actualBoundingBoxAscent || size * 0.75, desc = m.actualBoundingBoxDescent || size * 0.2;
  const lineH = size * lh;
  const block = lineH * (lines.length - 1) + asc + desc;
  let y0;
  if (el.valign === 'top') y0 = Y + asc;
  else if (el.valign === 'bottom') y0 = Y + H - block + asc;
  else y0 = Y + (H - block) / 2 + asc;
  lines.forEach((line, i) => {
    const tw = ctx.measureText(line).width;
    let x0 = X + padX;
    if (el.align === 'center') x0 = X + (W - tw) / 2;
    else if (el.align === 'right') x0 = X + W - padX - tw;
    ctx.fillText(line, x0, y0 + i * lineH);
  });
}

function drawElement(ctx, el) {
  const X = el.x * DPM, Y = el.y * DPM, W = el.w * DPM, H = el.h * DPM;
  ctx.save();
  ctx.setLineDash([]);
  switch (el.type) {
    case 'text': drawText(ctx, el, X, Y, W, H); break;
    case 'rect': {
      const s = el.fill ? 0 : Math.max(1, el.stroke * DPM);
      roundRectPath(ctx, X + s / 2, Y + s / 2, W - s, H - s, el.radius * DPM); paint(ctx, el.fill, s); break;
    }
    case 'ellipse': {
      const s = el.fill ? 0 : Math.max(1, el.stroke * DPM);
      ctx.beginPath(); ctx.ellipse(X + W / 2, Y + H / 2, Math.max(1, (W - s) / 2), Math.max(1, (H - s) / 2), 0, 0, Math.PI * 2);
      paint(ctx, el.fill, s); break;
    }
    case 'triangle': {
      const s = el.fill ? 0 : Math.max(1, el.stroke * DPM), i = s / 2;
      const P = {
        up: [[X + W / 2, Y + i], [X + W - i, Y + H - i], [X + i, Y + H - i]],
        down: [[X + i, Y + i], [X + W - i, Y + i], [X + W / 2, Y + H - i]],
        left: [[X + i, Y + H / 2], [X + W - i, Y + i], [X + W - i, Y + H - i]],
        right: [[X + i, Y + i], [X + W - i, Y + H / 2], [X + i, Y + H - i]],
      }[el.dir || 'up'];
      roundPolyPath(ctx, P, el.radius * DPM); paint(ctx, el.fill, s); break;
    }
    case 'line': {
      const s = Math.max(1, el.stroke * DPM);
      ctx.lineWidth = s; ctx.strokeStyle = '#000';
      if (el.dash) ctx.setLineDash([s * 3, s * 2.5]);
      ctx.beginPath();
      if (el.orient === 'v') { ctx.moveTo(X, Y); ctx.lineTo(X, Y + H); } else { ctx.moveTo(X, Y); ctx.lineTo(X + W, Y); }
      ctx.stroke(); break;
    }
    case 'frame': drawFrame(ctx, el, X, Y, W, H); break;
  }
  ctx.restore();
}

/* ---------- render: design -> 576-dot canvas -> exact 1-bit preview ---------- */
const work = document.createElement('canvas');
const preview = $('#preview');
let lastMono = null;

function renderAll() {
  const p = doc.page;
  const Wd = driver.dotsPerLine, Hd = Math.max(12, Math.round(p.lengthMm * DPM));
  work.width = Wd; work.height = Hd;
  const ctx = work.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, Wd, Hd);
  const rects = cellRects(p);
  rects.forEach((c, i) => {
    const cell = doc.cells[i]; if (!cell) return;
    ctx.save();
    ctx.translate(c.x * DPM, c.y * DPM);
    ctx.beginPath(); ctx.rect(0, 0, c.w * DPM, c.h * DPM); ctx.clip();
    for (const el of cell.elements) drawElement(ctx, el);
    ctx.restore();
  });
  if (p.cutLines && (p.cols > 1 || p.rows > 1) && p.gapMm > 0) {
    ctx.save(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.setLineDash([6, 6]);
    const m = p.marginMm, g = p.gapMm, cw = rects[0].w, ch = rects[0].h;
    for (let c = 1; c < p.cols; c++) { const x = Math.round((m + c * cw + (c - 0.5) * g) * DPM) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, Hd); ctx.stroke(); }
    for (let r = 1; r < p.rows; r++) { const y = Math.round((m + r * ch + (r - 0.5) * g) * DPM) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(Wd, y); ctx.stroke(); }
    ctx.restore();
  }
  // 1-bit conversion: identical to what goes to the printer
  const rgba = ctx.getImageData(0, 0, Wd, Hd).data;
  lastMono = { mono: driver.monoFromRgba(rgba, Wd, Hd), w: Wd, h: Hd };
  preview.width = Wd; preview.height = Hd;
  const pctx = preview.getContext('2d');
  const img = pctx.createImageData(Wd, Hd);
  const bpr = (Wd + 7) >> 3, mono = lastMono.mono, d = img.data;
  for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) {
    const on = mono[y * bpr + (x >> 3)] & (0x80 >> (x & 7));
    const i = (y * Wd + x) * 4; const v = on ? 20 : 255;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  pctx.putImageData(img, 0, 0);
  $('#sizeInfo').textContent = `${PRINT_W_MM} x ${p.lengthMm} mm  |  ${p.cols} x ${p.rows} labels of ${rects[0].w.toFixed(1)} x ${rects[0].h.toFixed(1)} mm`;
}

let renderQueued = false;
function update(opts = {}) {
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderAll(); drawOverlay(); });
  }
  if (!opts.keepPanels) { renderProps(); renderQuickFill(); renderLayers(); }
  saveCurrent();
}

/* ---------- overlay: cells, selection, handles ---------- */
const overlay = $('#overlay');
const pct = (v, total) => (v / total * 100) + '%';
function selected() { return doc.cells[active]?.elements.find(e => e.id === selId) || null; }

function drawOverlay() {
  const p = doc.page, rects = cellRects(p);
  overlay.innerHTML = '';
  rects.forEach((c, i) => {
    const b = document.createElement('div');
    b.className = 'cell-box' + (i === active && rects.length > 1 ? ' active' : '');
    if (rects.length === 1) b.style.outline = 'none';
    Object.assign(b.style, { left: pct(c.x, PRINT_W_MM), top: pct(c.y, p.lengthMm), width: pct(c.w, PRINT_W_MM), height: pct(c.h, p.lengthMm) });
    overlay.appendChild(b);
  });
  const el = selected(); if (!el) return;
  const c = rects[active];
  const hMm = el.type === 'line' && el.orient !== 'v' ? 0 : el.h;
  const wMm = el.type === 'line' && el.orient === 'v' ? 0 : el.w;
  const box = document.createElement('div');
  box.className = 'sel-box';
  Object.assign(box.style, { left: pct(c.x + el.x, PRINT_W_MM), top: pct(c.y + el.y, p.lengthMm), width: pct(wMm, PRINT_W_MM), height: pct(hMm, p.lengthMm) });
  overlay.appendChild(box);
  const hs = el.type === 'line' ? (el.orient === 'v' ? [['n', 0.5, 0], ['s', 0.5, 1]] : [['w', 0, 0.5], ['e', 1, 0.5]])
    : [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]];
  for (const [k, fx, fy] of hs) {
    const h = document.createElement('div');
    h.className = 'handle'; h.dataset.h = k;
    Object.assign(h.style, { left: pct(c.x + el.x + wMm * fx, PRINT_W_MM), top: pct(c.y + el.y + hMm * fy, p.lengthMm) });
    overlay.appendChild(h);
  }
}

function eventMm(e) {
  const r = $('#printArea').getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * PRINT_W_MM, y: (e.clientY - r.top) / r.height * doc.page.lengthMm };
}
function hitTest(cellIdx, x, y) {
  const els = doc.cells[cellIdx].elements;
  const tol = 1.2;
  for (let i = els.length - 1; i >= 0; i--) {
    const e = els[i];
    const w = e.type === 'line' && e.orient === 'v' ? 0 : e.w, h = e.type === 'line' && e.orient !== 'v' ? 0 : e.h;
    if (x >= e.x - tol && x <= e.x + w + tol && y >= e.y - tol && y <= e.y + h + tol) {
      // a full-cell frame is only grabbed near its border, so inner elements stay clickable
      if (e.type === 'frame' && x > e.x + 2.5 && x < e.x + w - 2.5 && y > e.y + 2.5 && y < e.y + h - 2.5) continue;
      return e;
    }
  }
  return null;
}

let drag = null;
overlay.addEventListener('pointerdown', e => {
  e.preventDefault();
  const pt = eventMm(e);
  const rects = cellRects(doc.page);
  const handle = e.target.dataset?.h;
  if (handle && selected()) {
    const el = selected();
    drag = { mode: 'resize', h: handle, start: pt, orig: deep(el) };
  } else {
    const ci = rects.findIndex(c => pt.x >= c.x && pt.x <= c.x + c.w && pt.y >= c.y && pt.y <= c.y + c.h);
    if (ci >= 0 && ci !== active) { active = ci; selId = null; }
    if (ci >= 0) {
      const c = rects[ci];
      const hit = hitTest(ci, pt.x - c.x, pt.y - c.y);
      selId = hit ? hit.id : null;
      if (hit) drag = { mode: 'move', start: pt, orig: deep(hit) };
    } else selId = null;
  }
  overlay.setPointerCapture(e.pointerId);
  update();
});
overlay.addEventListener('pointermove', e => {
  if (!drag) return;
  const el = selected(); if (!el) return;
  const pt = eventMm(e), dx = pt.x - drag.start.x, dy = pt.y - drag.start.y, o = drag.orig;
  if (drag.mode === 'move') { el.x = snap(o.x + dx); el.y = snap(o.y + dy); }
  else {
    const h = drag.h;
    if (h.includes('w')) { const nx = snap(o.x + dx); el.w = Math.max(1, o.x + o.w - nx); el.x = o.x + o.w - el.w; }
    if (h.includes('e')) el.w = Math.max(1, snap(o.w + dx));
    if (h.includes('n')) { const ny = snap(o.y + dy); el.h = Math.max(1, o.y + o.h - ny); el.y = o.y + o.h - el.h; }
    if (h.includes('s')) el.h = Math.max(1, snap(o.h + dy));
    if (el.type === 'text' && !el.fit) el.size = Math.max(1, o.size * (el.h / Math.max(0.1, o.h)));
  }
  update({ keepPanels: true });
});
const endDrag = () => { if (drag) { drag = null; update(); } };
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

document.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  const el = selected(); if (!el) return;
  const step = e.shiftKey ? 2 : SNAP;
  if (e.key === 'Delete' || e.key === 'Backspace') { removeSelected(); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { el.x -= step; update(); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { el.x += step; update(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { el.y -= step; update(); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { el.y += step; update(); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { duplicateSelected(); e.preventDefault(); }
});

function removeSelected() {
  const cell = doc.cells[active];
  cell.elements = cell.elements.filter(x => x.id !== selId); selId = null; update();
}
function duplicateSelected() {
  const el = selected(); if (!el) return;
  const c = deep(el); c.id = uid(); c.x += 1; c.y += 1;
  doc.cells[active].elements.push(c); selId = c.id; update();
}
function moveLayer(dir) {
  const els = doc.cells[active].elements, i = els.findIndex(x => x.id === selId);
  const j = clamp(i + dir, 0, els.length - 1); if (i < 0 || i === j) return;
  [els[i], els[j]] = [els[j], els[i]]; update();
}

/* ---------- properties panel ---------- */
const TYPE_NAMES = { text: 'Text', rect: 'Rectangle', ellipse: 'Circle / ellipse', triangle: 'Triangle', line: 'Line', frame: 'Frame' };
function numField(label, key, step = 0.5, min = 0, max = 200) {
  return `<label class="field"><span>${label}</span><input type="number" data-k="${key}" step="${step}" min="${min}" max="${max}"></label>`;
}
function renderProps() {
  const el = selected(), box = $('#props');
  if (!el) { box.innerHTML = '<div class="empty">Click an element on the label, or add one from the toolbar.</div>'; return; }
  let h = `<div class="row" style="justify-content:space-between;margin-bottom:8px"><b>${TYPE_NAMES[el.type]}</b>
    <span class="row"><button class="btn ghost sm" data-act="dup">Duplicate</button><button class="btn ghost sm" data-act="del">Delete</button></span></div>`;
  h += '<div class="fields">';
  if (el.type === 'text') {
    h += `<label class="field full"><span>Text (use Enter for a new line)</span><textarea data-k="text"></textarea></label>
      <label class="field full"><span>Font</span><select data-k="font">${FONTS.map(f => `<option value="${f.id}">${f.name}</option>`).join('')}</select></label>
      ${numField('Size (mm)', 'size', 0.5, 1, 60)}
      <label class="field"><span>Align</span><select data-k="align"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
      <label class="field"><span>Vertical</span><select data-k="valign"><option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option></select></label>
      ${numField('Line height', 'lineHeight', 0.05, 0.6, 3)}
      <label class="field"><span>&nbsp;</span><label class="check"><input type="checkbox" data-k="fit"> Shrink to fit</label></label>
      <label class="field"><span>&nbsp;</span><label class="check"><input type="checkbox" data-k="invert"> White on black</label></label>
      ${numField('Box corner (mm)', 'radius', 0.25, 0, 20)}
      <label class="field"><span>Quick fill name</span><input type="text" data-k="field" placeholder="e.g. Food"></label>`;
  }
  if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'triangle') {
    h += `<label class="field"><span>&nbsp;</span><label class="check"><input type="checkbox" data-k="fill"> Filled</label></label>
      ${numField('Stroke (mm)', 'stroke', 0.1, 0.1, 10)}`;
    if (el.type !== 'ellipse') h += numField('Corner round (mm)', 'radius', 0.25, 0, 30);
    if (el.type === 'triangle') h += `<label class="field"><span>Points</span><select data-k="dir"><option value="up">Up</option><option value="down">Down</option><option value="left">Left</option><option value="right">Right</option></select></label>`;
  }
  if (el.type === 'line') {
    h += `${numField('Stroke (mm)', 'stroke', 0.1, 0.1, 10)}
      <label class="field"><span>Direction</span><select data-k="orient"><option value="h">Horizontal</option><option value="v">Vertical</option></select></label>
      <label class="field"><span>&nbsp;</span><label class="check"><input type="checkbox" data-k="dash"> Dashed</label></label>`;
  }
  if (el.type === 'frame') {
    h += `<label class="field full"><span>Style</span><select data-k="style">${FRAME_STYLES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></label>
      ${numField('Stroke (mm)', 'stroke', 0.1, 0.1, 10)}${numField('Corner round (mm)', 'radius', 0.25, 0, 30)}`;
  }
  h += `${numField('X (mm)', 'x', 0.5, -100, 200)}${numField('Y (mm)', 'y', 0.5, -100, 200)}
    ${numField('Width (mm)', 'w', 0.5, 0, 200)}${numField('Height (mm)', 'h', 0.5, 0, 200)}</div>
    <div class="row" style="margin-top:8px">
      <button class="btn ghost sm" data-act="ch">Center H</button><button class="btn ghost sm" data-act="cv">Center V</button>
      <button class="btn ghost sm" data-act="fill">Fill label</button>
      <button class="btn ghost sm" data-act="up">Forward</button><button class="btn ghost sm" data-act="down">Back</button>
    </div>`;
  box.innerHTML = h;
  box.querySelectorAll('[data-k]').forEach(inp => {
    const k = inp.dataset.k, v = el[k];
    if (inp.type === 'checkbox') inp.checked = !!v;
    else inp.value = typeof v === 'number' ? +v.toFixed(2) : (v ?? '');
    inp.addEventListener('input', () => {
      if (inp.type === 'checkbox') el[k] = inp.checked;
      else if (inp.type === 'number') { const n = parseFloat(inp.value); if (!isNaN(n)) el[k] = n; }
      else el[k] = inp.value;
      update({ keepPanels: true });
      if (k === 'text' || k === 'field') renderQuickFill();
      if (k === 'text' || k === 'field' || k === 'font') renderLayers();
    });
  });
  box.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const c = cellRects(doc.page)[active], a = b.dataset.act;
    if (a === 'del') return removeSelected();
    if (a === 'dup') return duplicateSelected();
    if (a === 'up') return moveLayer(1);
    if (a === 'down') return moveLayer(-1);
    if (a === 'ch') el.x = snap((c.w - (el.type === 'line' && el.orient === 'v' ? 0 : el.w)) / 2);
    if (a === 'cv') el.y = snap((c.h - (el.type === 'line' && el.orient !== 'v' ? 0 : el.h)) / 2);
    if (a === 'fill') { el.x = 0; el.y = 0; el.w = c.w; el.h = el.type === 'line' ? 0 : c.h; if (el.type === 'line' && el.orient === 'v') { el.w = 0; el.h = c.h; } }
    update();
  }));
}

/* ---------- quick fill ---------- */
function renderQuickFill() {
  const box = $('#quickFill');
  const els = (doc.cells[active]?.elements || []).filter(e => e.type === 'text' && e.field);
  if (!els.length) { box.innerHTML = '<div class="empty">Give a text element a "Quick fill name" to edit it here quickly.</div>'; return; }
  box.innerHTML = '';
  for (const el of els) {
    const row = document.createElement('div'); row.className = 'qrow';
    const m = String(el.text).match(/\{([+-]\d{1,3})d?\}/);
    row.innerHTML = `<span>${el.field}</span>`;
    const right = document.createElement('div');
    if (m) {
      const cur = parseInt(m[1], 10);
      right.className = 'days';
      for (const n of [1, 2, 3, 4, 5, 7, 14, 30]) {
        const b = document.createElement('button');
        b.textContent = '+' + n; if (n === cur) b.className = 'on';
        b.onclick = () => { el.text = el.text.replace(/\{([+-]\d{1,3})d?\}/, `{+${n}}`); update(); };
        right.appendChild(b);
      }
      const prev = document.createElement('span'); prev.className = 'hint'; prev.style.margin = '0 0 0 6px';
      prev.textContent = resolveTokens(el.text); right.appendChild(prev);
    } else {
      const inp = document.createElement('input'); inp.type = 'text'; inp.value = el.text;
      inp.oninput = () => { el.text = inp.value; update({ keepPanels: true }); if (selId === el.id) renderProps(); };
      right.appendChild(inp);
    }
    row.appendChild(right); box.appendChild(row);
  }
}

/* ---------- layers ---------- */
function renderLayers() {
  const box = $('#layers'), els = doc.cells[active]?.elements || [];
  if (!els.length) { box.innerHTML = '<div class="empty">This label is empty.</div>'; return; }
  box.innerHTML = '';
  [...els].reverse().forEach(el => {
    const d = document.createElement('div');
    d.className = 'layer' + (el.id === selId ? ' on' : '');
    const label = el.type === 'text' ? resolveTokens(el.text).split('\n')[0].slice(0, 28) : (el.type === 'frame' ? FRAME_STYLES.find(f => f[0] === el.style)?.[1] : '');
    d.innerHTML = `<b>${TYPE_NAMES[el.type]}</b> <span>${label || ''}</span><small>${el.w.toFixed(1)} x ${el.h.toFixed(1)}</small>`;
    d.onclick = () => { selId = el.id; update(); };
    box.appendChild(d);
  });
}

/* ---------- layout panel ---------- */
const LAYOUT_KEYS = ['lengthMm', 'cols', 'rows', 'gapMm', 'marginMm'];
function syncLayoutInputs() {
  for (const k of LAYOUT_KEYS) $('#' + k).value = doc.page[k];
  $('#cutLines').checked = !!doc.page.cutLines;
}
function applyLayout(prevRects) {
  const oldRects = Array.isArray(prevRects) ? prevRects : cellRects(doc.page);
  const np = deep(doc.page);
  np.lengthMm = clamp(parseFloat($('#lengthMm').value) || 30, 10, 200);
  np.cols = clamp(parseInt($('#cols').value) || 1, 1, 6);
  np.rows = clamp(parseInt($('#rows').value) || 1, 1, 10);
  np.gapMm = clamp(parseFloat($('#gapMm').value) || 0, 0, 10);
  np.marginMm = clamp(parseFloat($('#marginMm').value) || 0, 0, 10);
  np.cutLines = $('#cutLines').checked;
  const newRects = cellRects(np);
  if (newRects[0].w < 3 || newRects[0].h < 3) { toast('Labels would be too small'); syncLayoutInputs(); return; }
  const template = doc.cells[active] || doc.cells[0];
  const cells = [];
  for (let i = 0; i < newRects.length; i++) {
    const src = doc.cells[i] || template;
    const from = src.size || oldRects[i] || oldRects[0];   // the size this label was really designed for
    const c = scaleCell(src, from, newRects[i]);
    if (!doc.cells[i]) c.elements.forEach(e => { e.id = uid(); });
    cells.push(c);
  }
  doc.page = np; doc.cells = cells; doc.widthMm = PRINT_W_MM;
  active = clamp(active, 0, cells.length - 1); selId = null;
  update();
}

/* ---------- persistence ---------- */
let saveTimer = null;
function saveCurrent() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store(STORE_CUR, doc), 300); }
function saveSettings() { store(STORE_SET, settings); }
function templates() { return store(STORE_TPL) || {}; }
function refreshTplList() {
  const t = templates(), sel = $('#tplList');
  const names = Object.keys(t).sort();
  sel.innerHTML = names.length ? names.map(n => `<option>${n.replace(/</g, '&lt;')}</option>`).join('') : '<option value="">No saved templates</option>';
}
function validDoc(d) { return d && d.page && Array.isArray(d.cells) && d.cells.every(c => Array.isArray(c.elements)); }
function loadDoc(d) { doc = normalizeDoc(deep(d)); active = 0; selId = null; syncLayoutInputs(); update(); }

/* ---------- log, toast ---------- */
const logEl = $('#log');
function log(msg, cls = '') {
  const el = document.createElement('div'); el.className = 'l ' + cls;
  el.textContent = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
  logEl.appendChild(el); logEl.scrollTop = logEl.scrollHeight;
  while (logEl.childElementCount > 400) logEl.firstChild.remove();
}
let toastTimer = null;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }

/* ---------- printer ---------- */
let conn = null, printing = false;

function setConnUI(on) {
  $('#connDot').classList.toggle('on', on);
  $('#connText').textContent = on ? (conn?.device?.name || 'Connected') : 'Not connected';
  $('#btnConnect').hidden = on; $('#btnDisconnect').hidden = !on;
  $('#btnPrint').disabled = !on || printing; $('#btnFeed').disabled = !on || printing;
  $('#printer').disabled = on;
  $('#statusGrid').hidden = !on;
  if (!on) { $('#battChip').hidden = true; $('#alertChip').hidden = true; }
}
function showStatus(s) {
  const b = $('#battChip'); b.hidden = s.battery == null;
  b.textContent = `Battery ${s.battery ?? '?'}%${s.charging ? ' (charging)' : ''}`;
  b.className = 'chip' + ((s.battery ?? 100) < 20 ? ' warn' : '');
  $('#stBatt').textContent = (s.battery ?? '-') + '%';
  $('#stPaper').textContent = s.paperOut ? 'OUT' : 'OK';
  $('#stState').textContent = s.printing ? 'Printing' : (s.ready ? 'Ready' : 'Busy');
  const alerts = [];
  if (s.paperOut) alerts.push('Paper out');
  if (s.coverOpen) alerts.push('Cover open');
  if (s.overheat) alerts.push('Overheating');
  if (s.lowBattery) alerts.push('Low battery');
  const a = $('#alertChip'); a.hidden = !alerts.length; a.textContent = alerts.join(' | ');
}

function fillDriverControls() {
  const opt = (v, n, sel) => `<option value="${v}"${sel ? ' selected' : ''}>${n}</option>`;
  $('#printer').innerHTML = Object.values(DRIVERS).map(d => opt(d.id, d.name, d.id === driver.id)).join('') +
    PLANNED_DRIVERS.map(([v, n]) => `<option value="${v}" disabled>${n}</option>`).join('');
  $('#density').innerHTML = driver.densities.map(([n, v]) => opt(v, n, v === settings.density)).join('');
  $('#speed').innerHTML = driver.speeds.map(v => opt(v, v + (v === driver.defaultSpeed ? ' (default)' : ''), v === settings.speed)).join('');
  $('#transfer').innerHTML = driver.transfers.map(([v, n]) => opt(v, n, v === settings.transfer)).join('');
  $('#printWidthHint').textContent = `Printable width is ${PRINT_W_MM} mm, centered on the ${driver.paperWidthMm} mm roll. Each cell is one label; click a cell to edit it.`;
  $('#paper').style.setProperty('--side', ((driver.paperWidthMm - PRINT_W_MM) / 2 / driver.paperWidthMm * 100).toFixed(2) + '%');
}

async function connect() {
  if (driver.needsBluetooth !== false && !navigator.bluetooth) {
    toast('This browser has no Web Bluetooth. Use Chrome or Edge (Android, Windows, macOS) or Bluefy on iPhone.');
    log('Web Bluetooth not available in this browser', 'err'); return;
  }
  try {
    log(driver.needsBluetooth === false ? 'Connecting...' : 'Opening device chooser...');
    conn = await driver.connect({ log, onStatus: showStatus });
    conn.device.ongattserverdisconnected = () => { log('Printer disconnected', 'warn'); conn = null; setConnUI(false); };
    log(`Connected to ${conn.device.name}`, 'ok');
    setConnUI(true);
  } catch (e) {
    if (!/cancel/i.test(e.message)) { log('Connect failed: ' + e.message, 'err'); toast('Could not connect: ' + e.message); }
  }
}

async function print() {
  if (!conn || printing) return;
  renderAll();
  const copies = clamp(parseInt($('#copies').value) || 1, 1, 50);
  printing = true; setConnUI(true);
  const bar = $('#progressBar');
  try {
    for (let i = 0; i < copies; i++) {
      $('#printInfo').textContent = copies > 1 ? `Printing ${i + 1} of ${copies}...` : 'Printing...';
      const hidden0 = document.hidden;
      const st = await driver.print(conn, { mono: lastMono.mono, width: lastMono.w, height: lastMono.h }, {
        density: +settings.density, speed: +settings.speed, mode: settings.transfer, rate: +settings.rate, log,
        onProgress: f => { bar.style.width = ((i + f) / copies * 100).toFixed(1) + '%'; },
      });
      log(`Print ${i + 1}/${copies}: ${lastMono.w}x${lastMono.h} dots, ${st.bytes} bytes in ${Math.round(st.ms)} ms ` +
        `(paced ${st.pacedBytes} B, safe ${st.safeBytes} B, credit wait ${Math.round(st.creditWait)} ms` +
        `${st.forced ? `, ${st.forced} forced` : ''}${hidden0 || document.hidden ? ', window hidden' : ''})`, 'ok');
      if (i < copies - 1) await new Promise(r => setTimeout(r, 400));
    }
    bar.style.width = '100%';
    $('#printInfo').textContent = 'Done';
  } catch (e) {
    log('Print failed: ' + e.message, 'err'); toast('Print failed: ' + e.message);
    $('#printInfo').textContent = 'Failed';
  } finally {
    printing = false; setConnUI(!!conn);
    setTimeout(() => { bar.style.width = '0'; }, 1500);
  }
}

/* ---------- about ---------- */
function openAbout() { $('#about').hidden = false; $('#aboutVer').textContent = 'v' + APP_VERSION; }
function closeAbout() { $('#about').hidden = true; }

/* ---------- wire up ---------- */
function init() {
  $('#ver').textContent = 'v' + APP_VERSION;
  document.title = `ThermaLabel v${APP_VERSION}`;
  const saved = store(STORE_CUR);
  doc = validDoc(saved) ? normalizeDoc(saved) : defaultDoc();
  syncLayoutInputs();
  fillDriverControls();
  $('#dateFmt').value = settings.dateFmt;
  $('#rate').value = String(settings.rate);
  $('#year').textContent = new Date().getFullYear();
  refreshTplList();
  log(`ThermaLabel v${APP_VERSION}, driver ${driver.name} (protocol ${driver.protocolVersion})`);
  if (!navigator.bluetooth) log('This browser has no Web Bluetooth. Use Chrome/Edge, or Bluefy on iPhone.', 'warn');
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS && !navigator.bluetooth) $('#iosBanner').hidden = false;
  update();
  // re-render once the fonts are ready
  Promise.all(FONTS.map(f => document.fonts.load(`${f.weight} 20px "${f.family}"`))).then(() => update({ keepPanels: true })).catch(() => {});
}

$('#toolbar').addEventListener('click', e => {
  const b = e.target.closest('[data-add]'); if (!b) return;
  const c = cellRects(doc.page)[active], cell = doc.cells[active];
  if (b.dataset.add === 'food') { cell.elements = foodPreset(c.w, c.h); cell.size = { w: c.w, h: c.h }; selId = null; }
  else { const el = newElement(b.dataset.add, c); cell.elements.push(el); selId = el.id; }
  update();
});
for (const k of LAYOUT_KEYS) $('#' + k).addEventListener('change', () => applyLayout());
$('#cutLines').addEventListener('change', () => applyLayout());
$('#btnCopyAll').onclick = () => {
  const src = doc.cells[active].elements;
  const size = doc.cells[active].size;
  doc.cells = doc.cells.map((c, i) => i === active ? c : { elements: src.map(e => Object.assign(deep(e), { id: uid() })), size: size && { ...size } });
  toast('Copied to all labels'); update();
};
$('#btnClearCell').onclick = () => { doc.cells[active].elements = []; selId = null; update(); };

$('#btnConnect').onclick = connect;
$('#btnDisconnect').onclick = () => conn && driver.disconnect(conn);
$('#btnPrint').onclick = print;
$('#btnFeed').onclick = async () => { if (conn) { try { await driver.feed(conn); } catch (e) { log('Feed failed: ' + e.message, 'err'); } } };

$('#dateFmt').onchange = e => { settings.dateFmt = e.target.value; saveSettings(); update(); };
$('#transfer').onchange = e => { settings.transfer = e.target.value; settings.transferChosen = true; saveSettings(); };
$('#rate').onchange = e => { settings.rate = +e.target.value; saveSettings(); };
$('#speed').onchange = e => { settings.speed = +e.target.value; saveSettings(); };
$('#density').onchange = e => { settings.density = +e.target.value; saveSettings(); };

$('#btnSaveTpl').onclick = () => {
  const name = $('#tplName').value.trim(); if (!name) { toast('Type a template name first'); return; }
  const t = templates(); t[name] = deep(doc); store(STORE_TPL, t); refreshTplList(); $('#tplList').value = name; toast('Template saved');
};
$('#btnLoadTpl').onclick = () => { const t = templates()[$('#tplList').value]; if (validDoc(t)) { loadDoc(t); toast('Template loaded'); } };
$('#btnDelTpl').onclick = () => {
  const name = $('#tplList').value; if (!name) return;
  if (!confirm(`Delete template "${name}"?`)) return;
  const t = templates(); delete t[name]; store(STORE_TPL, t); refreshTplList();
};
$('#btnExport').onclick = () => {
  const data = { app: 'thermalabel', version: APP_VERSION, printer: driver.id, current: doc, templates: templates() };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `thermalabel-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$('#btnImport').onclick = () => $('#importFile').click();
$('#importFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.templates && typeof data.templates === 'object') {
      const t = templates();
      for (const [k, v] of Object.entries(data.templates)) if (validDoc(v)) t[k] = v;
      store(STORE_TPL, t); refreshTplList();
    }
    if (validDoc(data.current)) loadDoc(data.current);
    else if (validDoc(data)) loadDoc(data);
    toast('Imported');
  } catch (err) { toast('Import failed: ' + err.message); }
  e.target.value = '';
};
$('#btnReset').onclick = () => { if (confirm('Start a new design? The current one is replaced (saved templates are kept).')) loadDoc(defaultDoc()); };
$('#btnCopyLog').onclick = async () => { try { await navigator.clipboard.writeText(logEl.innerText); toast('Log copied'); } catch { toast('Copy failed'); } };
$('#btnClearLog').onclick = () => { logEl.innerHTML = ''; };
window.addEventListener('resize', () => drawOverlay());
$('#printer').onchange = e => {
  const d = DRIVERS[e.target.value]; if (!d) return;
  const prev = cellRects(doc.page);   // measured with the old printer's width
  driver = d; settings.printer = d.id; DPM = d.dotsPerMm; PRINT_W_MM = d.dotsPerLine / DPM;
  settings.density = d.defaultDensity; settings.speed = d.defaultSpeed;
  if (!d.transfers.some(t => t[0] === settings.transfer)) settings.transfer = d.transfers[0][0];
  saveSettings();
  $('#lengthMm').value = d.defaultLengthMm;
  fillDriverControls(); applyLayout(prev);
};
$('#btnAbout').onclick = openAbout;
$('#btnCopyUrl').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); toast('Link copied. Paste it in Bluefy.'); }
  catch { toast(location.href); }
};
$('#about').addEventListener('click', e => { if (e.target.id === 'about' || e.target.closest('[data-close]')) closeAbout(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAbout(); });

init();
