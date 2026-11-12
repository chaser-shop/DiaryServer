/*
 * Легкі SVG-графіки без залежностей: лінійні, стовпчикові (у т. ч. з накопиченням і від’ємними значеннями)
 * та міні-графіки. Charts.line()/bars() повертають заготовку; Charts.mount() малює її під фактичну ширину
 * контейнера (і перемальовує при зміні розміру), тож підписи лишаються чіткими на телефоні й комп’ютері.
 */
(function (root, factory) {
  root.Charts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const configs = new Map();
  let seq = 0;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const numFmt = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });
  const fmtDefault = (v) => (v == null ? '—' : numFmt.format(v).replace(/\u00a0/g, ' '));

  function niceStep(span, ticks) {
    const raw = span / Math.max(1, ticks);
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  }

  function scale(min, max, ticks, opts) {
    const o = opts || {};
    if (o.zero) { min = Math.min(0, min); max = Math.max(0, max); }
    if (min === max) { const pad = Math.abs(min) * 0.1 || 1; min -= pad; max += pad; }
    let step = niceStep(max - min, ticks || 4);
    if (o.integer) step = Math.max(1, Math.round(step));
    let lo = Math.floor(min / step) * step;
    // floor: нижня межа шкали (наприклад, місце в рейтингу не буває меншим за 1).
    if (o.floor != null && lo < o.floor) lo = o.floor;
    const hi = lo + Math.max(1, Math.ceil((max - lo) / step - 1e-9)) * step;
    const out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1000) / 1000);
    return { min: lo, max: hi, ticks: out };
  }

  function placeholder(type, cfg) {
    const id = 'c' + (++seq);
    configs.set(id, Object.assign({ type: type }, cfg));
    return `<div class="chart" data-cid="${id}" style="height:${cfg.height || 220}px" role="img" aria-label="${esc(cfg.label || '')}"></div>`;
  }

  const empty = (el, cfg) => { el.innerHTML = `<div class="chart-empty">${esc(cfg.empty || 'Даних для графіка ще немає')}</div>`; };

  function xLabelIndexes(n, pw) {
    const max = Math.max(2, Math.floor(pw / 62));
    const step = Math.max(1, Math.ceil(n / max));
    const out = [];
    for (let i = 0; i < n; i += step) out.push(i);
    if (out[out.length - 1] !== n - 1) {
      // Останню мітку показуємо завжди; попередню прибираємо, щоб підписи не накладалися.
      if (out.length > 1) out.pop();
      out.push(n - 1);
    }
    return out;
  }

  function axes(sc, y, fmt, w, padL, padR) {
    return sc.ticks.map((t) => `<line class="grid" x1="${padL}" x2="${w - padR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>` +
      `<text class="ylab" x="${padL - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(t))}</text>`).join('');
  }

  function drawLine(el, cfg, w) {
    const H = el.clientHeight || cfg.height || 220;
    const labels = cfg.labels || [];
    const n = labels.length;
    const series = (cfg.series || []).filter((s) => s.values && s.values.some((v) => v != null));
    if (!n || !series.length) return empty(el, cfg);
    const fmt = cfg.format || fmtDefault;
    const vals = series.flatMap((s) => s.values.filter((v) => v != null));
    const sc = scale(Math.min.apply(null, vals), Math.max.apply(null, vals), cfg.ticks || 4, { zero: !!cfg.zero, integer: !!cfg.integer, floor: cfg.min });
    const padL = 44; const padR = 14; const padT = 14; const padB = 28;
    const pw = Math.max(10, w - padL - padR);
    const ph = Math.max(10, H - padT - padB);
    const x = (i) => padL + (n === 1 ? pw / 2 : (i * pw) / (n - 1));
    const y = (v) => {
      const k = (v - sc.min) / (sc.max - sc.min || 1);
      return cfg.invert ? padT + k * ph : padT + ph - k * ph;
    };
    let svg = axes(sc, y, fmt, w, padL, padR);
    svg += xLabelIndexes(n, pw).map((i) => `<text class="xlab" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(labels[i])}</text>`).join('');
    series.forEach((s, si) => {
      const color = s.color || 'var(--accent)';
      const segs = [];
      let cur = [];
      s.values.forEach((v, i) => {
        if (v == null) { if (cur.length) segs.push(cur); cur = []; return; }
        cur.push([x(i), y(v)]);
      });
      if (cur.length) segs.push(cur);
      if (cfg.area && si === 0) {
        const gid = el.dataset.cid + 'g';
        svg += `<defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:${color};stop-opacity:.22"/><stop offset="1" style="stop-color:${color};stop-opacity:0"/></linearGradient></defs>`;
        const base = cfg.invert ? padT : padT + ph;
        for (const seg of segs) {
          if (seg.length < 2) continue;
          svg += `<path d="M${seg[0][0].toFixed(1)},${base} L${seg.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L')} L${seg[seg.length - 1][0].toFixed(1)},${base} Z" style="fill:url(#${gid})" stroke="none"/>`;
        }
      }
      for (const seg of segs) {
        if (seg.length > 1) svg += `<path class="ln" d="M${seg.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L')}" style="stroke:${color}"/>`;
        if (seg.length === 1 || n <= 45) svg += seg.map((p) => `<circle class="dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${seg.length === 1 ? 4 : 2.6}" style="fill:${color}"/>`).join('');
      }
    });
    el.innerHTML = `<svg width="${w}" height="${H}" viewBox="0 0 ${w} ${H}">${svg}<line class="guide" y1="${padT}" y2="${padT + ph}" x1="-10" x2="-10" display="none"/></svg><div class="chart-tip" hidden></div>`;
    hover(el, { n, x, pw, padL, labels: cfg.tipLabels || labels, series, fmt, y });
  }

  function drawBars(el, cfg, w) {
    const H = el.clientHeight || cfg.height || 220;
    const labels = cfg.labels || [];
    const n = labels.length;
    const series = (cfg.series || []).filter((s) => s.values && s.values.length);
    if (!n || !series.length || !series.some((s) => s.values.some((v) => v))) return empty(el, cfg);
    const fmt = cfg.format || fmtDefault;
    const stacked = !!cfg.stacked;
    const totals = labels.map((_, i) => series.reduce((a, s) => a + (stacked ? Math.max(0, s.values[i] || 0) : 0), 0));
    const vals = stacked ? totals : series.flatMap((s) => s.values.filter((v) => v != null));
    const sc = scale(Math.min.apply(null, vals.concat(0)), Math.max.apply(null, vals.concat(0)), cfg.ticks || 4, { zero: true, integer: !!cfg.integer });
    const padL = 44; const padR = 10; const padT = 12; const padB = 28;
    const pw = Math.max(10, w - padL - padR);
    const ph = Math.max(10, H - padT - padB);
    const slot = pw / n;
    const groupW = Math.min(44, slot * 0.66);
    const per = stacked ? 1 : series.length;
    const bw = Math.max(2, groupW / per);
    const y = (v) => padT + ph - ((v - sc.min) / (sc.max - sc.min || 1)) * ph;
    const x = (i) => padL + slot * i + slot / 2;
    let svg = axes(sc, y, fmt, w, padL, padR);
    svg += `<line class="zero" x1="${padL}" x2="${w - padR}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>`;
    svg += xLabelIndexes(n, pw).map((i) => `<text class="xlab" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(labels[i])}</text>`).join('');
    for (let i = 0; i < n; i++) {
      let acc = 0;
      series.forEach((s, si) => {
        const v = s.values[i];
        if (v == null || v === 0) return;
        const color = cfg.signed && series.length === 1 ? (v >= 0 ? cfg.posColor || 'var(--green)' : cfg.negColor || 'var(--red)') : s.color || 'var(--accent)';
        let top; let bottom;
        if (stacked) { bottom = y(acc); acc += Math.max(0, v); top = y(acc); } else { top = y(Math.max(0, v)); bottom = y(Math.min(0, v)); }
        const bx = stacked ? x(i) - groupW / 2 : x(i) - groupW / 2 + si * bw;
        const hgt = Math.max(1.5, bottom - top);
        svg += `<rect class="bar" x="${bx.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, bw - (per > 1 ? 2 : 0)).toFixed(1)}" height="${hgt.toFixed(1)}" rx="${Math.min(5, bw / 3).toFixed(1)}" style="fill:${color}"/>`;
      });
    }
    el.innerHTML = `<svg width="${w}" height="${H}" viewBox="0 0 ${w} ${H}">${svg}<rect class="band" y="${padT}" height="${ph}" x="-100" width="${slot.toFixed(1)}" display="none"/></svg><div class="chart-tip" hidden></div>`;
    hover(el, { n, x, pw, padL, slot, labels: cfg.tipLabels || labels, series, fmt, bars: true, total: stacked && series.length > 1 ? totals : null });
  }

  function hover(el, g) {
    const svg = el.querySelector('svg');
    const tip = el.querySelector('.chart-tip');
    const guide = svg.querySelector('.guide');
    const band = svg.querySelector('.band');
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ev.clientX - r.left;
      const i = g.bars ? Math.floor((px - g.padL) / g.slot) : Math.round(((px - g.padL) / (g.pw || 1)) * (g.n - 1));
      if (i < 0 || i >= g.n || Number.isNaN(i)) { tip.hidden = true; return; }
      const cx = g.x(i);
      if (guide) { guide.setAttribute('x1', cx); guide.setAttribute('x2', cx); guide.removeAttribute('display'); }
      if (band) { band.setAttribute('x', (cx - g.slot / 2).toFixed(1)); band.removeAttribute('display'); }
      const rows = g.series.map((s) => `<div><i style="background:${s.color || 'var(--accent)'}"></i>${s.name ? esc(s.name) + ': ' : ''}<b>${esc(g.fmt(s.values[i]))}</b></div>`).join('');
      tip.innerHTML = `<div class="tt">${esc(g.labels[i])}</div>${rows}${g.total ? `<div class="tsum">Разом: <b>${esc(g.fmt(g.total[i]))}</b></div>` : ''}`;
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(Math.max(4, cx - tw / 2), r.width - tw - 4) + 'px';
    };
    const leave = () => {
      tip.hidden = true;
      if (guide) guide.setAttribute('display', 'none');
      if (band) band.setAttribute('display', 'none');
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', leave);
  }

  function mount(scope) {
    const rootEl = scope || document;
    rootEl.querySelectorAll('.chart[data-cid]').forEach((el) => {
      const cfg = configs.get(el.dataset.cid);
      if (!cfg) return;
      const w = Math.round(el.clientWidth);
      if (!w || el._w === w) return;
      el._w = w;
      (cfg.type === 'line' ? drawLine : drawBars)(el, cfg, w);
    });
    if (configs.size > 150) {
      for (const id of [...configs.keys()]) if (!document.querySelector(`[data-cid="${id}"]`)) configs.delete(id);
    }
  }

  let resizeTimer = null;
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => mount(), 160);
    });
  }

  /** Міні-графік для карток (без осей). */
  function spark(values, opts) {
    const o = opts || {};
    const w = o.width || 120;
    const h = o.height || 36;
    const pts = (values || []).map((v, i) => [i, v]).filter((p) => p[1] != null);
    if (!pts.length) return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
    const vs = pts.map((p) => p[1]);
    const min = Math.min.apply(null, vs);
    const max = Math.max.apply(null, vs);
    const n = Math.max(1, values.length - 1);
    const X = (i) => 2 + (i / n) * (w - 4);
    const Y = (v) => (max === min ? h / 2 : 3 + (1 - (v - min) / (max - min)) * (h - 6));
    const color = o.color || 'var(--accent)';
    if (pts.length === 1) return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><circle cx="${w - 4}" cy="${h / 2}" r="3" style="fill:${color}"/></svg>`;
    const d = pts.map((p, k) => (k ? 'L' : 'M') + X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ');
    const last = pts[pts.length - 1];
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}" style="stroke:${color}" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="2.8" style="fill:${color}"/></svg>`;
  }

  return {
    line: (cfg) => placeholder('line', cfg),
    bars: (cfg) => placeholder('bars', cfg),
    spark, mount, scale,
  };
});
