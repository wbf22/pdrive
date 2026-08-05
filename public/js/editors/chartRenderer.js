/**
 * Chart rendering for the CSV editor.
 *
 * Pure drawing + value-parsing helpers: everything here works on plain values
 * and returns a <canvas>, so the CSV editor only has to collect cell ranges
 * and hand them over. Charts are exported as JPEG (see canvasToJpegBase64).
 */

const CURRENCY_CHARS = '$\u20ac\u00a3\u00a5\u20b9\u20bd\u20a9\u20aa\u20ba\u00a2';
const CURRENCY_CODES = ['usd', 'eur', 'gbp', 'jpy', 'cad', 'aud', 'chf', 'cny', 'inr', 'nzd', 'sek', 'zar'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MS_SECOND = 1000;
const MS_MINUTE = 60 * MS_SECOND;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;
const MS_YEAR = 365.2425 * MS_DAY;

export const PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948',
  '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac', '#86bcb6', '#d37295',
];

// ----- Value parsing -------------------------------------------------

/**
 * Parse a raw cell string into a plottable value.
 * Accepts plain numbers, currency amounts and dates.
 * Returns { kind: 'number' | 'date', value: Number } or null when the value
 * isn't one of those (the caller turns that into a user-facing error).
 */
export function parseCellValue(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const num = parseNumeric(s);
  if (num !== null) return { kind: 'number', value: num };

  const date = parseDateValue(s);
  if (date !== null) return { kind: 'date', value: date };

  return null;
}

function parseNumeric(input) {
  let t = input.replace(/\s+/g, '');
  let negative = false;

  // Accounting style negatives: (1,234.00)
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }

  // Strip currency symbols / ISO codes from either end.
  const symbolRe = new RegExp(`^[${CURRENCY_CHARS}]+|[${CURRENCY_CHARS}]+$`, 'g');
  t = t.replace(symbolRe, '');
  const lower = t.toLowerCase();
  for (const code of CURRENCY_CODES) {
    if (lower.startsWith(code) && t.length > code.length) { t = t.slice(code.length); break; }
    if (lower.endsWith(code) && t.length > code.length) { t = t.slice(0, -code.length); break; }
  }

  if (t.startsWith('-')) { negative = !negative; t = t.slice(1); }
  else if (t.startsWith('+')) { t = t.slice(1); }
  t = t.replace(symbolRe, '');

  if (!t) return null;
  // Grouped (1,234,567.89), plain (1234.89) or leading-dot (.5) numbers only.
  if (!/^(\d{1,3}(,\d{3})+(\.\d+)?|\d+(\.\d+)?|\.\d+)$/.test(t)) return null;

  const value = parseFloat(t.replace(/,/g, ''));
  if (!isFinite(value)) return null;
  return negative ? -value : value;
}

function parseDateValue(input) {
  const s = input.trim();

  // ISO-ish: 2024-03-07 / 2024/3/7 (optionally with a time)
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return utcFromParts(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));

  // US style: 3/7/2024 or 3-7-2024
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return utcFromParts(+m[3], +m[1], +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));

  // Month-name forms ("7 Mar 2024", "March 7, 2024"). Require a 4-digit year
  // so bare words like "May" aren't silently treated as dates.
  if (/[a-zA-Z]/.test(s) && /\b\d{4}\b/.test(s)) {
    const parsed = Date.parse(s);
    if (!isNaN(parsed)) {
      const d = new Date(parsed);
      return utcFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate(),
        d.getHours(), d.getMinutes(), d.getSeconds());
    }
  }
  return null;
}

function utcFromParts(y, mo, d, h = 0, mi = 0, s = 0) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

// ----- Formatting ----------------------------------------------------

export function formatNumber(value, step) {
  if (!isFinite(value)) return '';
  if (Object.is(value, -0)) value = 0;
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-4)) {
    return value.toExponential(2).replace('e', 'e');
  }
  let decimals;
  if (step && isFinite(step) && step > 0) {
    decimals = Math.min(6, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  } else {
    decimals = abs >= 100 ? 0 : abs >= 1 ? 2 : 4;
  }
  const fixed = value.toFixed(decimals);
  const [intPart, fracPart] = fixed.split('.');
  const sign = intPart.startsWith('-') ? '-' : '';
  const digits = sign ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + grouped + (fracPart ? '.' + fracPart : '');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDateLabel(ms, unit) {
  const d = new Date(ms);
  switch (unit) {
    case 'year': return String(d.getUTCFullYear());
    case 'month': return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    case 'day': return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
    default: return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  }
}

// ----- Axis / tick maths ---------------------------------------------

function niceStep(rough) {
  if (!(rough > 0) || !isFinite(rough)) return 1;
  const exp = Math.floor(Math.log10(rough));
  const frac = rough / Math.pow(10, exp);
  let nice;
  if (frac <= 1) nice = 1;
  else if (frac <= 2) nice = 2;
  else if (frac <= 5) nice = 5;
  else nice = 10;
  return nice * Math.pow(10, exp);
}

/**
 * Build an axis (bounds + labelled gridline ticks) for a value range.
 * Throws when a log scale is requested for non-positive data.
 */
export function computeAxis(dataMin, dataMax, { log = false, kind = 'number', target = 8, name = 'Axis' } = {}) {
  if (log) {
    if (!(dataMin > 0)) {
      throw new Error(`${name}: log scale needs every value to be greater than zero`);
    }
    let lo = Math.floor(Math.log10(dataMin));
    let hi = Math.ceil(Math.log10(dataMax));
    if (hi <= lo) hi = lo + 1;
    const decades = hi - lo;
    const mults = decades <= 1 ? [1, 2, 3, 4, 5, 6, 7, 8, 9]
      : decades <= 3 ? [1, 2, 5]
        : decades <= 8 ? [1] : [1];
    const skip = decades > 8 ? Math.ceil(decades / 8) : 1;
    const ticks = [];
    for (let e = lo; e <= hi; e += skip) {
      for (const m of mults) {
        const v = m * Math.pow(10, e);
        if (v < Math.pow(10, lo) * (1 - 1e-9) || v > Math.pow(10, hi) * (1 + 1e-9)) continue;
        // Passing the tick as its own "step" gives just enough decimals:
        // 1000 → "1,000", 1 → "1", 0.05 → "0.05".
        ticks.push({ value: v, label: formatNumber(v, v) });
      }
    }
    return { min: Math.pow(10, lo), max: Math.pow(10, hi), ticks, log: true, kind };
  }

  if (kind === 'date') return computeDateAxis(dataMin, dataMax, target);

  let min = dataMin;
  let max = dataMax;
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const step = niceStep((max - min) / target);
  min = Math.floor(min / step + 1e-9) * step;
  max = Math.ceil(max / step - 1e-9) * step;
  const count = Math.max(1, Math.round((max - min) / step));
  const ticks = [];
  for (let i = 0; i <= count; i++) {
    const v = min + i * step;
    ticks.push({ value: v, label: formatNumber(v, step) });
  }
  return { min, max, ticks, log: false, kind };
}

function computeDateAxis(dataMin, dataMax, target) {
  let min = dataMin;
  let max = dataMax;
  if (min === max) { min -= MS_DAY; max += MS_DAY; }
  const rough = (max - min) / target;

  // Year-scale ticks
  if (rough >= MS_YEAR / 2) {
    const y0 = new Date(min).getUTCFullYear();
    const y1 = new Date(max).getUTCFullYear();
    const stepY = Math.max(1, Math.round(niceStep(Math.max(1, (y1 - y0) / target))));
    const startY = Math.floor(y0 / stepY) * stepY;
    const ticks = [];
    for (let y = startY; ; y += stepY) {
      const v = Date.UTC(y, 0, 1);
      ticks.push({ value: v, label: formatDateLabel(v, 'year') });
      if (v >= max) break;
      if (ticks.length > 400) break;
    }
    return { min: ticks[0].value, max: ticks[ticks.length - 1].value, ticks, log: false, kind: 'date' };
  }

  // Month-scale ticks — month boundaries read better than 14-day steps once a
  // chart spans more than a couple of months.
  if (rough >= 10 * MS_DAY) {
    const start = new Date(min);
    const monthsSpan = (max - min) / (MS_YEAR / 12);
    const choices = [1, 2, 3, 6];
    const wanted = monthsSpan / target;
    const stepM = choices.find(c => c >= wanted) || 6;
    let mIndex = start.getUTCFullYear() * 12 + start.getUTCMonth();
    mIndex = Math.floor(mIndex / stepM) * stepM;
    const ticks = [];
    for (; ; mIndex += stepM) {
      const v = Date.UTC(Math.floor(mIndex / 12), mIndex % 12, 1);
      ticks.push({ value: v, label: formatDateLabel(v, 'month') });
      if (v >= max) break;
      if (ticks.length > 400) break;
    }
    return { min: ticks[0].value, max: ticks[ticks.length - 1].value, ticks, log: false, kind: 'date' };
  }

  const intervals = [
    [MS_SECOND, 'time'], [5 * MS_SECOND, 'time'], [15 * MS_SECOND, 'time'], [30 * MS_SECOND, 'time'],
    [MS_MINUTE, 'time'], [5 * MS_MINUTE, 'time'], [15 * MS_MINUTE, 'time'], [30 * MS_MINUTE, 'time'],
    [MS_HOUR, 'time'], [3 * MS_HOUR, 'time'], [6 * MS_HOUR, 'time'], [12 * MS_HOUR, 'time'],
    [MS_DAY, 'day'], [2 * MS_DAY, 'day'], [7 * MS_DAY, 'day'], [14 * MS_DAY, 'day'],
  ];
  const chosen = intervals.find(([ms]) => ms >= rough) || intervals[intervals.length - 1];
  const [iv, unit] = chosen;
  const start = Math.floor(min / iv) * iv;
  const end = Math.ceil(max / iv) * iv;
  const ticks = [];
  for (let v = start; v <= end + iv * 1e-9; v += iv) {
    ticks.push({ value: v, label: formatDateLabel(v, unit) });
    if (ticks.length > 400) break;
  }
  return { min: start, max: end, ticks, log: false, kind: 'date' };
}

function projector(axis, pxLow, pxHigh) {
  if (axis.log) {
    const lo = Math.log10(axis.min);
    const hi = Math.log10(axis.max);
    const span = hi - lo || 1;
    return (v) => pxLow + ((Math.log10(v) - lo) / span) * (pxHigh - pxLow);
  }
  const span = axis.max - axis.min || 1;
  return (v) => pxLow + ((v - axis.min) / span) * (pxHigh - pxLow);
}

// ----- XY chart ------------------------------------------------------

/**
 * Draw a scatter / line chart.
 * opts: { title, xLabel, yLabel, logX, logY, style: 'points'|'lines'|'both',
 *         points: [{x, y}], xKind, yKind, color }
 */
export function renderXYChart(opts) {
  const {
    title = '', xLabel = '', yLabel = '',
    logX = false, logY = false, style = 'lines',
    points = [], xKind = 'number', yKind = 'number',
    color = PALETTE[0],
  } = opts;

  if (!points.length) throw new Error('No data points to plot');

  const W = 1000;
  const H = 640;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';

  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const xAxis = computeAxis(Math.min(...xs), Math.max(...xs), { log: logX, kind: xKind, target: 8, name: 'X axis' });
  const yAxis = computeAxis(Math.min(...ys), Math.max(...ys), { log: logY, kind: yKind, target: 7, name: 'Y axis' });

  // Layout — the left margin grows to fit the widest Y tick label.
  ctx.font = '13px sans-serif';
  let widestY = 0;
  for (const t of yAxis.ticks) widestY = Math.max(widestY, ctx.measureText(t.label).width);
  const top = title ? 62 : 26;
  const left = Math.ceil(widestY) + 18 + (yLabel ? 26 : 0);
  const right = W - 28;
  const xTickH = 22;
  const bottom = H - 20 - xTickH - (xLabel ? 26 : 0);

  const px = projector(xAxis, left, right);
  const py = projector(yAxis, bottom, top);

  // Title
  if (title) {
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, (left + right) / 2, top - 32);
  }

  // Gridlines + tick labels
  ctx.font = '13px sans-serif';
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#d9d9d9';
  ctx.fillStyle = '#444444';

  ctx.textAlign = 'right';
  for (const t of yAxis.ticks) {
    const y = Math.round(py(t.value)) + 0.5;
    if (y < top - 1 || y > bottom + 1) continue;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillText(t.label, left - 9, y);
  }

  // Rotate X labels when they'd otherwise collide.
  let widestX = 0;
  for (const t of xAxis.ticks) widestX = Math.max(widestX, ctx.measureText(t.label).width);
  const rotateX = (widestX + 12) * xAxis.ticks.length > (right - left);
  for (const t of xAxis.ticks) {
    const x = Math.round(px(t.value)) + 0.5;
    if (x < left - 1 || x > right + 1) continue;
    ctx.strokeStyle = '#d9d9d9';
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.fillStyle = '#444444';
    if (rotateX) {
      ctx.save();
      ctx.translate(x, bottom + 10);
      ctx.rotate(-Math.PI / 5);
      ctx.textAlign = 'right';
      ctx.fillText(t.label, 0, 4);
      ctx.restore();
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(t.label, x, bottom + 14);
    }
  }

  // Axis lines
  ctx.strokeStyle = '#555555';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(left + 0.5, top);
  ctx.lineTo(left + 0.5, bottom + 0.5);
  ctx.lineTo(right, bottom + 0.5);
  ctx.stroke();

  // Axis titles
  ctx.fillStyle = '#222222';
  ctx.font = '15px sans-serif';
  if (xLabel) {
    ctx.textAlign = 'center';
    ctx.fillText(xLabel, (left + right) / 2, H - 16);
  }
  if (yLabel) {
    ctx.save();
    ctx.translate(16, (top + bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }

  // Series
  const drawLines = style === 'lines' || style === 'both';
  const drawPoints = style === 'points' || style === 'both';

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top - 4, right - left, bottom - top + 8);
  ctx.clip();

  if (drawLines && points.length > 1) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = px(p.x);
      const y = py(p.y);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  if (drawPoints) {
    ctx.fillStyle = color;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(px(p.x), py(p.y), 4.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();

  return canvas;
}

// ----- Pie chart -----------------------------------------------------

/**
 * Draw a pie chart. slices: [{ label, value }] — values must be >= 0.
 */
export function renderPieChart({ title = '', slices = [] } = {}) {
  if (!slices.length) throw new Error('No values to plot');
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (!(total > 0)) throw new Error('The values add up to zero — nothing to chart');

  const W = 1000;
  const H = 640;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'middle';

  if (title) {
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, W / 2, 36);
  }

  const top = title ? 70 : 30;
  const cx = 300;
  const cy = top + (H - top - 20) / 2;
  const radius = Math.min(230, (H - top - 40) / 2);

  let angle = -Math.PI / 2;
  slices.forEach((slice, i) => {
    const sweep = (slice.value / total) * Math.PI * 2;
    const fill = PALETTE[i % PALETTE.length];
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Percentage inside the slice when there's room for it.
    if (sweep > 0.28) {
      const mid = angle + sweep / 2;
      const lx = cx + Math.cos(mid) * radius * 0.65;
      const ly = cy + Math.sin(mid) * radius * 0.65;
      const pct = `${((slice.value / total) * 100).toFixed(1)}%`;
      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.strokeText(pct, lx, ly);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(pct, lx, ly);
    }
    angle += sweep;
  });

  // Legend
  const legendX = 610;
  const rowH = Math.min(30, Math.max(16, (H - top - 40) / slices.length));
  const fontSize = Math.max(11, Math.min(15, rowH - 12));
  let ly = Math.max(top + 8, cy - (slices.length * rowH) / 2);
  ctx.textAlign = 'left';
  // Keep the legend's decimals consistent across every row.
  const valueStep = slices.every(s => Number.isInteger(s.value)) ? 1 : 0.01;
  slices.forEach((slice, i) => {
    if (ly > H - 24) return;
    ctx.fillStyle = PALETTE[i % PALETTE.length];
    ctx.fillRect(legendX, ly + rowH / 2 - 7, 14, 14);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(legendX, ly + rowH / 2 - 7, 14, 14);
    ctx.fillStyle = '#222222';
    ctx.font = `${fontSize}px sans-serif`;
    const pct = ((slice.value / total) * 100).toFixed(1);
    const label = truncate(ctx, slice.label || '(blank)', 210);
    ctx.fillText(`${label}  —  ${formatNumber(slice.value, valueStep)} (${pct}%)`, legendX + 22, ly + rowH / 2);
    ly += rowH;
  });

  return canvas;
}

function truncate(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

// ----- Output --------------------------------------------------------

function createCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/** Base64 JPEG payload (no data: prefix) ready for the write API. */
export function canvasToJpegBase64(canvas, quality = 0.92) {
  const url = canvas.toDataURL('image/jpeg', quality);
  return url.slice(url.indexOf(',') + 1);
}
