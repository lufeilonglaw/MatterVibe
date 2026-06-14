// toolbox.js —— MatterVibe 律师工具箱（独立窗口页面）
// 全部本地纯 JS 计算，无任何外部 API，断网可用；输入即算，无需点按钮

'use strict';

/* ============================================================
   通用
   ============================================================ */
function tbCopy(text, btn) {
  const done = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = '已复制 ✓';
    btn.classList.add('saved-flash');
    setTimeout(() => { btn.textContent = old; btn.classList.remove('saved-flash'); }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  done();
}

const fmt = n => Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const yuan = n => fmt(Math.round(n * 100) / 100) + ' 元';

/* ============================================================
   法定节假日与调休数据（依据国务院办公厅通知，内嵌离线）
   2025：国办发明电〔2024〕16号；2026：国办发明电〔2025〕7号
   ============================================================ */
function spanDates(from, to, name, map) {
  const d = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (d <= end) {
    map[d.toISOString().slice(0, 10)] = name;
    d.setDate(d.getDate() + 1);
  }
}

const CN_HOLIDAYS = {};
// —— 2025 ——
spanDates('2025-01-01', '2025-01-01', '元旦', CN_HOLIDAYS);
spanDates('2025-01-28', '2025-02-04', '春节假期', CN_HOLIDAYS);
spanDates('2025-04-04', '2025-04-06', '清明节假期', CN_HOLIDAYS);
spanDates('2025-05-01', '2025-05-05', '劳动节假期', CN_HOLIDAYS);
spanDates('2025-05-31', '2025-06-02', '端午节假期', CN_HOLIDAYS);
spanDates('2025-10-01', '2025-10-08', '国庆中秋假期', CN_HOLIDAYS);
// —— 2026 ——
spanDates('2026-01-01', '2026-01-03', '元旦假期', CN_HOLIDAYS);
spanDates('2026-02-15', '2026-02-23', '春节假期', CN_HOLIDAYS);
spanDates('2026-04-04', '2026-04-06', '清明节假期', CN_HOLIDAYS);
spanDates('2026-05-01', '2026-05-05', '劳动节假期', CN_HOLIDAYS);
spanDates('2026-06-19', '2026-06-21', '端午节假期', CN_HOLIDAYS);
spanDates('2026-09-25', '2026-09-27', '中秋节假期', CN_HOLIDAYS);
spanDates('2026-10-01', '2026-10-07', '国庆节假期', CN_HOLIDAYS);

// 调休补班的周六/周日（按工作日处理）
const CN_WORKDAYS = new Set([
  // 2025
  '2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11',
  // 2026
  '2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'
]);

const HOLIDAY_RANGE = ['2025-01-01', '2026-12-31'];

const iso = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const inHolidayRange = d => { const s = iso(d); return s >= HOLIDAY_RANGE[0] && s <= HOLIDAY_RANGE[1]; };

// 该日不是工作日的原因；是工作日则返回 null
function nonWorkReason(d) {
  const s = iso(d);
  if (CN_WORKDAYS.has(s)) return null;             // 调休补班日
  if (CN_HOLIDAYS[s]) return CN_HOLIDAYS[s];       // 法定节假日（含调休放假）
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return '休息日';
  return null;
}

// 届满日逢节假日/休息日顺延至其后第一个工作日
function extendForHolidays(end) {
  const reasons = [];
  const d = new Date(end);
  let guard = 0;
  while (guard++ < 90) {
    const r = nonWorkReason(d);
    if (!r) break;
    reasons.push(r);
    d.setDate(d.getDate() + 1);
  }
  return { date: d, extended: +d !== +end, reasons: [...new Set(reasons)] };
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${p(d.getMonth() + 1)}月${p(d.getDate())}日（周${WEEK[d.getDay()]}）`;
}

/* ============================================================
   费用算法
   ============================================================ */
// 诉讼费：《诉讼费用交纳办法》财产案件受理费十段累进
const COURT_TIERS = [
  [10000, null, 50], [100000, 0.025], [200000, 0.02], [500000, 0.015],
  [1000000, 0.01], [2000000, 0.009], [5000000, 0.008],
  [10000000, 0.007], [20000000, 0.006], [Infinity, 0.005]
];

function calcCourtFee(amount) {
  const lines = [];
  let fee = 0, prev = 0;
  for (const [cap, rate, flat] of COURT_TIERS) {
    if (amount <= prev) break;
    if (flat !== undefined && rate === null) {
      fee += flat;
      lines.push(`不超过 1 万元部分：${yuan(flat)}`);
    } else {
      const seg = Math.min(amount, cap) - prev;
      const f = seg * rate;
      fee += f;
      const capTxt = cap === Infinity ? ' 元以上' : `–${fmt(cap)} 元`;
      lines.push(`${fmt(prev)}${capTxt} 部分 × ${(rate * 100).toFixed(1)}%：${yuan(f)}`);
    }
    prev = cap;
  }
  return { fee, lines };
}

// 保全费：≤1000 元 30 元；1 千–10 万部分 1%；超 10 万部分 0.5%；上限 5000 元
function calcPreservationFee(amount) {
  if (!amount || amount <= 1000) return 30;
  let fee = 30 + (Math.min(amount, 100000) - 1000) * 0.01;
  if (amount > 100000) fee += (amount - 100000) * 0.005;
  return Math.min(fee, 5000);
}

// 律师费（风险代理 / 按标的比例分段累进），分段可编辑
const DEFAULT_LAWYER_TIERS = [
  { cap: 100000, min: 8, max: 10 },
  { cap: 1000000, min: 5, max: 7 },
  { cap: 5000000, min: 3, max: 5 },
  { cap: 10000000, min: 2, max: 3 },
  { cap: 50000000, min: 1, max: 2 },
  { cap: Infinity, min: 0.5, max: 1 }
];

function calcLawyerFee(amount, tiers, minFee) {
  let low = 0, high = 0, prev = 0;
  const lines = [];
  for (const t of tiers) {
    if (amount <= prev) break;
    const seg = Math.min(amount, t.cap) - prev;
    low += seg * t.min / 100;
    high += seg * t.max / 100;
    const capTxt = t.cap === Infinity ? ' 元以上' : `–${fmt(t.cap)} 元`;
    lines.push(`${fmt(prev)}${capTxt} 部分 × ${t.min}%–${t.max}%`);
    prev = t.cap;
  }
  if (low < minFee) low = minFee;
  if (high < minFee) high = minFee;
  return { low, high, lines };
}

// 仲裁费（费率表可编辑可保存，落段式：基数 + 超过下限部分 × 比例）
const DEFAULT_ARB_SCHEDULES = {
  cietac: {
    name: '中国国际经济贸易仲裁委员会（CIETAC·国内案件）',
    note: '预填为通行流传的费用表（二）版本。官网费用表为图片，未能逐数核对，首次使用前请按 cietac.org「费用快算」核准并在下方修正，修正将保存在本机。',
    acceptance: [
      { cap: 1000, base: 100, rate: 0 }, { cap: 50000, base: 100, rate: 5 },
      { cap: 100000, base: 2550, rate: 4 }, { cap: 200000, base: 4550, rate: 3 },
      { cap: 500000, base: 7550, rate: 2 }, { cap: 1000000, base: 13550, rate: 1 },
      { cap: Infinity, base: 18550, rate: 0.5 }
    ],
    processing: [
      { cap: 200000, base: 6000, rate: 0 }, { cap: 500000, base: 6000, rate: 2 },
      { cap: 1000000, base: 12000, rate: 1.5 }, { cap: 5000000, base: 19500, rate: 0.5 },
      { cap: 10000000, base: 39500, rate: 0.45 }, { cap: Infinity, base: 62000, rate: 0.4 }
    ]
  },
  bac: {
    name: '北京仲裁委员会（BAC／BIAC）',
    note: '受理费分段为北仲官网公布标准（已核对）；处理费预填为通行流传版本，请按 bjac.org.cn「仲裁费用」核准并修正，修正将保存在本机。',
    acceptance: [
      { cap: 1000, base: 100, rate: 0 }, { cap: 50000, base: 100, rate: 5 },
      { cap: 100000, base: 2550, rate: 4 }, { cap: 200000, base: 4550, rate: 3 },
      { cap: 500000, base: 7550, rate: 2 }, { cap: 1000000, base: 13550, rate: 1 },
      { cap: Infinity, base: 18550, rate: 0.3 }
    ],
    processing: [
      { cap: 200000, base: 5000, rate: 0 }, { cap: 500000, base: 5000, rate: 1 },
      { cap: 1000000, base: 8000, rate: 0.8 }, { cap: 5000000, base: 12000, rate: 0.5 },
      { cap: 10000000, base: 32000, rate: 0.4 }, { cap: Infinity, base: 52000, rate: 0.3 }
    ]
  }
};

const infReplacer = (k, v) => (v === Infinity ? 'INF' : v);
const infReviver = (k, v) => (v === 'INF' ? Infinity : v);
const deepCopySched = obj => JSON.parse(JSON.stringify(obj, infReplacer), infReviver);

let arbSchedules = null;

async function loadArbSchedules() {
  try {
    const saved = await window.api.getSetting('arb_schedules');
    arbSchedules = saved ? JSON.parse(saved, infReviver) : deepCopySched(DEFAULT_ARB_SCHEDULES);
  } catch (_) {
    arbSchedules = deepCopySched(DEFAULT_ARB_SCHEDULES);
  }
}
async function saveArbSchedules() {
  await window.api.setSetting('arb_schedules', JSON.stringify(arbSchedules, infReplacer));
}

function calcByBracket(amount, tiers) {
  let prev = 0;
  for (const t of tiers) {
    if (amount <= t.cap) return t.base + (amount - prev) * t.rate / 100;
    prev = t.cap;
  }
  const last = tiers[tiers.length - 1];
  return last.base + (amount - prev) * last.rate / 100;
}

/* ============================================================
   人民币大写（标准跨组补零算法）
   ============================================================ */
function rmbUpper(n) {
  if (isNaN(n)) return '';
  if (Math.abs(n) > 999999999999.99) return '金额过大（最大支持千亿级）';
  const digits = '零壹贰叁肆伍陆柒捌玖';
  const units = ['', '拾', '佰', '仟'];
  let neg = '';
  if (n < 0) { neg = '负'; n = -n; }
  n = Math.round(n * 100) / 100;
  const intPart = Math.floor(n);
  const cents = Math.round((n - intPart) * 100);
  const jiao = Math.floor(cents / 10);
  const fen = cents % 10;

  const groupStr = (g) => {
    let out = '', zero = false;
    const s4 = String(g).padStart(4, '0');
    for (let i = 0; i < 4; i++) {
      const d = +s4[i];
      if (d === 0) { if (out) zero = true; continue; }
      if (zero) { out += '零'; zero = false; }
      out += digits[d] + units[3 - i];
    }
    return out;
  };

  let intStr = '';
  if (intPart === 0) {
    intStr = '零';
  } else {
    let s = String(intPart);
    const groups = [];
    while (s.length > 0) { groups.unshift(s.slice(-4)); s = s.slice(0, -4); }
    const bigUnits = ['', '万', '亿'];
    let zeroPending = false;
    groups.forEach((g, gi) => {
      const gv = parseInt(g, 10);
      const unit = bigUnits[groups.length - 1 - gi];
      if (gv === 0) { if (intStr) zeroPending = true; return; }
      if (intStr && (zeroPending || g[0] === '0')) intStr += '零';
      intStr += groupStr(gv) + unit;
      zeroPending = false;
    });
  }

  let out = neg + intStr + '元';
  if (jiao === 0 && fen === 0) out += '整';
  else {
    if (jiao > 0) out += digits[jiao] + '角';
    else if (fen > 0 && intPart > 0) out += '零';
    if (fen > 0) out += digits[fen] + '分';
  }
  return out;
}

/* ============================================================
   工具页骨架
   ============================================================ */
const TB_TOOLS = [
  { key: 'date',   icon: 'calendar-check',   name: '期限计算',   desc: '上诉期 · 节假日顺延' },
  { key: 'court',  icon: 'scales',           name: '诉讼费',     desc: '受理费 · 保全费' },
  { key: 'lawyer', icon: 'briefcase',        name: '风险代理费', desc: '按标的比例累进' },
  { key: 'arb',    icon: 'bank',             name: '仲裁费',     desc: '贸仲 · 北仲' },
  { key: 'rmb',    icon: 'money',            name: '金额大写',   desc: '文书规范大写' },
  { key: 'dedupe', icon: 'files',            name: '文本去重',   desc: '清单台账整理' },
  { key: 'count',  icon: 'magnifying-glass', name: '字数统计',   desc: '篇幅实时核算' }
];

let tbCurrent = 'date';

function tbEl(html) {
  const div = document.createElement('div');
  div.innerHTML = html.trim();
  return div.firstElementChild;
}

function renderToolbox() {
  const nav = document.getElementById('tb-nav');
  nav.innerHTML = '';
  for (const t of TB_TOOLS) {
    const item = tbEl(`<button class="tb-nav-item${t.key === tbCurrent ? ' active' : ''}">
      <span class="tb-nav-ic">${mfIconSvg(t.icon, 17)}</span>
      <span class="tb-nav-txt"><b>${t.name}</b><i>${t.desc}</i></span></button>`);
    item.addEventListener('click', () => { tbCurrent = t.key; renderToolbox(); });
    nav.appendChild(item);
  }
  const panel = document.getElementById('tb-panel');
  panel.innerHTML = '';
  ({ date: tbDate, court: tbCourt, lawyer: tbLawyer, arb: tbArb,
     rmb: tbRmb, dedupe: tbDedupe, count: tbCount })[tbCurrent](panel);
  attachScrollHint(panel);
  attachScrollHint(nav);
}

function tbField(label, inputHtml) {
  return `<div class="tb-field"><label>${label}</label>${inputHtml}</div>`;
}
function tbResultBox() {
  return tbEl(`<div class="tb-result hidden">
    <div class="tb-result-body"></div>
    <button class="btn btn-glass tb-copy">📋 复制结果</button>
  </div>`);
}
function showResult(box, html, copyText) {
  box.classList.remove('hidden');
  box.querySelector('.tb-result-body').innerHTML = html;
  const btn = box.querySelector('.tb-copy');
  btn.onclick = () => tbCopy(copyText, btn);
}
const hideResult = box => box.classList.add('hidden');

/* ---------- 1. 期限计算（法定期限预设 + 节假日顺延） ---------- */
const DATE_PRESETS = [
  { name: '自定义期间…', n: '', unit: 'd' },
  { name: '民事／行政判决上诉期（15 日）', n: 15, unit: 'd' },
  { name: '民事裁定上诉期（10 日）', n: 10, unit: 'd' },
  { name: '刑事判决上诉／抗诉期（10 日）', n: 10, unit: 'd' },
  { name: '刑事裁定上诉／抗诉期（5 日）', n: 5, unit: 'd' },
  { name: '答辩期（15 日）', n: 15, unit: 'd' },
  { name: '管辖权异议（答辩期内 15 日）', n: 15, unit: 'd' },
  { name: '劳动仲裁裁决不服起诉期（15 日）', n: 15, unit: 'd' },
  { name: '诉前保全后起诉期（30 日）', n: 30, unit: 'd' },
  { name: '行政复议申请期（60 日）', n: 60, unit: 'd' },
  { name: '行政诉讼起诉期（6 个月）', n: 6, unit: 'm' },
  { name: '申请再审期（6 个月）', n: 6, unit: 'm' },
  { name: '劳动仲裁申请时效（1 年）', n: 1, unit: 'y' },
  { name: '申请执行时效（2 年）', n: 2, unit: 'y' }
];

function tbDate(panel) {
  const today = new Date();
  const todayStr = iso(today);
  const card = tbEl(`<div class="tb-card">
    <div class="tb-title">📅 期限计算<span class="tb-sub">已内置 2025–2026 法定节假日与调休安排，届满日自动顺延</span></div>
    ${tbField('常用法定期限', `<select id="dt-preset">${DATE_PRESETS.map((p, i) => `<option value="${i}">${p.name}</option>`).join('')}</select>`)}
    ${tbField('起算事件日（如签收裁判文书之日）', `<input id="dt-start" type="date" value="${todayStr}">`)}
    <div class="tb-row2">
      ${tbField('期间数值', '<input id="dt-n" type="number" min="1" placeholder="如：15">')}
      ${tbField('单位', `<select id="dt-unit"><option value="d">日</option><option value="m">月</option><option value="y">年</option></select>`)}
    </div>
    <label class="tb-toggle"><input id="dt-nextday" type="checkbox" checked><span>期间开始之日不计入，自次日起算（《民事诉讼法》期间规则）</span></label>
  </div>`);
  const result = tbResultBox();
  panel.appendChild(card);
  panel.appendChild(result);

  const presetSel = card.querySelector('#dt-preset');
  const nInput = card.querySelector('#dt-n');
  const unitSel = card.querySelector('#dt-unit');

  const applyPreset = () => {
    const p = DATE_PRESETS[+presetSel.value];
    if (p.n !== '') { nInput.value = p.n; unitSel.value = p.unit; }
  };
  presetSel.addEventListener('change', () => { applyPreset(); calc(); });

  const calc = () => {
    const sv = card.querySelector('#dt-start').value;
    const n = parseInt(nInput.value, 10);
    const unit = unitSel.value;
    const nextDay = card.querySelector('#dt-nextday').checked;
    if (!sv || !(n > 0)) { hideResult(result); return; }

    const start = new Date(sv + 'T00:00:00');
    let end;
    if (unit === 'd') {
      const base = new Date(start);
      if (nextDay) base.setDate(base.getDate() + 1);
      end = new Date(base);
      end.setDate(end.getDate() + n - 1);
    } else if (unit === 'm') {
      end = new Date(start);
      end.setMonth(end.getMonth() + n);
    } else {
      end = new Date(start);
      end.setFullYear(end.getFullYear() + n);
    }

    const ext = extendForHolidays(end);
    const finalD = ext.date;
    const unitTxt = { d: '日', m: '个月', y: '年' }[unit];
    const presetName = +presetSel.value > 0 ? DATE_PRESETS[+presetSel.value].name : `${n} ${unitTxt}`;

    const t0 = new Date(todayStr + 'T00:00:00');
    const left = Math.round((finalD - t0) / 86400000);
    const leftTxt = left > 0 ? `距今还有 ${left} 天` : (left === 0 ? '今日届满！' : `已届满 ${-left} 天`);
    const leftCls = left <= 3 ? ' urgent' : '';

    const beyond = !inHolidayRange(finalD) || !inHolidayRange(end);
    let extHtml = '';
    if (ext.extended) {
      extHtml = `<div class="tb-line"><span>原届满日</span><b class="strike">${fmtDate(end)}</b></div>
        <div class="tb-line dim"><span>顺延原因</span><b>逢${ext.reasons.join('、')}，顺延至其后第一个工作日</b></div>`;
    }
    showResult(result,
      `<div class="tb-line"><span>期限类型</span><b>${presetName}${unit === 'd' && nextDay ? '（自次日起算）' : ''}</b></div>
       <div class="tb-line"><span>起算事件日</span><b>${fmtDate(start)}</b></div>
       ${extHtml}
       <div class="tb-line total"><span>期间届满日</span><b>${fmtDate(finalD)}</b></div>
       <div class="tb-line${leftCls}"><span>倒计时</span><b>${leftTxt}</b></div>
       ${beyond ? '<div class="tb-detail"><div>⚠️ 届满日超出内置节假日数据范围（2025–2026），仅按周末顺延，请人工核对当年放假安排。</div></div>' : ''}`,
      `【${presetName}】起算事件日：${fmtDate(start)}${unit === 'd' && nextDay ? '，自次日起算' : ''}，期间届满日：${fmtDate(finalD)}${ext.extended ? `（原届满日 ${fmtDate(end)} 逢${ext.reasons.join('、')}，依法顺延）` : ''}。${leftTxt}。`);
  };

  card.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('input', calc);
    el.addEventListener('change', calc);
  });

  // 默认选中民事/行政判决上诉期（15 日），打开即出结果
  presetSel.value = '1';
  applyPreset();
  calc();
}

/* ---------- 2. 诉讼费（输入即算） ---------- */
function tbCourt(panel) {
  const card = tbEl(`<div class="tb-card">
    <div class="tb-title">⚖️ 诉讼费用<span class="tb-sub">《诉讼费用交纳办法》财产案件受理费 · 分段累进</span></div>
    ${tbField('请求标的额（元）', '<input id="ct-amount" type="number" min="0" placeholder="如：10000000">')}
    <div class="tb-chips">
      <button class="tb-chip" data-v="100000">10 万</button>
      <button class="tb-chip" data-v="500000">50 万</button>
      <button class="tb-chip" data-v="1000000">100 万</button>
      <button class="tb-chip" data-v="5000000">500 万</button>
      <button class="tb-chip" data-v="10000000">1000 万</button>
      <button class="tb-chip" data-v="50000000">5000 万</button>
      <button class="tb-chip" data-v="100000000">1 亿</button>
    </div>
    <div class="tb-toggle-row">
      <label class="tb-toggle"><input id="ct-pres" type="checkbox"><span>同时计算财产保全费</span></label>
      <input id="ct-pres-amount" type="number" min="0" placeholder="保全金额（元）" class="hidden">
    </div>
    <div class="tb-note">适用简易程序的，受理费减半交纳；保全费按 1 千元以下 30 元、1 千–10 万部分 1%、超 10 万部分 0.5% 累计，最高 5,000 元封顶。</div>
  </div>`);
  const result = tbResultBox();
  panel.appendChild(card);
  panel.appendChild(result);

  const amountIn = card.querySelector('#ct-amount');
  const presToggle = card.querySelector('#ct-pres');
  const presInput = card.querySelector('#ct-pres-amount');

  const calc = () => {
    const amount = parseFloat(amountIn.value);
    if (!(amount >= 0) || amountIn.value === '') { hideResult(result); return; }
    const { fee, lines } = calcCourtFee(amount);
    let html = `<div class="tb-line"><span>财产案件受理费</span><b>${yuan(fee)}</b></div>
      <div class="tb-line dim"><span>简易程序减半后</span><b>${yuan(fee / 2)}</b></div>
      <div class="tb-detail">${lines.map(l => `<div>${l}</div>`).join('')}</div>`;
    let copy = `争议标的：${fmt(amount)}元，预估诉讼费（受理费）：${fmt(Math.round(fee))}元`;
    if (presToggle.checked && presInput.value !== '') {
      const pa = parseFloat(presInput.value);
      if (pa >= 0) {
        const pf = calcPreservationFee(pa);
        const total = fee + pf;
        html += `<div class="tb-line"><span>财产保全费（保全 ${fmt(pa)} 元）</span><b>${yuan(pf)}</b></div>
                 <div class="tb-line total"><span>总计</span><b>${yuan(total)}</b></div>`;
        copy += `，保全费：${fmt(Math.round(pf))}元。总计：${fmt(Math.round(total))}元`;
      }
    }
    showResult(result, html, copy + '。');
  };

  presToggle.addEventListener('change', () => {
    presInput.classList.toggle('hidden', !presToggle.checked);
    calc();
  });
  amountIn.addEventListener('input', calc);
  presInput.addEventListener('input', calc);

  // 快捷档位：一点即算
  card.querySelectorAll('.tb-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      amountIn.value = chip.dataset.v;
      calc();
    });
  });
}

/* ---------- 3. 风险代理费（仅比例累进，输入即算） ---------- */
function tbLawyer(panel) {
  const card = tbEl(`<div class="tb-card">
    <div class="tb-title">💼 风险代理费估算<span class="tb-sub">按标的比例分段累进 · 各地指导价不同，结果仅供报价参考</span></div>
    ${tbField('争议标的额（元）', '<input id="lw-amount" type="number" min="0" placeholder="如：10000000">')}
    ${tbField('单件最低收费（元）', '<input id="lw-min" type="number" min="0" value="5000">')}
    <div class="tb-sched-title">分段比例（可直接修改，即时生效）</div>
    <div id="lw-tiers" class="tb-sched"></div>
  </div>`);
  const result = tbResultBox();
  panel.appendChild(card);
  panel.appendChild(result);

  const tiers = deepCopySched(DEFAULT_LAWYER_TIERS);
  const amountIn = card.querySelector('#lw-amount');
  const minIn = card.querySelector('#lw-min');

  const calc = () => {
    const a = parseFloat(amountIn.value);
    if (!(a >= 0) || amountIn.value === '') { hideResult(result); return; }
    const minFee = parseFloat(minIn.value) || 0;
    const { low, high, lines } = calcLawyerFee(a, tiers, minFee);
    showResult(result,
      `<div class="tb-line total"><span>建议报价区间</span><b>${yuan(low)} ~ ${yuan(high)}</b></div>
       <div class="tb-detail">${lines.map(l => `<div>${l}</div>`).join('')}</div>`,
      `争议标的：${fmt(a)}元，风险代理费建议报价区间：${fmt(Math.round(low))}元 ~ ${fmt(Math.round(high))}元（按标的比例分段累进，仅供参考）。`);
  };

  const tiersEl = card.querySelector('#lw-tiers');
  let prev = 0;
  tiers.forEach((t, i) => {
    const capTxt = t.cap === Infinity ? `${fmt(prev)} 元以上` : `${fmt(prev)}–${fmt(t.cap)} 元`;
    const row = tbEl(`<div class="tb-sched-row"><span class="rng">${capTxt}</span>
      <input type="number" step="0.1" min="0" value="${t.min}" data-i="${i}" data-f="min"><span>%</span>
      <span class="tilde">~</span>
      <input type="number" step="0.1" min="0" value="${t.max}" data-i="${i}" data-f="max"><span>%</span></div>`);
    row.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', () => {
        tiers[+inp.dataset.i][inp.dataset.f] = parseFloat(inp.value) || 0;
        calc();
      });
    });
    tiersEl.appendChild(row);
    prev = t.cap;
  });

  amountIn.addEventListener('input', calc);
  minIn.addEventListener('input', calc);
}

/* ---------- 4. 仲裁费（输入即算，费率表可编辑保存） ---------- */
function tbArb(panel) {
  const card = tbEl(`<div class="tb-card">
    <div class="tb-title">⚡ 仲裁费用<span class="tb-sub">受理费 + 处理费 · 费率表可编辑并保存在本机</span></div>
    ${tbField('仲裁机构', `<select id="ar-org">
        <option value="cietac">中国国际经济贸易仲裁委员会（CIETAC·国内）</option>
        <option value="bac">北京仲裁委员会（BAC／BIAC）</option>
      </select>`)}
    ${tbField('争议金额（元）', '<input id="ar-amount" type="number" min="0" placeholder="如：10000000">')}
    <div class="tb-note warn" id="ar-note"></div>
    <details class="tb-sched-details">
      <summary>查看／修改内置费率表</summary>
      <div id="ar-sched"></div>
      <div class="tb-sched-actions">
        <button id="ar-save" class="btn btn-glass">保存修正</button>
        <button id="ar-reset" class="btn btn-glass btn-danger">恢复预填值</button>
      </div>
    </details>
  </div>`);
  const result = tbResultBox();
  panel.appendChild(card);
  panel.appendChild(result);

  const orgSel = card.querySelector('#ar-org');
  const amountIn = card.querySelector('#ar-amount');
  const noteEl = card.querySelector('#ar-note');
  const schedEl = card.querySelector('#ar-sched');

  const calc = () => {
    const a = parseFloat(amountIn.value);
    if (!(a >= 0) || amountIn.value === '') { hideResult(result); return; }
    const org = arbSchedules[orgSel.value];
    const acc = calcByBracket(a, org.acceptance);
    const proc = calcByBracket(a, org.processing);
    const total = acc + proc;
    showResult(result,
      `<div class="tb-line"><span>仲裁受理费</span><b>${yuan(acc)}</b></div>
       <div class="tb-line"><span>仲裁处理费</span><b>${yuan(proc)}</b></div>
       <div class="tb-line total"><span>总计费用</span><b>${yuan(total)}</b></div>
       <div class="tb-detail"><div>机构：${org.name}</div><div>结果仅供估算，请以仲裁委立案复函为准。</div></div>`,
      `仲裁机构：${org.name}，争议金额：${fmt(a)}元。仲裁受理费：${fmt(Math.round(acc))}元，仲裁处理费：${fmt(Math.round(proc))}元，总计：${fmt(Math.round(total))}元（估算，以仲裁委立案复函为准）。`);
  };

  const renderSched = () => {
    const org = arbSchedules[orgSel.value];
    noteEl.textContent = '⚠️ ' + org.note;
    schedEl.innerHTML = '';
    [['acceptance', '案件受理费'], ['processing', '案件处理费']].forEach(([k, title]) => {
      schedEl.appendChild(tbEl(`<div class="tb-sched-title">${title}（落入区间：基数 + 超过区间下限部分 × 比例）</div>`));
      const wrap = document.createElement('div');
      wrap.className = 'tb-sched';
      let prev = 0;
      org[k].forEach((t, i) => {
        const capTxt = t.cap === Infinity ? `${fmt(prev)} 元以上` : `${fmt(prev)}–${fmt(t.cap)} 元`;
        const row = tbEl(`<div class="tb-sched-row"><span class="rng">${capTxt}</span>
          <span>基数</span><input type="number" min="0" value="${t.base}" data-k="${k}" data-i="${i}" data-f="base">
          <span>＋超额</span><input type="number" step="0.05" min="0" value="${t.rate}" data-k="${k}" data-i="${i}" data-f="rate"><span>%</span></div>`);
        row.querySelectorAll('input').forEach(inp => {
          inp.addEventListener('input', () => {
            org[inp.dataset.k][+inp.dataset.i][inp.dataset.f] = parseFloat(inp.value) || 0;
            calc();
          });
        });
        wrap.appendChild(row);
        prev = t.cap;
      });
      schedEl.appendChild(wrap);
    });
  };
  renderSched();

  orgSel.addEventListener('change', () => { renderSched(); calc(); });
  amountIn.addEventListener('input', calc);

  card.querySelector('#ar-save').addEventListener('click', async (e) => {
    await saveArbSchedules();
    const b = e.currentTarget;
    const old = b.textContent;
    b.textContent = '已保存 ✓';
    setTimeout(() => b.textContent = old, 1200);
  });
  card.querySelector('#ar-reset').addEventListener('click', async () => {
    if (!confirm('将当前机构费率表恢复为预填值？')) return;
    arbSchedules[orgSel.value] = deepCopySched(DEFAULT_ARB_SCHEDULES[orgSel.value]);
    await saveArbSchedules();
    renderSched();
    calc();
  });
}

/* ---------- 5. 金额大写（输入即算） ---------- */
function tbRmb(panel) {
  const card = tbEl(`<div class="tb-card">
    <div class="tb-title">🀄 人民币金额大写<span class="tb-sub">合同、收据、法律文书规范大写</span></div>
    ${tbField('金额（元）', '<input id="rm-amount" type="number" step="0.01" placeholder="如：1234567.89">')}
  </div>`);
  const result = tbResultBox();
  panel.appendChild(card);
  panel.appendChild(result);

  const input = card.querySelector('#rm-amount');
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (isNaN(v)) { hideResult(result); return; }
    const upper = rmbUpper(v);
    showResult(result,
      `<div class="tb-line"><span>小写</span><b>￥${fmt(v)}</b></div>
       <div class="tb-line total"><span>大写</span><b>人民币${upper}</b></div>`,
      `金额：￥${fmt(v)}（人民币${upper}）`);
  });
}

/* ---------- 6. 文本去重 ---------- */
function tbDedupe(panel) {
  const card = tbEl(`<div class="tb-card">
    <div class="tb-title">🧹 文本行去重<span class="tb-sub">证据清单、名单、台账整理 · 输入即算</span></div>
    ${tbField('粘贴文本（按行去重，保留首次出现顺序）', '<textarea id="dd-in" rows="8" placeholder="每行一条…"></textarea>')}
    <div class="tb-toggle-row">
      <label class="tb-toggle"><input id="dd-trim" type="checkbox" checked><span>忽略首尾空格</span></label>
      <label class="tb-toggle"><input id="dd-empty" type="checkbox" checked><span>移除空行</span></label>
      <label class="tb-toggle"><input id="dd-case" type="checkbox"><span>忽略大小写</span></label>
    </div>
  </div>`);
  const result = tbResultBox();
  panel.appendChild(card);
  panel.appendChild(result);

  const calc = () => {
    const raw = card.querySelector('#dd-in').value;
    if (!raw) { hideResult(result); return; }
    const trim = card.querySelector('#dd-trim').checked;
    const rmEmpty = card.querySelector('#dd-empty').checked;
    const ic = card.querySelector('#dd-case').checked;
    const lines = raw.split('\n');
    const seen = new Set();
    const out = [];
    for (const l of lines) {
      const v = trim ? l.trim() : l;
      if (rmEmpty && v === '') continue;
      const key = ic ? v.toLowerCase() : v;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    const text = out.join('\n');
    showResult(result,
      `<div class="tb-line"><span>去重前</span><b>${lines.length} 行</b></div>
       <div class="tb-line total"><span>去重后</span><b>${out.length} 行（移除 ${lines.length - out.length} 行）</b></div>
       <textarea class="tb-out" rows="8" readonly>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</textarea>`,
      text);
  };
  card.querySelectorAll('input, textarea').forEach(el => {
    el.addEventListener('input', calc);
    el.addEventListener('change', calc);
  });
}

/* ---------- 7. 字数统计 ---------- */
function tbCount(panel) {
  const card = tbEl(`<div class="tb-card">
    <div class="tb-title">🔢 字数统计<span class="tb-sub">代理词、文章篇幅实时核算</span></div>
    ${tbField('粘贴文本', '<textarea id="cn-in" rows="9" placeholder="粘贴需要统计的文字…"></textarea>')}
  </div>`);
  const result = tbResultBox();
  panel.appendChild(card);
  panel.appendChild(result);

  const input = card.querySelector('#cn-in');
  input.addEventListener('input', () => {
    const t = input.value;
    if (!t) { hideResult(result); return; }
    const total = t.length;
    const noSpace = t.replace(/\s/g, '').length;
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    const words = (t.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length;
    const nums = (t.match(/\d+(?:\.\d+)?/g) || []).length;
    const punct = (t.match(/[，。、；：？！""''（）《》【】—…,.;:?!"'()<>\[\]-]/g) || []).length;
    const lines = t.split('\n').length;
    const paras = t.split(/\n\s*\n/).filter(s => s.trim()).length;
    showResult(result,
      `<div class="tb-grid">
        <div class="tb-stat"><b>${total}</b><span>总字符（含空格）</span></div>
        <div class="tb-stat"><b>${noSpace}</b><span>字符（不含空格）</span></div>
        <div class="tb-stat"><b>${cjk}</b><span>中文字数</span></div>
        <div class="tb-stat"><b>${words}</b><span>英文单词</span></div>
        <div class="tb-stat"><b>${nums}</b><span>数字串</span></div>
        <div class="tb-stat"><b>${punct}</b><span>标点符号</span></div>
        <div class="tb-stat"><b>${lines}</b><span>行数</span></div>
        <div class="tb-stat"><b>${paras}</b><span>段落数</span></div>
      </div>`,
      `字数统计：总字符 ${total}（不含空格 ${noSpace}），中文 ${cjk} 字，英文 ${words} 词，行数 ${lines}，段落 ${paras}。`);
  });
}

/* ============================================================
   浮层开关（主窗内，可拖动）
   ============================================================ */
let tbxReady = false;

async function openToolboxFloat() {
  const float = document.getElementById('tbx-float');
  if (!tbxReady) {
    await loadArbSchedules();
    renderToolbox();
    tbxReady = true;
  }
  float.classList.remove('hidden');
  if (!float.dataset.placed) {
    const w = float.offsetWidth;
    float.style.left = Math.max(20, window.innerWidth - w - 48) + 'px';
    float.style.top = '76px';
    float.dataset.placed = '1';
  }
}

function closeToolboxFloat() {
  document.getElementById('tbx-float').classList.add('hidden');
}

function initToolboxDrag() {
  const float = document.getElementById('tbx-float');
  const head = document.getElementById('tbx-float-head');
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('.icon-btn')) return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const r = float.getBoundingClientRect();
    ox = r.left; oy = r.top;
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    let nx = ox + (e.clientX - sx);
    let ny = oy + (e.clientY - sy);
    nx = Math.max(8, Math.min(nx, window.innerWidth - float.offsetWidth - 8));
    ny = Math.max(54, Math.min(ny, window.innerHeight - 60));
    float.style.left = nx + 'px';
    float.style.top = ny + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.userSelect = ''; });
}

document.addEventListener('DOMContentLoaded', () => {
  initToolboxDrag();
  document.getElementById('tbx-float-close').addEventListener('click', closeToolboxFloat);
});
