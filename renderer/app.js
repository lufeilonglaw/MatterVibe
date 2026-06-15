// app.js —— MatterVibe 2.3 渲染进程主逻辑

'use strict';

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  matters: [],
  currentId: null,
  matter: null,
  templates: [],
  selectedTemplate: null,
  showDoneStages: new Set(),
  search: '',
  tplEditingKey: null,
  tplView: 'edit',
  mmSelected: new Set(),  // 案件管理：已勾选的案件 id
  iconPickTarget: null    // 图标选择器：目标案件 id
};

/* ============================================================
   一、Web Audio：纯代码合成清脆"叮"声
   ============================================================ */
let audioCtx = null;

function playDing() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    [[1318.5, 0.28], [2637.0, 0.10]].forEach(([freq, gainPeak]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(gainPeak, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.6);
    });
  } catch (_) { /* 静默降级 */ }
}

/* ============================================================
   二、数据加载与刷新
   ============================================================ */
let currentView = 'home'; // 'home' | 'board'

function showView(v) {
  currentView = v;
  const home = document.getElementById('home-view');
  const cal = document.getElementById('cal-view');
  const empty = document.getElementById('board-empty');
  const area = document.getElementById('board-area');
  document.getElementById('nav-home').classList.toggle('active', v === 'home');
  document.getElementById('nav-calendar').classList.toggle('active', v === 'calendar');
  home.classList.toggle('hidden', v !== 'home');
  cal.classList.toggle('hidden', v !== 'calendar');
  if (v === 'home') {
    empty.classList.add('hidden');
    area.classList.add('hidden');
    renderHome();
    renderSidebar();
  } else if (v === 'calendar') {
    empty.classList.add('hidden');
    area.classList.add('hidden');
    renderCalendar();
    renderSidebar();
  } else {
    renderBoard();
  }
}

async function loadAll(keepId = null) {
  state.matters = await window.api.listMatters();
  if (keepId && state.matters.some(m => m.id === keepId)) {
    state.currentId = keepId;
  } else if (!state.matters.some(m => m.id === state.currentId)) {
    state.currentId = state.matters.length ? state.matters[0].id : null;
  }
  state.matter = state.currentId ? await window.api.getMatter(state.currentId) : null;
  renderSidebar();
  if (currentView === 'home') renderHome();
  else renderBoard();
  renderTopbar();
}

async function refreshMatter() {
  if (!state.currentId) { renderTopbar(); return; }
  state.matter = await window.api.getMatter(state.currentId);
  renderBoard();
  renderTopbar();
}

function renderTopbar() {
  $('#topbar-matter').textContent = currentView === 'home' ? '首页 · 待办总览'
    : currentView === 'calendar' ? '日历'
    : (state.matter ? state.matter.name : '');
}


/* ============================================================
   三-0、首页：待办总览
   ============================================================ */
let homeTab = 'upcoming';
const KIND_LABEL = { hearing: '开庭', evidence: '举证/提交', mediation: '调解/续封', deadline: '期限', custom: '自定义' };

function agendaDayDiff(dateStr) {
  const p = n => String(n).padStart(2, '0');
  const t = new Date();
  const tIso = t.getFullYear() + '-' + p(t.getMonth()+1) + '-' + p(t.getDate());
  const a = new Date(tIso + 'T00:00:00'), b = new Date(dateStr + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

async function renderHome() {
  // 演示提示条
  try {
    const ds = await window.api.demoState();
    document.getElementById('demo-banner').classList.toggle('hidden', !ds.mode);
  } catch (e) {}

  const dash = await window.api.getDashboard();

  // 统计卡
  const stats = $('#home-stats');
  const cards = [
    { cls: 'c-today', label: '今日安排', n: dash.counts.today },
    { cls: 'c-hearing', label: '本周开庭', n: dash.counts.weekHearings },
    { cls: 'c-next7', label: '近 7 天待办', n: dash.counts.next7 },
    { cls: 'c-overdue' + (dash.counts.overdue ? ' has' : ''), label: '已逾期', n: dash.counts.overdue }
  ];
  stats.innerHTML = cards.map(c =>
    '<div class="stat-card ' + c.cls + '"><div class="s-label">' + c.label + '</div><div class="s-num">' + c.n + '</div></div>'
  ).join('');

  // 待办清单
  renderHomeList(dash);

  // 今日安排
  const todayEl = $('#home-today');
  todayEl.innerHTML = '';
  if (!dash.todayItems.length) {
    todayEl.innerHTML = '<div class="t-empty">今天没有安排。</div>';
  } else {
    for (const it of dash.todayItems) {
      const row = document.createElement('div');
      row.className = 't-row';
      row.innerHTML = '<span class="t-time">' + (it.time || '全天') + '</span><span class="t-title">' +
        escapeHtml(it.title) + (it.matter_name ? '　<span style="color:var(--ink-2)">' + escapeHtml(it.matter_name) + '</span>' : '') + '</span>';
      todayEl.appendChild(row);
    }
  }

  renderHomeAdd();
}

function renderHomeList(dash) {
  const list = $('#home-list');
  const items = homeTab === 'upcoming' ? dash.upcoming : dash.overdue;
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<div class="home-empty">' + (homeTab === 'upcoming' ? '近期没有待办与期限。' : '没有逾期事项，很好。') + '</div>';
    return;
  }
  for (const it of items) {
    const diff = agendaDayDiff(it.date);
    const daysTxt = diff > 0 ? ('还有 ' + diff + ' 天') : (diff === 0 ? '今天' : ('已过 ' + (-diff) + ' 天'));
    const daysCls = diff < 0 ? 'over' : (diff <= 3 ? 'urgent' : '');
    const row = document.createElement('div');
    row.className = 'todo-item';
    const checkable = it.source === 'event';
    row.innerHTML =
      '<span class="todo-kind ' + it.kind + '"></span>' +
      '<span class="todo-check ' + (checkable ? '' : 'ro') + '"></span>' +
      '<div class="todo-main"><div class="todo-title">' + escapeHtml(it.title) + '</div>' +
      '<div class="todo-sub">' + (KIND_LABEL[it.kind] || '') + (it.matter_name ? ' · ' + escapeHtml(it.matter_name) : '') + (it.source === 'cover' ? ' · 来自案件封皮' : '') + '</div></div>' +
      '<div class="todo-when"><div class="todo-date">' + it.date.slice(5) + (it.time ? ' ' + it.time : '') + '</div><div class="todo-days ' + daysCls + '">' + daysTxt + '</div></div>';

    // 点击行 → 跳到对应案件
    row.addEventListener('click', async (e) => {
      if (e.target.classList.contains('todo-check') && checkable) return;
      if (it.matter_id) {
        state.currentId = it.matter_id;
        state.matter = await window.api.getMatter(it.matter_id);
        showView('board');
        renderSidebar();
        renderBoard();
        renderTopbar();
      }
    });
    // 勾选完成（仅结构化事件）
    const chk = row.querySelector('.todo-check');
    if (checkable) {
      chk.addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.api.setEventDone(it.id, true);
        renderHome();
        refreshBell();
      });
    }
    list.appendChild(row);
  }
  attachScrollHint(list);
}

async function renderHomeAdd() {
  const wrap = $('#home-add');
  if (wrap.dataset.built) {
    // 表单已存在：仅刷新案件下拉，保留用户已输入内容
    const sel = $('#ha-matter', wrap);
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = ['<option value="">不关联案件</option>'].concat(
        state.matters.map(m => '<option value="' + m.id + '">' + escapeHtml(m.name) + '</option>')).join('');
      sel.value = cur;
    }
    return;
  }
  wrap.dataset.built = '1';

  const matters = state.matters;
  const opts = ['<option value="">不关联案件</option>'].concat(
    matters.map(m => '<option value="' + m.id + '">' + escapeHtml(m.name) + '</option>')).join('');
  wrap.innerHTML =
    '<input type="text" id="ha-title" placeholder="事项标题，如：第一次开庭">' +
    '<div class="row2"><input type="date" id="ha-date"><input type="time" id="ha-time" placeholder="时间"></div>' +
    '<div class="row2"><select id="ha-kind"><option value="hearing">开庭</option><option value="evidence">举证/提交</option><option value="mediation">调解/续封</option><option value="custom" selected>自定义</option></select>' +
    '<select id="ha-matter">' + opts + '</select></div>' +
    '<button id="ha-add" class="btn btn-primary">添加到日程</button>';

  const p = n => String(n).padStart(2, '0');
  const t = new Date();
  $('#ha-date', wrap).value = t.getFullYear() + '-' + p(t.getMonth()+1) + '-' + p(t.getDate());

  $('#ha-add', wrap).addEventListener('click', async () => {
    const title = $('#ha-title', wrap).value.trim();
    const date = $('#ha-date', wrap).value;
    if (!title || !date) { notify('请填写事项标题与日期'); return; }
    await window.api.addEvent({
      matter_id: $('#ha-matter', wrap).value ? parseInt($('#ha-matter', wrap).value, 10) : null,
      event_date: date,
      event_time: $('#ha-time', wrap).value || null,
      kind: $('#ha-kind', wrap).value,
      title
    });
    $('#ha-title', wrap).value = '';
    $('#ha-time', wrap).value = '';
    renderHome();
    refreshBell();
  });
}



/* ============================================================
   三-0b、演示数据 与 隐藏彩蛋
   ============================================================ */
async function maybeOfferDemoData() {
  try {
    const ds = await window.api.demoState();
    if (ds.dismissed || ds.mode) return;        // 已正式使用 或 已在演示中
    if (state.matters.length > 0) return;        // 已有真实数据，不打扰
    // 首次使用：显示引导页（含"看演示/开始使用"）
    $('#onboard-mask').classList.remove('hidden');
  } catch (e) {}
}

async function exitDemoMode() {
  if (!await confirmDialog({ title: '清空演示数据', body: '确定清空全部演示数据、正式开始使用吗？\n\n此操作不可撤销：所有示范案件将被删除，且今后不再提示导入演示数据。', okText: '清空并正式使用', danger: true })) return;
  await window.api.demoClear();
  await loadAll();
  showView('home');
}

// 隐藏彩蛋：首页键盘缓冲，输入 codeislaw 触发大嘴吃豆
let eggBuffer = '';
function initEgg() {
  document.addEventListener('keydown', (e) => {
    // 仅在首页、且焦点不在输入框时累积
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (currentView !== 'home' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key && e.key.length === 1 && /[a-z]/i.test(e.key)) {
      eggBuffer = (eggBuffer + e.key.toLowerCase()).slice(-12);
      if (eggBuffer.endsWith('codeislaw')) {
        eggBuffer = '';
        if (window.openPacman) window.openPacman();
      }
    }
  });
}

function initPacmanFloat() {
  const float = document.getElementById('pac-float');
  const head = document.getElementById('pac-head');
  let sx=0, sy=0, ox=0, oy=0, dragging=false;
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('.icon-btn')) return;
    dragging = true; sx = e.clientX; sy = e.clientY;
    const r = float.getBoundingClientRect(); ox = r.left; oy = r.top;
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
    nx = Math.max(8, Math.min(nx, window.innerWidth - float.offsetWidth - 8));
    ny = Math.max(40, Math.min(ny, window.innerHeight - 80));
    float.style.left = nx + 'px'; float.style.top = ny + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.userSelect = ''; });
  document.getElementById('pac-close').addEventListener('click', () => { if (window.closePacman) window.closePacman(); });
}

/* ============================================================
   三-1、日历：月视图
   ============================================================ */
let calYear, calMonth; // 当前显示的年、月（month 0-11）

// 节假日数据（与工具箱一致，内嵌一份避免依赖加载顺序）
const CAL_HOLIDAYS = {};
(function () {
  const span = (from, to, name) => {
    const d = new Date(from + 'T00:00:00'), e = new Date(to + 'T00:00:00');
    while (d <= e) { CAL_HOLIDAYS[calIso(d)] = name; d.setDate(d.getDate() + 1); }
  };
  span('2025-01-01','2025-01-01','元旦'); span('2025-01-28','2025-02-04','春节');
  span('2025-04-04','2025-04-06','清明'); span('2025-05-01','2025-05-05','劳动节');
  span('2025-05-31','2025-06-02','端午'); span('2025-10-01','2025-10-08','国庆中秋');
  span('2026-01-01','2026-01-03','元旦'); span('2026-02-15','2026-02-23','春节');
  span('2026-04-04','2026-04-06','清明'); span('2026-05-01','2026-05-05','劳动节');
  span('2026-06-19','2026-06-21','端午'); span('2026-09-25','2026-09-27','中秋');
  span('2026-10-01','2026-10-07','国庆');
})();
const CAL_WORKDAYS = new Set(['2025-01-26','2025-02-08','2025-04-27','2025-09-28','2025-10-11',
  '2026-01-04','2026-02-14','2026-02-28','2026-05-09','2026-09-20','2026-10-10']);

function calIso(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
}

async function renderCalendar() {
  if (calYear === undefined) {
    const t = new Date();
    calYear = t.getFullYear(); calMonth = t.getMonth();
  }
  $('#cal-title').textContent = calYear + ' 年 ' + (calMonth + 1) + ' 月';

  // 本月网格范围：从月首所在周一 到 月末所在周日
  const first = new Date(calYear, calMonth, 1);
  const firstWeekday = (first.getDay() + 6) % 7; // 周一=0
  const gridStart = new Date(calYear, calMonth, 1 - firstWeekday);
  const last = new Date(calYear, calMonth + 1, 0);
  const lastWeekday = (last.getDay() + 6) % 7;
  const gridEnd = new Date(calYear, calMonth, last.getDate() + (6 - lastWeekday));

  // 拉取区间事件
  const agenda = await window.api.getAgenda({ from: calIso(gridStart), to: calIso(gridEnd) });
  const byDate = {};
  for (const ev of agenda) { (byDate[ev.date] = byDate[ev.date] || []).push(ev); }

  // 图例计数：统计本月（仅当月，不含上下月补格）各类事件数量
  const monthFrom = calIso(new Date(calYear, calMonth, 1));
  const monthTo = calIso(new Date(calYear, calMonth + 1, 0));
  const counts = { hearing: 0, evidence: 0, mediation: 0, deadline: 0, custom: 0 };
  for (const ev of agenda) {
    if (ev.date < monthFrom || ev.date > monthTo) continue;
    if (counts[ev.kind] !== undefined) counts[ev.kind]++;
  }
  document.querySelectorAll('#cal-legend b[data-k]').forEach(b => {
    b.textContent = '（' + (counts[b.dataset.k] || 0) + '）';
  });

  const todayStr = calIso(new Date());
  const grid = $('#cal-grid');
  grid.innerHTML = '';

  const d = new Date(gridStart);
  while (d <= gridEnd) {
    const iso = calIso(d);
    const inMonth = d.getMonth() === calMonth;
    const wd = d.getDay();
    const isWeekend = (wd === 0 || wd === 6) && !CAL_WORKDAYS.has(iso);
    const holiday = CAL_HOLIDAYS[iso];
    const isWorkMakeup = CAL_WORKDAYS.has(iso);

    const cell = document.createElement('div');
    cell.className = 'cal-cell' + (inMonth ? '' : ' other') + (iso === todayStr ? ' today' : '') +
      (holiday ? ' holiday' : (isWeekend ? ' weekend' : ''));

    let tagHtml = '';
    if (holiday) tagHtml = '<span class="holi">' + holiday + '</span>';
    else if (isWorkMakeup) tagHtml = '<span class="work">班</span>';

    const evs = (byDate[iso] || []);
    let evHtml = '<div class="cal-evs">';
    evs.slice(0, 3).forEach(ev => {
      evHtml += '<div class="cal-ev' + (ev.done ? ' done' : '') + '"><i class="k-' + ev.kind + '"></i>' +
        (ev.time ? ev.time + ' ' : '') + escapeHtml(ev.title) + '</div>';
    });
    if (evs.length > 3) evHtml += '<div class="cal-ev-more">+' + (evs.length - 3) + ' 更多</div>';
    evHtml += '</div>';

    cell.innerHTML = '<div class="cal-daynum"><span class="d">' + d.getDate() + '</span>' + tagHtml + '</div>' + evHtml;
    const dayIso = iso;
    cell.addEventListener('click', () => openDayDetail(dayIso));
    grid.appendChild(cell);
    d.setDate(d.getDate() + 1);
  }
}

function calShift(delta) {
  calMonth += delta;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
}

/* 某日详情：列出当日全部日程，可勾选完成、删除、就地添加 */
let dayDetailDate = null;
async function openDayDetail(iso) {
  dayDetailDate = iso;
  const d = new Date(iso + 'T00:00:00');
  const WD = ['日','一','二','三','四','五','六'];
  const holi = CAL_HOLIDAYS[iso];
  $('#day-title').textContent = iso.replace(/-/g, '.') + ' 周' + WD[d.getDay()] + (holi ? ' · ' + holi : (CAL_WORKDAYS.has(iso) ? ' · 调休上班' : ''));
  await renderDayList();
  renderDayAdd();
  $('#day-mask').classList.remove('hidden');
}

const KIND_LABEL_CAL = { hearing: '开庭', evidence: '举证/提交', mediation: '调解/续封', deadline: '期限', custom: '自定义' };

async function renderDayList() {
  const agenda = await window.api.getAgenda({ from: dayDetailDate, to: dayDetailDate });
  const list = $('#day-list');
  list.innerHTML = '';
  if (!agenda.length) {
    list.innerHTML = '<div class="day-empty">这一天还没有日程。在下方添加，或在案件封皮里填写日期。</div>';
    return;
  }
  for (const ev of agenda) {
    const item = document.createElement('div');
    item.className = 'day-ev';
    const checkable = ev.source === 'event';
    item.innerHTML =
      '<span class="d-kind k-' + ev.kind + '" style="background:var(--' + '' + ')"></span>' +
      '<span class="d-check ' + (checkable ? '' : 'ro') + (ev.done ? ' done' : '') + '"></span>' +
      '<div class="d-main"><div class="d-title">' + (ev.time ? ev.time + '　' : '') + escapeHtml(ev.title) + '</div>' +
      '<div class="d-sub">' + (KIND_LABEL_CAL[ev.kind] || '') + (ev.matter_name ? ' · ' + escapeHtml(ev.matter_name) : '') + (ev.source === 'cover' ? ' · 来自案件封皮' : '') + '</div></div>' +
      (checkable ? '<button class="d-del" title="删除">✕</button>' : '');
    // 色条用类
    item.querySelector('.d-kind').style.background = '';
    item.querySelector('.d-kind').className = 'd-kind';
    const bar = item.querySelector('.d-kind');
    const colors = { hearing:'#E5484D', evidence:'#F5A623', mediation:'#8E939E', deadline:'var(--tint)', custom:'#B7791F' };
    bar.style.background = colors[ev.kind] || 'var(--ink-3)';

    if (checkable) {
      item.querySelector('.d-check').addEventListener('click', async () => {
        await window.api.setEventDone(ev.id, !ev.done);
        renderDayList();
        refreshBell();
      });
      item.querySelector('.d-del').addEventListener('click', async () => {
        if (!await confirmDialog({ title: '删除日程', body: '删除这条日程？', okText: '删除', danger: true })) return;
        await window.api.deleteEvent(ev.id);
        renderDayList();
        refreshBell();
      });
    }
    // 点案件名跳转
    if (ev.matter_id) {
      item.querySelector('.d-main').style.cursor = 'pointer';
      item.querySelector('.d-main').addEventListener('click', async () => {
        $('#day-mask').classList.add('hidden');
        state.currentId = ev.matter_id;
        state.matter = await window.api.getMatter(ev.matter_id);
        showView('board'); renderSidebar(); renderBoard(); renderTopbar();
      });
    }
    list.appendChild(item);
  }
}

function renderDayAdd() {
  const wrap = $('#day-add');
  const opts = ['<option value="">不关联案件</option>'].concat(
    state.matters.map(m => '<option value="' + m.id + '">' + escapeHtml(m.name) + '</option>')).join('');
  wrap.innerHTML =
    '<div class="day-add-title">＋ 添加日程</div>' +
    '<input type="text" id="da-title" placeholder="为这一天添加事项，如：第一次开庭">' +
    '<div class="row2"><input type="time" id="da-time"><select id="da-kind"><option value="hearing">开庭</option><option value="evidence">举证/提交</option><option value="mediation">调解/续封</option><option value="custom" selected>自定义</option></select></div>' +
    '<select id="da-matter">' + opts + '</select>' +
    '<button id="da-add" class="btn btn-primary">添加</button>';
  $('#da-add', wrap).addEventListener('click', async () => {
    const title = $('#da-title', wrap).value.trim();
    if (!title) { notify('请填写事项标题'); return; }
    await window.api.addEvent({
      matter_id: $('#da-matter', wrap).value ? parseInt($('#da-matter', wrap).value, 10) : null,
      event_date: dayDetailDate,
      event_time: $('#da-time', wrap).value || null,
      kind: $('#da-kind', wrap).value,
      title
    });
    $('#da-title', wrap).value = '';
    $('#da-time', wrap).value = '';
    await renderDayList();
    renderCalendar();
    refreshBell();
  });
}

/* ============================================================
   三、侧栏：搜索 + 案件列表
   ============================================================ */
function renderSidebar() {
  const list = $('#matter-list');
  list.innerHTML = '';

  const kw = state.search.trim().toLowerCase();
  const shown = kw
    ? state.matters.filter(m => m.name.toLowerCase().includes(kw) || m.type.toLowerCase().includes(kw))
    : state.matters;

  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'matter-list-empty';
    empty.textContent = kw ? '没有匹配的案件' : '暂无案件';
    list.appendChild(empty);
    return;
  }

  for (const m of shown) {
    const item = document.createElement('div');
    item.className = 'matter-item' + (m.id === state.currentId && currentView === 'board' ? ' active' : '');

    const dot = document.createElement('span');
    dot.className = 'matter-icon';
    dot.innerHTML = mfIconSvg(mfMatterIcon(m), 15);
    const name = document.createElement('span');
    name.className = 'matter-name';
    name.textContent = m.name;
    const tag = document.createElement('span');
    tag.className = 'matter-type-tag';
    tag.textContent = m.type;

    item.appendChild(dot);
    item.appendChild(name);
    item.appendChild(tag);
    item.title = m.name;
    item.addEventListener('click', async () => {
      state.currentId = m.id;
      state.matter = await window.api.getMatter(m.id);
      showView('board');
      renderSidebar();
      renderBoard();
      renderTopbar();
    });
    list.appendChild(item);
  }
  attachScrollHint(list);
}

function initSearch() {
  const input = $('#matter-search');
  const clear = $('#matter-search-clear');
  input.addEventListener('input', () => {
    state.search = input.value;
    clear.classList.toggle('hidden', !input.value);
    renderSidebar();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      state.search = '';
      clear.classList.add('hidden');
      renderSidebar();
      input.blur();
    }
  });
  clear.addEventListener('click', () => {
    input.value = '';
    state.search = '';
    clear.classList.add('hidden');
    renderSidebar();
    input.focus();
  });
}

function toggleSidebar() {
  document.body.classList.toggle('sidebar-collapsed');
}

/* ============================================================
   四、看板（双区：信息固定区 + 阶段滚动区）
   ============================================================ */
function renderBoard() {
  const area = $('#board-area');
  const board = $('#board');
  const coverSlot = $('#cover-slot');
  const empty = $('#board-empty');
  board.innerHTML = '';
  coverSlot.innerHTML = '';

  if (!state.matter) {
    empty.classList.remove('hidden');
    area.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  area.classList.remove('hidden');

  renderCoverBar(coverSlot);
  for (const stage of state.matter.stages) {
    board.appendChild(renderStageColumn(stage));
  }

  const addCol = document.createElement('button');
  addCol.className = 'add-column';
  addCol.textContent = '＋ 添加新阶段列';
  addCol.addEventListener('click', async () => {
    await window.api.addStage(state.matter.id, '📂 新阶段');
    refreshMatter();
  });
  board.appendChild(addCol);
}

// 横向滚动条已隐藏：在阶段区上把纵向滚轮转为横向滚动（触控板横扫不受影响）
function initBoardWheel() {
  const board = $('#board');
  board.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;        // 本来就是横向手势
    if (e.target.closest('.task-list')) return;                  // 列内纵向滚动优先
    board.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
}

/* ---------- 4.1 案件信息：顶部信息条（方案 A）---------- */
// 信息条：一行常驻关键要素 + 操作按钮 + 展开/收起；展开后显示完整封皮
let coverExpanded = false;
function renderCoverBar(slot) {
  slot.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'cover-bar';

  // 第一行：案件名 + 关键要素摘要 + 操作 + 展开钮
  const top = document.createElement('div');
  top.className = 'cover-bar-top';

  // 案件名（可点击改名）
  const nameEl = document.createElement('div');
  nameEl.className = 'cover-bar-name';
  nameEl.textContent = state.matter.name;
  nameEl.title = '点击修改案件名称';
  nameEl.addEventListener('click', () => startRenameMatter(nameEl));
  top.appendChild(nameEl);

  // 中间留白（顶部全折叠：关键要素都收进"展开全部"里）
  const spacer = document.createElement('div');
  spacer.className = 'cover-bar-spacer';
  top.appendChild(spacer);

  // 操作按钮组（日志 / 邮寄 / 文件夹 / 提醒）
  const acts = document.createElement('div');
  acts.className = 'cover-bar-acts';
  buildCoverActions(acts);
  top.appendChild(acts);

  // 展开/收起按钮
  const toggle = document.createElement('button');
  toggle.className = 'cover-toggle';
  toggle.innerHTML = '<span class="ct-label">案件信息</span><span class="ct-arrow">' + (coverExpanded ? '⌃' : '⌄') + '</span>';
  toggle.title = coverExpanded ? '收起案件信息' : '展开案件信息';
  toggle.addEventListener('click', () => { coverExpanded = !coverExpanded; renderBoard(); });
  top.appendChild(toggle);

  bar.appendChild(top);

  // 展开态：完整封皮（横向网格平铺所有要素）
  if (coverExpanded) {
    const panel = document.createElement('div');
    panel.className = 'cover-panel';
    renderCoverFieldsGrid(panel);
    bar.appendChild(panel);
  }

  slot.appendChild(bar);
  updateRecordCounts();
}

function startRenameMatter(nameEl) {
  if (nameEl.dataset.editing === '1') return;
  nameEl.dataset.editing = '1';
  const old = state.matter.name;
  nameEl.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = old;
  input.className = 'cover-name-input';
  nameEl.appendChild(input);
  input.focus(); input.select();
  let saved = false;
  const finish = async () => {
    if (saved) return; saved = true;
    const v = input.value.trim();
    if (v && v !== old) { await window.api.renameMatter(state.matter.id, v); await loadAll(state.matter.id); }
    else renderBoard();
  };
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { saved = true; renderBoard(); }
  });
}

/* ---------- 4.1b 案件信息列（保留：完整封皮，供展开态复用其字段渲染）---------- */
// 构建操作按钮组（文件夹/日志/邮寄/提醒），供信息条复用
function buildCoverActions(acts) {
  const logBtn = document.createElement('button');
  logBtn.className = 'cover-act';
  logBtn.innerHTML = '📓 日志 <span class="cnt" id="cnt-logs"></span>';
  logBtn.title = '办案日志';
  logBtn.addEventListener('click', () => openRecords('logs'));
  acts.appendChild(logBtn);

  const mailBtn = document.createElement('button');
  mailBtn.className = 'cover-act';
  mailBtn.innerHTML = '📮 邮寄 <span class="cnt" id="cnt-mails"></span>';
  mailBtn.title = '邮寄记录';
  mailBtn.addEventListener('click', () => openRecords('mails'));
  acts.appendChild(mailBtn);

  const curFolder = (state.matters.find(x => x.id === state.matter.id) || {}).folder || '';
  const dirBtn = document.createElement('button');
  dirBtn.className = 'cover-act';
  dirBtn.innerHTML = '📁 文件夹';
  dirBtn.title = curFolder ? ('打开：' + curFolder) : '点击关联该案件的本地文件夹';
  dirBtn.addEventListener('click', async () => {
    let p = curFolder;
    if (!p) {
      p = await window.api.chooseFolder('为「' + state.matter.name + '」选择案件文件夹');
      if (!p) return;
      await window.api.setMatterFolder(state.matter.id, p);
      await loadAll(state.matter.id);
    }
    const err = await window.api.openFolder(p);
    if (err) {
      if (await confirmDialog({ title: '打开文件夹失败', body: err + '。\n重新选择该案件的文件夹？', okText: '重新选择' })) {
        const np = await window.api.chooseFolder('为「' + state.matter.name + '」重新选择文件夹');
        if (np) { await window.api.setMatterFolder(state.matter.id, np); await loadAll(state.matter.id); window.api.openFolder(np); }
      }
    }
  });
  acts.appendChild(dirBtn);

  const remindOn = (state.matters.find(x => x.id === state.matter.id) || {}).remind ? true : false;
  const bellBtn = document.createElement('button');
  bellBtn.className = 'cover-act' + (remindOn ? ' bell-on' : '');
  bellBtn.innerHTML = remindOn ? '🔔 提醒中' : '🔕 提醒关';
  bellBtn.title = remindOn ? '该案件已开启期限提醒' : '点击开启该案件的期限提醒';
  bellBtn.addEventListener('click', async () => {
    const turningOn = !remindOn;
    await window.api.setMatterRemind(state.matter.id, turningOn);
    await loadAll(state.matter.id);
    const { focus } = await refreshBell();
    if (turningOn && !focus.some(it => it.matter_id === state.matter.id)) {
      notify('提醒已开启，但该案件封皮中暂未发现可识别的日期。\n\n在任意要素的内容里填上日期即可被自动扫描，例如：\n上诉截止日：2026-06-28\n开庭日期：2026年7月1日 上午9:30\n\n临期 7 天内会亮起顶栏铃铛红点并弹系统通知。', '提醒已开启');
    }
  });
  acts.appendChild(bellBtn);
}

function updateRecordCounts() {
  window.api.recordCounts(state.matter.id).then(c => {
    const l = document.getElementById('cnt-logs');
    const m = document.getElementById('cnt-mails');
    if (l) l.textContent = c.logs || '';
    if (m) m.textContent = c.mails || '';
  });
}

// 展开态：把全部封皮要素以网格平铺，末尾是"添加要素"和"复制案件信息"
function renderCoverFieldsGrid(panel) {
  const grid = document.createElement('div');
  grid.className = 'cover-grid';
  state.matter.cover_info.forEach((pair, idx) => {
    grid.appendChild(renderCoverField(pair, idx));
  });
  panel.appendChild(grid);

  const footer = document.createElement('div');
  footer.className = 'cover-panel-footer';
  footer.appendChild(renderCoverAddField());
  const copyBtn = document.createElement('button');
  copyBtn.className = 'cover-copy-btn';
  copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><span>复制案件信息</span>';
  copyBtn.title = '把案件名与全部封皮要素复制为规整文本';
  copyBtn.addEventListener('click', () => copyMatterInfo(copyBtn));
  footer.appendChild(copyBtn);
  panel.appendChild(footer);
}

/* ---------- 旧的完整封皮列（已不再直接使用，保留以防回退）---------- */
function renderCoverColumn() {
  const col = document.createElement('div');
  col.className = 'column cover-column';

  const head = document.createElement('div');
  head.className = 'cover-head';

  const nameEl = document.createElement('div');
  nameEl.className = 'cover-matter-name';
  nameEl.textContent = state.matter.name;
  nameEl.title = '点击修改案件名称';
  nameEl.addEventListener('click', () => {
    if (nameEl.dataset.editing === '1') return;
    nameEl.dataset.editing = '1';
    nameEl.classList.add('editing');
    const old = state.matter.name;
    nameEl.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = old;
    nameEl.appendChild(input);
    input.focus();
    input.select();
    let saved = false;
    const finish = async () => {
      if (saved) return;
      saved = true;
      const v = input.value.trim();
      if (v && v !== old) {
        await window.api.renameMatter(state.matter.id, v);
        await loadAll(state.matter.id);
      } else {
        renderBoard();
      }
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { saved = true; renderBoard(); }
    });
  });

  head.appendChild(nameEl);

  // 操作排：办案日志 / 邮寄记录 / 期限提醒开关
  const acts = document.createElement('div');
  acts.className = 'cover-actions';

  // 直达案件文件夹：已关联则一键打开，未关联则先选择
  const curFolder = (state.matters.find(x => x.id === state.matter.id) || {}).folder || '';
  const dirBtn = document.createElement('button');
  dirBtn.className = 'cover-act';
  dirBtn.innerHTML = '📁 文件夹';
  dirBtn.title = curFolder ? `打开：${curFolder}` : '点击关联该案件的本地文件夹';
  dirBtn.addEventListener('click', async () => {
    let p = curFolder;
    if (!p) {
      p = await window.api.chooseFolder(`为「${state.matter.name}」选择案件文件夹`);
      if (!p) return;
      await window.api.setMatterFolder(state.matter.id, p);
      await loadAll(state.matter.id);
    }
    const err = await window.api.openFolder(p);
    if (err) {
      if (confirm(`${err}。\n重新选择该案件的文件夹？`)) {
        const np = await window.api.chooseFolder(`为「${state.matter.name}」重新选择文件夹`);
        if (np) {
          await window.api.setMatterFolder(state.matter.id, np);
          await loadAll(state.matter.id);
          window.api.openFolder(np);
        }
      }
    }
  });
  acts.appendChild(dirBtn);

  const logBtn = document.createElement('button');
  logBtn.className = 'cover-act';
  logBtn.innerHTML = `📓 日志 <span class="cnt" id="cnt-logs"></span>`;
  logBtn.title = '办案日志';
  logBtn.addEventListener('click', () => openRecords('logs'));

  const mailBtn = document.createElement('button');
  mailBtn.className = 'cover-act';
  mailBtn.innerHTML = `📮 邮寄 <span class="cnt" id="cnt-mails"></span>`;
  mailBtn.title = '邮寄记录';
  mailBtn.addEventListener('click', () => openRecords('mails'));

  const remindOn = !!(state.matters.find(x => x.id === state.matter.id) || {}).remind;
  const bellBtn = document.createElement('button');
  bellBtn.className = 'cover-act' + (remindOn ? ' bell-on' : '');
  bellBtn.innerHTML = remindOn ? '🔔 提醒中' : '🔕 提醒关';
  bellBtn.title = remindOn ? '该案件已开启期限提醒（自动扫描封皮中的日期）' : '点击开启该案件的期限提醒';
  bellBtn.addEventListener('click', async () => {
    const turningOn = !remindOn;
    await window.api.setMatterRemind(state.matter.id, turningOn);
    await loadAll(state.matter.id);
    const { focus } = await refreshBell();
    if (turningOn && !focus.some(it => it.matter_id === state.matter.id)) {
      notify('提醒已开启，但该案件封皮中暂未发现可识别的日期。\n\n在任意要素的内容里填上日期即可被自动扫描，例如：\n上诉截止日：2026-06-28\n开庭日期：2026年7月1日 上午9:30\n\n临期 7 天内会亮起顶栏铃铛红点并弹系统通知。', '提醒已开启');
    }
  });

  acts.appendChild(logBtn);
  acts.appendChild(mailBtn);
  acts.appendChild(bellBtn);
  head.appendChild(acts);
  col.appendChild(head);

  // 异步填充计数
  window.api.recordCounts(state.matter.id).then(c => {
    const l = document.getElementById('cnt-logs');
    const m = document.getElementById('cnt-mails');
    if (l) l.textContent = c.logs || '';
    if (m) m.textContent = c.mails || '';
  });

  const body = document.createElement('div');
  body.className = 'cover-body';

  const group = document.createElement('div');
  group.className = 'cover-group';
  state.matter.cover_info.forEach((pair, idx) => {
    group.appendChild(renderCoverField(pair, idx));
  });
  body.appendChild(group);
  body.appendChild(renderCoverAddField());

  // 复制案件信息按钮
  const copyBtn = document.createElement('button');
  copyBtn.className = 'cover-copy-btn';
  copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><span>复制案件信息</span>';
  copyBtn.title = '把案件名与全部封皮要素复制为规整文本，便于发给当事人或同事';
  copyBtn.addEventListener('click', () => copyMatterInfo(copyBtn));
  body.appendChild(copyBtn);

  attachScrollHint(body);

  col.appendChild(body);
  return col;
}

function copyMatterInfo(btn) {
  if (!state.matter) return;
  const lines = [state.matter.name];
  lines.push('—'.repeat(12));
  for (const [k, v] of state.matter.cover_info) {
    if (String(v).trim()) lines.push(k + '：' + v);
  }
  const text = lines.join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const span = btn.querySelector('span');
    const old = span.textContent;
    span.textContent = '已复制 ✓';
    btn.classList.add('copied');
    setTimeout(() => { span.textContent = old; btn.classList.remove('copied'); }, 1500);
  }).catch(() => {
    // 退路：用临时 textarea
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    const span = btn.querySelector('span');
    span.textContent = '已复制 ✓';
    setTimeout(() => { span.textContent = '复制案件信息'; }, 1500);
  });
}

function renderCoverField(pair, idx) {
  const [label, value] = pair;
  const field = document.createElement('div');
  field.className = 'cover-field';

  const labelEl = document.createElement('div');
  labelEl.className = 'cover-label';
  const labelText = document.createElement('span');
  labelText.textContent = label;
  const delBtn = document.createElement('button');
  delBtn.className = 'field-del';
  delBtn.textContent = '✕';
  delBtn.title = '删除该要素';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!await confirmDialog({ title: '删除要素', body: '删除要素「' + label + '」？', okText: '删除', danger: true })) return;
    const cover = state.matter.cover_info.slice();
    cover.splice(idx, 1);
    await window.api.updateCover(state.matter.id, cover);
    refreshMatter();
  });
  labelEl.appendChild(labelText);
  labelEl.appendChild(delBtn);

  const valueEl = document.createElement('div');
  valueEl.className = 'cover-value' + (value ? '' : ' empty');
  valueEl.textContent = value || '点击填写';

  field.addEventListener('click', (e) => {
    if (e.target === delBtn) return;
    if (field.dataset.editing === '1') return;
    field.dataset.editing = '1';
    field.classList.add('editing');

    valueEl.classList.remove('empty');
    valueEl.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.value = value || '';
    ta.rows = 1;
    valueEl.appendChild(ta);
    const autosize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    autosize();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener('input', autosize);

    let saved = false;
    const finish = async () => {
      if (saved) return;
      saved = true;
      const cover = state.matter.cover_info.slice();
      cover[idx] = [label, ta.value.trim()];
      await window.api.updateCover(state.matter.id, cover);
      refreshMatter();
    };
    ta.addEventListener('blur', finish);
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ta.blur(); }
      if (ev.key === 'Escape') { saved = true; refreshMatter(); }
    });
  });

  field.appendChild(labelEl);
  field.appendChild(valueEl);
  return field;
}

function renderCoverAddField() {
  const wrap = document.createElement('div');

  const btn = document.createElement('button');
  btn.className = 'cover-add-field';
  btn.textContent = '＋ 添加要素';

  btn.addEventListener('click', () => {
    wrap.innerHTML = '';
    const editor = document.createElement('div');
    editor.className = 'cover-add-editor';
    const keyInput = document.createElement('input');
    keyInput.className = 'add-key';
    keyInput.placeholder = '要素名称（如：财产保全到期日）';
    const valInput = document.createElement('input');
    valInput.className = 'add-val';
    valInput.placeholder = '内容（可留空）';
    editor.appendChild(keyInput);
    editor.appendChild(valInput);
    wrap.appendChild(editor);
    keyInput.focus();

    let saved = false;
    const finish = async () => {
      if (saved) return;
      saved = true;
      const k = keyInput.value.trim();
      if (!k) { refreshMatter(); return; }
      const cover = state.matter.cover_info.slice();
      cover.push([k, valInput.value.trim()]);
      await window.api.updateCover(state.matter.id, cover);
      refreshMatter();
    };

    const onKey = (e, next) => {
      if (e.key === 'Enter') { e.preventDefault(); next ? next.focus() : finish(); }
      if (e.key === 'Escape') { saved = true; refreshMatter(); }
    };
    keyInput.addEventListener('keydown', (e) => onKey(e, valInput));
    valInput.addEventListener('keydown', (e) => onKey(e, null));
    editor.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!editor.contains(document.activeElement)) finish();
      }, 0);
    });
  });

  wrap.appendChild(btn);
  return wrap;
}

/* ---------- 4.2 阶段列 ---------- */
function renderStageColumn(stage) {
  const col = document.createElement('div');
  col.className = 'column';
  col.dataset.stageId = stage.id;

  const pending = stage.tasks.filter(t => !t.is_completed);
  const done = stage.tasks
    .filter(t => t.is_completed)
    .sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')));

  const head = document.createElement('div');
  head.className = 'column-head';
  // 列头可拖动以重排阶段顺序
  head.draggable = true;
  head.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/stage', String(stage.id));
    e.dataTransfer.effectAllowed = 'move';
    col.classList.add('stage-dragging');
  });
  head.addEventListener('dragend', () => col.classList.remove('stage-dragging'));
  // 列作为放置目标
  col.addEventListener('dragover', (e) => {
    const types = e.dataTransfer.types || [];
    if (types.includes && types.includes('text/stage')) {
      e.preventDefault();
      col.classList.add('stage-drop-target');
    }
  });
  col.addEventListener('dragleave', () => col.classList.remove('stage-drop-target'));
  col.addEventListener('drop', async (e) => {
    const types = e.dataTransfer.types || [];
    if (!(types.includes && types.includes('text/stage'))) return;
    e.preventDefault();
    col.classList.remove('stage-drop-target');
    const draggedId = parseInt(e.dataTransfer.getData('text/stage'), 10);
    if (!draggedId || draggedId === stage.id) return;
    const order = state.matter.stages.map(s => s.id);
    const targetIdx = order.indexOf(stage.id);
    await window.api.moveStage(draggedId, targetIdx);
    refreshMatter();
  });

  const title = document.createElement('div');
  title.className = 'column-title';
  title.textContent = stage.name;
  title.title = '双击重命名';
  title.addEventListener('dblclick', () => {
    inlineEditText(title, stage.name, async (val) => {
      const v = val.trim();
      if (v && v !== stage.name) await window.api.renameStage(stage.id, v);
      refreshMatter();
    });
  });

  const count = document.createElement('span');
  count.className = 'column-count';
  count.textContent = `${pending.length}`;

  const del = document.createElement('button');
  del.className = 'column-del';
  del.textContent = '✕';
  del.title = '删除该列';
  del.addEventListener('click', async () => {
    if (!await confirmDialog({ title: '删除阶段', body: '删除阶段「' + stage.name + '」及其全部卡片？', okText: '删除', danger: true })) return;
    await window.api.deleteStage(stage.id);
    refreshMatter();
  });

  head.appendChild(title);
  head.appendChild(count);
  head.appendChild(del);
  col.appendChild(head);

  const body = document.createElement('div');
  body.className = 'column-body';

  const listEl = document.createElement('div');
  listEl.className = 'task-list';
  listEl.dataset.stageId = stage.id;
  pending.forEach(t => listEl.appendChild(renderCard(t)));
  bindDropZone(listEl, stage.id);
  body.appendChild(listEl);

  const foot = document.createElement('div');
  foot.className = 'column-foot';
  foot.appendChild(renderAddCard(stage.id));

  if (done.length) {
    const divider = document.createElement('div');
    divider.className = 'done-divider';
    const open = state.showDoneStages.has(stage.id);
    divider.textContent = open ? `已完成 ${done.length} 项 · 收起` : `已完成 ${done.length} 项 · 展开`;
    divider.addEventListener('click', () => {
      open ? state.showDoneStages.delete(stage.id) : state.showDoneStages.add(stage.id);
      renderBoard();
    });
    foot.appendChild(divider);

    if (open) {
      const doneWrap = document.createElement('div');
      done.forEach(t => doneWrap.appendChild(renderCard(t)));
      foot.appendChild(doneWrap);
    }
  }

  body.appendChild(foot);
  attachScrollHint(body);
  col.appendChild(body);
  return col;
}

/* ---------- 4.3 任务卡片 ---------- */
function renderCard(task) {
  const card = document.createElement('div');
  card.className = 'card' + (task.is_completed ? ' completed' : '');
  card.dataset.taskId = task.id;
  card.draggable = !task.is_completed;

  const circle = document.createElement('button');
  circle.className = 'card-circle' + (task.is_completed ? ' checked' : '');
  circle.title = task.is_completed ? '恢复为未完成' : '完成并划掉';

  const content = document.createElement('div');
  content.className = 'card-content';
  content.textContent = task.content;

  const del = document.createElement('button');
  del.className = 'card-del';
  del.textContent = '✕';
  del.title = '删除卡片';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!await confirmDialog({ title: '删除卡片', body: '删除该卡片？', okText: '删除', danger: true })) return;
    await window.api.deleteTask(task.id);
    refreshMatter();
  });

  // 截止日期按钮（设了就进日程）
  const dueBtn = document.createElement('button');
  const dueInfo = task.due_date ? formatDue(task.due_date) : null;
  dueBtn.className = 'card-due-btn' + (task.due_date ? ' has-due' : '') + (dueInfo && dueInfo.urgent ? ' due-urgent' : '') + (dueInfo && dueInfo.over ? ' due-over' : '');
  dueBtn.title = task.due_date ? ('截止 ' + task.due_date + '（已加入日程，点击修改）') : '设置截止日期（设置后进入日程与提醒）';
  dueBtn.innerHTML = task.due_date
    ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></svg><span>' + dueInfo.text + '</span>'
    : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></svg>';
  dueBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openTaskDuePicker(task, dueBtn);
  });

  circle.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (task.is_completed) {
      await window.api.completeTask(task.id, false);
      refreshMatter();
      return;
    }
    playDing();
    circle.classList.add('checked');
    card.classList.add('done-anim');
    setTimeout(() => card.classList.add('fading'), 620);
    setTimeout(async () => {
      await window.api.completeTask(task.id, true);
      refreshMatter();
    }, 1000);
  });

  if (!task.is_completed) {
    content.addEventListener('click', () => {
      inlineEditTextarea(content, task.content, async (val) => {
        const v = val.trim();
        if (v && v !== task.content) await window.api.updateTask(task.id, v);
        refreshMatter();
      });
    });

    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      e.dataTransfer.setData('text/task-id', String(task.id));
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  }

  card.appendChild(circle);
  card.appendChild(content);
  if (!task.is_completed) card.appendChild(dueBtn);
  card.appendChild(del);
  return card;
}

// 把截止日期格式化为"MM/DD · 还剩X天"，并标记紧急/逾期
function formatDue(dateStr) {
  const md = dateStr.slice(5).replace('-', '/'); // 06/20
  const d = dayDiff(dateStr); // 距今天数：>0 未来，0 今天，<0 已过
  let rel, urgent = false, over = false;
  if (d > 0) { rel = '还剩 ' + d + ' 天'; if (d <= 3) urgent = true; }
  else if (d === 0) { rel = '今天'; urgent = true; }
  else { rel = '已过 ' + (-d) + ' 天'; over = true; }
  return { text: md + ' · ' + rel, urgent, over };
}

// 任务截止日期选择：用一个原生 date input 弹出选择，设/清后刷新
function openTaskDuePicker(task, anchorBtn) {
  const input = document.createElement('input');
  input.type = 'date';
  input.value = task.due_date || '';
  input.className = 'task-due-input';
  document.body.appendChild(input);
  const rect = anchorBtn.getBoundingClientRect();
  input.style.position = 'fixed';
  input.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
  input.style.top = (rect.bottom + 4) + 'px';
  input.style.zIndex = '9999';
  input.focus();
  try { input.showPicker && input.showPicker(); } catch (e) {}
  let done = false;
  const finish = async (val) => {
    if (done) return; done = true;
    input.remove();
    if (val !== (task.due_date || '')) {
      await window.api.setTaskDue(task.id, val || null);
      refreshMatter();
      if (currentView === 'home') renderHome();
    }
  };
  input.addEventListener('change', () => finish(input.value));
  input.addEventListener('blur', () => setTimeout(() => finish(input.value), 150));
  // 右键或按 Delete 清除日期
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { done = true; input.remove(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && task.due_date) { finish(''); }
  });
}

/* ---------- 4.4 添加新任务 ---------- */
function renderAddCard(stageId) {
  const wrap = document.createElement('div');

  const btn = document.createElement('button');
  btn.className = 'add-card-btn';
  btn.textContent = '＋ 添加新任务';

  btn.addEventListener('click', () => {
    wrap.innerHTML = '';
    const editor = document.createElement('div');
    editor.className = 'add-card-editor';
    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = '输入任务内容…';
    const hint = document.createElement('div');
    hint.className = 'add-card-hint';
    hint.textContent = 'Enter 保存 · Shift+Enter 换行 · Esc 取消';
    editor.appendChild(ta);
    editor.appendChild(hint);
    wrap.appendChild(editor);
    ta.focus();

    const save = async () => {
      const v = ta.value.trim();
      if (v) {
        await window.api.addTask(stageId, v);
        await refreshMatter();
        const col = document.querySelector(`.column[data-stage-id="${stageId}"]`);
        if (col) {
          const b = col.querySelector('.add-card-btn');
          if (b) b.click();
        }
      } else {
        refreshMatter();
      }
    };

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      if (e.key === 'Escape') refreshMatter();
    });
    ta.addEventListener('blur', () => {
      const v = ta.value.trim();
      v ? save() : refreshMatter();
    });
  });

  wrap.appendChild(btn);
  return wrap;
}

/* ---------- 4.5 拖拽落点 ---------- */
function bindDropZone(listEl, stageId) {
  let indicator = null;
  const clearIndicator = () => { if (indicator) { indicator.remove(); indicator = null; } };

  const getInsertIndex = (y) => {
    const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return i;
    }
    return cards.length;
  };

  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const idx = getInsertIndex(e.clientY);
    clearIndicator();
    indicator = document.createElement('div');
    indicator.className = 'drop-indicator';
    const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];
    if (idx >= cards.length) listEl.appendChild(indicator);
    else listEl.insertBefore(indicator, cards[idx]);
  });

  listEl.addEventListener('dragleave', (e) => {
    if (!listEl.contains(e.relatedTarget)) clearIndicator();
  });

  listEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    const idx = getInsertIndex(e.clientY);
    clearIndicator();
    const taskId = parseInt(e.dataTransfer.getData('text/task-id'), 10);
    if (!taskId) return;
    await window.api.moveTask(taskId, stageId, idx);
    refreshMatter();
  });
}

/* ============================================================
   五、原位编辑通用器
   ============================================================ */
function inlineEditText(el, initial, onSave) {
  if (el.dataset.editing === '1') return;
  el.dataset.editing = '1';
  el.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = initial || '';
  el.appendChild(input);
  input.focus();
  input.select();

  let saved = false;
  const finish = () => { if (saved) return; saved = true; onSave(input.value); };
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { saved = true; onSave(initial || ''); }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
}

function inlineEditTextarea(el, initial, onSave) {
  if (el.dataset.editing === '1') return;
  el.dataset.editing = '1';
  el.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.value = initial || '';
  ta.rows = 1;
  el.appendChild(ta);
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  autosize();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener('input', autosize);

  let saved = false;
  const finish = () => { if (saved) return; saved = true; onSave(ta.value); };
  ta.addEventListener('blur', finish);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
    if (e.key === 'Escape') { saved = true; onSave(initial || ''); }
  });
  ta.addEventListener('click', (e) => e.stopPropagation());
}

/* ============================================================
   六、新建案件
   ============================================================ */
async function reloadTemplates() {
  state.templates = await window.api.listTemplates();
}

let nmParent = '';

async function openNewMatterModal() {
  state.selectedTemplate = null;
  $('#new-matter-name').value = '';
  nmParent = (await window.api.getSetting('folder_parent')) || '';
  $('#nm-parent').textContent = nmParent || '未选择位置';
  $('#nm-parent').title = nmParent;
  $('#nm-mkdir').checked = !!nmParent && $('#nm-mkdir').checked;
  const grid = $('#template-grid');
  grid.innerHTML = '';

  for (const tpl of state.templates) {
    const card = document.createElement('div');
    card.className = 'template-card';
    card.dataset.key = tpl.key;
    const nameDiv = document.createElement('div');
    nameDiv.className = 't-name';
    nameDiv.innerHTML = `${anyIconHtml(tpl.icon, 14)} `;
    nameDiv.appendChild(document.createTextNode(tpl.name));
    const stagesDiv = document.createElement('div');
    stagesDiv.className = 't-stages';
    stagesDiv.textContent = tpl.description
      || tpl.stages.map(s => s.name.replace('📂 ', '')).join(' → ');
    card.appendChild(nameDiv);
    card.appendChild(stagesDiv);
    card.addEventListener('click', () => {
      grid.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      state.selectedTemplate = tpl.key;
    });
    grid.appendChild(card);
  }
  attachScrollHint(grid);

  $('#modal-mask').classList.remove('hidden');
  $('#new-matter-name').focus();
}

async function createFromModal() {
  if (!state.selectedTemplate) {
    notify('请先选择一套案件模板。');
    return;
  }
  const name = $('#new-matter-name').value.trim();
  const newId = await window.api.createMatter(name || null, state.selectedTemplate);

  // 同时建立案件文件夹
  if ($('#nm-mkdir').checked) {
    let parent = nmParent;
    if (!parent) parent = await window.api.chooseFolder('选择案件文件夹的存放位置');
    if (parent) {
      await window.api.setSetting('folder_parent', parent);
      try {
        const created = await window.api.createFolderIn(parent, name || '案件名称');
        await window.api.setMatterFolder(newId, created);
      } catch (e) {
        notify('文件夹创建失败：' + (e && e.message ? e.message : e));
      }
    }
  }

  $('#modal-mask').classList.add('hidden');
  await loadAll(newId);
}

/* ============================================================
   七、案件管理：批量改名 / 批量删除 / 备份所有案件
   ============================================================ */
function openMatterManager() {
  state.mmSelected = new Set();
  switchMmMode('matters');
  renderMmList();
  $('#mm-mask').classList.remove('hidden');
}

async function closeMatterManager() {
  $('#mm-mask').classList.add('hidden');
  await loadAll(state.currentId);
}

function syncMmToolbar() {
  const n = state.mmSelected.size;
  $('#mm-count').textContent = n ? `已选 ${n} 个` : '';
  $('#mm-delete').disabled = n === 0;
  const all = $('#mm-select-all');
  all.checked = n > 0 && n === state.matters.length;
  all.indeterminate = n > 0 && n < state.matters.length;
}

function renderMmList() {
  const list = $('#mm-list');
  list.innerHTML = '';

  if (!state.matters.length) {
    const empty = document.createElement('div');
    empty.className = 'matter-list-empty';
    empty.textContent = '暂无案件';
    list.appendChild(empty);
    syncMmToolbar();
    return;
  }

  for (const m of state.matters) {
    const row = document.createElement('div');
    row.className = 'mm-row' + (state.mmSelected.has(m.id) ? ' checked' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.mmSelected.has(m.id);
    cb.addEventListener('change', () => {
      cb.checked ? state.mmSelected.add(m.id) : state.mmSelected.delete(m.id);
      row.classList.toggle('checked', cb.checked);
      syncMmToolbar();
    });

    const iconBtn = document.createElement('button');
    iconBtn.className = 'mm-icon-btn';
    iconBtn.title = '更换图标';
    iconBtn.innerHTML = mfIconSvg(mfMatterIcon(m), 15);
    iconBtn.addEventListener('click', () => {
      openIconPicker(mfMatterIcon(m), async (name) => {
        await window.api.setMatterIcon(m.id, name);
        await loadAll(state.currentId);
        renderMmList();
      });
    });

    const dirBtn2 = document.createElement('button');
    dirBtn2.className = 'mm-icon-btn';
    dirBtn2.textContent = '📁';
    dirBtn2.title = m.folder ? `已关联：${m.folder}（点击更换）` : '关联案件文件夹';
    dirBtn2.style.opacity = m.folder ? '1' : '0.45';
    dirBtn2.addEventListener('click', async () => {
      const p = await window.api.chooseFolder(`为「${m.name}」选择案件文件夹`);
      if (!p) return;
      await window.api.setMatterFolder(m.id, p);
      state.matters = await window.api.listMatters();
      renderMmList();
    });

    const cloneBtn = document.createElement('button');
    cloneBtn.className = 'mm-icon-btn';
    cloneBtn.textContent = '⎘';
    cloneBtn.title = '克隆此案件（含阶段与任务，生成「副本」）';
    cloneBtn.addEventListener('click', async () => {
      const newId = await window.api.cloneMatter(m.id);
      state.matters = await window.api.listMatters();
      renderMmList();
      renderSidebar();
    });

    const archBtn = document.createElement('button');
    archBtn.className = 'mm-icon-btn';
    archBtn.textContent = '📥';
    archBtn.title = '归档此案件（移出「我的案件」，数据保留，可随时恢复）';
    archBtn.addEventListener('click', async () => {
      await window.api.setMatterArchived(m.id, true);
      if (state.currentId === m.id) { state.currentId = null; state.matter = null; }
      state.matters = await window.api.listMatters();
      renderMmList();
      renderSidebar();
      if (currentView === 'board' && !state.currentId) showView('home');
    });

    // 名称直接编辑，失焦自动保存（批量改名）
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'mm-name';
    nameInput.value = m.name;
    nameInput.addEventListener('blur', async () => {
      const v = nameInput.value.trim();
      if (v && v !== m.name) {
        await window.api.renameMatter(m.id, v);
        m.name = v;
      } else {
        nameInput.value = m.name;
      }
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
      if (e.key === 'Escape') { nameInput.value = m.name; nameInput.blur(); }
    });

    const tag = document.createElement('span');
    tag.className = 'matter-type-tag';
    tag.textContent = m.type;

    row.appendChild(cb);
    row.appendChild(iconBtn);
    row.appendChild(dirBtn2);
    row.appendChild(cloneBtn);
    row.appendChild(archBtn);
    row.appendChild(nameInput);
    row.appendChild(tag);
    list.appendChild(row);
  }
  attachScrollHint(list);
  syncMmToolbar();
}

function notify(body, title) {
  return new Promise((resolve) => {
    const mask = $('#notify-mask');
    $('#notify-title').textContent = title || '提示';
    $('#notify-body').textContent = body || '';
    mask.classList.remove('hidden');
    const ok = $('#notify-ok');
    const done = () => {
      mask.classList.add('hidden');
      ok.removeEventListener('click', done);
      mask.removeEventListener('click', onMask);
      resolve();
    };
    const onMask = (e) => { if (e.target === mask) done(); };
    ok.addEventListener('click', done);
    mask.addEventListener('click', onMask);
  });
}

async function renderArchivedList() {
  const list = $('#mm-arch-list');
  list.innerHTML = '';
  const arch = await window.api.listArchivedMatters();
  if (!arch.length) {
    const e = document.createElement('div');
    e.className = 'bk-empty';
    e.textContent = '还没有归档的案件。在「案件列表」中点某个案件的 📥 即可归档。';
    list.appendChild(e);
    return;
  }
  for (const m of arch) {
    const row = document.createElement('div');
    row.className = 'mm-row';
    const name = document.createElement('span');
    name.className = 'mm-arch-name';
    name.textContent = m.name;
    const tag = document.createElement('span');
    tag.className = 'matter-type-tag';
    tag.textContent = m.type;
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'btn btn-glass mm-arch-restore';
    restoreBtn.textContent = '取消归档';
    restoreBtn.addEventListener('click', async () => {
      await window.api.setMatterArchived(m.id, false);
      state.matters = await window.api.listMatters();
      renderArchivedList();
      renderSidebar();
    });
    row.appendChild(name);
    row.appendChild(tag);
    row.appendChild(restoreBtn);
    list.appendChild(row);
  }
  attachScrollHint(list);
}

function confirmDialog(opts) {
  return new Promise((resolve) => {
    const mask = $('#confirm-mask');
    $('#confirm-title').textContent = opts.title || '确认';
    $('#confirm-body').textContent = opts.body || '';
    const okBtn = $('#confirm-ok'), cancelBtn = $('#confirm-cancel');
    okBtn.textContent = opts.okText || '确定';
    cancelBtn.textContent = opts.cancelText || '取消';
    okBtn.className = 'btn ' + (opts.danger ? 'btn-danger-solid' : 'btn-primary');
    mask.classList.remove('hidden');
    const cleanup = (val) => {
      mask.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      mask.removeEventListener('click', onMask);
      resolve(val);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onMask = (e) => { if (e.target === mask) cleanup(false); };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    mask.addEventListener('click', onMask);
  });
}

async function mmDeleteSelected() {
  const ids = [...state.mmSelected];
  if (!ids.length) return;
  const names = state.matters.filter(m => ids.includes(m.id)).map(m => m.name);
  const preview = names.slice(0, 5).join('、') + (names.length > 5 ? ` 等 ${names.length} 个案件` : '');
  // 二次确认
  const ok = await confirmDialog({
    title: '确认删除案件',
    body: '将删除以下案件：\n\n' + preview + '\n\n该操作不可恢复。',
    okText: '删除', danger: true
  });
  if (!ok) return;
  if (!await confirmDialog({ title: '再次确认删除', body: '将永久删除 ' + ids.length + ' 个案件及其全部阶段与卡片。此操作不可恢复。', okText: '永久删除', danger: true })) return;

  for (const id of ids) await window.api.deleteMatter(id);
  state.matters = await window.api.listMatters();
  state.mmSelected = new Set();
  renderMmList();
}

const BK_REASON = {
  manual: '手动', auto: '自动（12h）', 'pre-restore': '恢复前留底', 'pre-import': '导入前留底'
};
function bkReasonText(r) {
  if (BK_REASON[r]) return BK_REASON[r];
  if (r && r.indexOf('upgrade-from-v') === 0) return '升级前留底';
  return r || '手动';
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function fmtWhen(isoStr) {
  const d = new Date(isoStr);
  if (isNaN(d)) return isoStr;
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

let mmMode = 'matters';
function switchMmMode(mode) {
  mmMode = mode;
  document.querySelectorAll('#mm-mode-tabs button').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  $('#mm-pane-matters').classList.toggle('hidden', mode !== 'matters');
  $('#mm-pane-archived').classList.toggle('hidden', mode !== 'archived');
  $('#mm-pane-backup').classList.toggle('hidden', mode !== 'backup');
  if (mode === 'archived') renderArchivedList();
  if (mode === 'backup') renderBackupList();
}

async function renderBackupList() {
  const list = $('#bk-list');
  list.innerHTML = '';
  const baks = await window.api.backupList();
  if (!baks.length) {
    const e = document.createElement('div');
    e.className = 'bk-empty';
    e.textContent = '还没有备份。点上方按钮可手动备份；系统也会每 12 小时自动备份。';
    list.appendChild(e);
    return;
  }
  for (const b of baks) {
    const item = document.createElement('div');
    item.className = 'bk-item';
    item.innerHTML = '<span class="bk-when">' + fmtWhen(b.when) + '</span>' +
      '<span class="bk-reason">' + bkReasonText(b.reason) + '</span>' +
      '<span class="bk-size">' + fmtBytes(b.size) + '</span>' +
      '<button class="btn btn-glass bk-restore">恢复到此</button>';
    item.querySelector('.bk-restore').addEventListener('click', async () => {
      if (!await confirmDialog({ title: '恢复备份', body: '恢复到 ' + fmtWhen(b.when) + ' 的备份？\n\n当前数据会先自动备份一份，然后被该备份覆盖。', okText: '恢复' })) return;
      await window.api.backupRestore(b.path);
      await loadAll();
      renderBackupList();
      notify('已恢复。当前状态已在恢复前自动备份留底。');
    });
    list.appendChild(item);
  }
  attachScrollHint(list);
}

async function backupNow() {
  const btn = $('#bk-now');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '备份中…';
  try {
    await window.api.backupRun();
    btn.textContent = '已备份 ✓';
    await renderBackupList();
  } catch (e) {
    notify('备份失败：' + (e && e.message ? e.message : e));
  }
  setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1400);
}

/* ============================================================
   八、模板编辑器（含新建、删除、自动备份与还原）
   ============================================================ */
const FACTORY_KEYS = new Set(['zhixing', 'minshangshi', 'xingshi', 'feisu', 'xingzheng']);

function openTemplateManager() {
  state.tplEditingKey = state.templates.length ? state.templates[0].key : null;
  state.tplView = 'edit';
  renderTplList();
  renderTplEditor();
  syncTplActions();
  $('#tpl-mask').classList.remove('hidden');
}

function syncTplActions() {
  const isFactory = FACTORY_KEYS.has(state.tplEditingKey);
  const editMode = state.tplView === 'edit';
  $('#btn-tpl-reset').classList.toggle('hidden', !editMode || !isFactory);
  $('#btn-tpl-save').classList.toggle('hidden', !editMode);
  $('#btn-tpl-backups').textContent = editMode ? '备份…' : '返回编辑';
}

function renderTplList() {
  const list = $('#tpl-list');
  list.innerHTML = '';
  for (const tpl of state.templates) {
    const item = document.createElement('div');
    item.className = 'tpl-item' + (tpl.key === state.tplEditingKey ? ' active' : '');

    const label = document.createElement('span');
    label.className = 't-label';
    label.innerHTML = `${anyIconHtml(tpl.icon, 14)} `;
    label.appendChild(document.createTextNode(tpl.name));
    item.appendChild(label);

    if (!FACTORY_KEYS.has(tpl.key)) {
      const del = document.createElement('button');
      del.className = 'tpl-del';
      del.textContent = '✕';
      del.title = '删除该模板';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!await confirmDialog({ title: '删除模板', body: '删除模板「' + tpl.name + '」？\n删除前会自动备份，可在"备份…"中找回。', okText: '删除', danger: true })) return;
        await window.api.deleteTemplate(tpl.key);
        await reloadTemplates();
        if (state.tplEditingKey === tpl.key) {
          state.tplEditingKey = state.templates.length ? state.templates[0].key : null;
        }
        renderTplList();
        renderTplEditor();
        syncTplActions();
      });
      item.appendChild(del);
    }

    item.addEventListener('click', () => {
      state.tplEditingKey = tpl.key;
      state.tplView = 'edit';
      renderTplList();
      renderTplEditor();
      syncTplActions();
    });
    list.appendChild(item);
  }
}

function renderTplEditor() {
  if (state.tplView === 'backups') { renderBackupPanel(); return; }
  const editor = $('#tpl-editor');
  editor.innerHTML = '';
  const tpl = state.templates.find(t => t.key === state.tplEditingKey);
  if (!tpl) return;

  const row = document.createElement('div');
  row.className = 'tpl-row';
  row.innerHTML = `
    <div class="tpl-field narrow"><label>图标</label><button id="tpl-icon-btn" class="tpl-icon-btn" title="点击更换模板图标"></button></div>
    <div class="tpl-field"><label>模板名称</label><input id="tpl-name" type="text"></div>
    <div class="tpl-field narrow" style="flex-basis:110px"><label>案件类型</label><input id="tpl-type" type="text"></div>`;
  editor.appendChild(row);
  editor.dataset.icon = tpl.icon || 'folder';
  const tplIconBtn = $('#tpl-icon-btn', editor);
  tplIconBtn.innerHTML = anyIconHtml(editor.dataset.icon, 17);
  tplIconBtn.addEventListener('click', () => {
    openIconPicker(editor.dataset.icon, (name) => {
      editor.dataset.icon = name;
      tplIconBtn.innerHTML = anyIconHtml(name, 17);
    });
  });
  $('#tpl-name', editor).value = tpl.name;
  $('#tpl-type', editor).value = tpl.type;

  const descRow = document.createElement('div');
  descRow.className = 'tpl-row';
  descRow.innerHTML = `
    <div class="tpl-field"><label>模板描述（新建案件时显示）</label><input id="tpl-desc" type="text" placeholder="一句话说明这套模板适用的案件类型与流程"></div>`;
  editor.appendChild(descRow);
  $('#tpl-desc', editor).value = tpl.description || '';

  const coverTitle = document.createElement('div');
  coverTitle.className = 'tpl-section-title';
  coverTitle.innerHTML = `案件信息要素 <span class="hint">每行一个要素名称</span>`;
  editor.appendChild(coverTitle);

  const coverField = document.createElement('div');
  coverField.className = 'tpl-field';
  const coverTa = document.createElement('textarea');
  coverTa.id = 'tpl-cover';
  coverTa.rows = Math.min(10, tpl.cover.length + 1);
  coverTa.value = tpl.cover.map(p => p[0]).join('\n');
  coverField.appendChild(coverTa);
  editor.appendChild(coverField);

  const stageTitle = document.createElement('div');
  stageTitle.className = 'tpl-section-title';
  stageTitle.innerHTML = `阶段与初始任务 <span class="hint">每个阶段下方文本框中，每行一条任务</span>`;
  editor.appendChild(stageTitle);

  const stagesWrap = document.createElement('div');
  stagesWrap.id = 'tpl-stages';

  const addStageRow = (name = '📂 新阶段', tasks = []) => {
    const box = document.createElement('div');
    box.className = 'tpl-stage';

    const head = document.createElement('div');
    head.className = 'tpl-stage-head';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'tpl-stage-name';
    nameInput.value = name;
    const delBtn = document.createElement('button');
    delBtn.className = 'tpl-stage-del';
    delBtn.textContent = '✕';
    delBtn.title = '删除该阶段';
    delBtn.addEventListener('click', () => box.remove());
    head.appendChild(nameInput);
    head.appendChild(delBtn);

    const ta = document.createElement('textarea');
    ta.className = 'tpl-stage-tasks';
    ta.rows = Math.max(3, Math.min(10, tasks.length + 1));
    ta.value = tasks.join('\n');

    box.appendChild(head);
    box.appendChild(ta);
    stagesWrap.appendChild(box);
  };

  tpl.stages.forEach(s => addStageRow(s.name, s.tasks));
  editor.appendChild(stagesWrap);

  const addBtn = document.createElement('button');
  addBtn.className = 'tpl-add-stage';
  addBtn.textContent = '＋ 添加阶段';
  addBtn.addEventListener('click', () => addStageRow());
  editor.appendChild(addBtn);
  attachScrollHint(editor);
}

async function saveTemplateFromEditor() {
  const key = state.tplEditingKey;
  if (!key || state.tplView !== 'edit') return;
  const editor = $('#tpl-editor');

  const cover = $('#tpl-cover', editor).value
    .split('\n').map(s => s.trim()).filter(Boolean)
    .map(k => [k, '']);

  const stages = [...editor.querySelectorAll('.tpl-stage')].map(box => ({
    name: box.querySelector('.tpl-stage-name').value.trim() || '📂 阶段',
    tasks: box.querySelector('.tpl-stage-tasks').value
      .split('\n').map(s => s.trim()).filter(Boolean)
  }));

  await window.api.saveTemplate(key, {
    icon: editor.dataset.icon || 'folder',
    name: $('#tpl-name', editor).value.trim() || '未命名模板',
    type: $('#tpl-type', editor).value.trim() || '民商事',
    description: $('#tpl-desc', editor).value.trim(),
    cover,
    stages
  });
  await reloadTemplates();
  renderTplList();

  const btn = $('#btn-tpl-save');
  const original = btn.textContent;
  btn.textContent = '已保存 ✓';
  btn.classList.add('saved-flash');
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('saved-flash');
  }, 1200);
}

async function resetTemplateFromEditor() {
  const key = state.tplEditingKey;
  if (!key || !FACTORY_KEYS.has(key)) return;
  const tpl = state.templates.find(t => t.key === key);
  if (!confirm(`将模板「${tpl ? tpl.name : ''}」恢复为出厂内容？（恢复前会自动备份当前版本）`)) return;
  await window.api.resetTemplate(key);
  await reloadTemplates();
  renderTplList();
  renderTplEditor();
}

async function createNewTemplate() {
  const key = await window.api.newTemplate();
  await reloadTemplates();
  state.tplEditingKey = key;
  state.tplView = 'edit';
  renderTplList();
  renderTplEditor();
  syncTplActions();
}

const REASON_LABEL = {
  auto: '定期自动', manual: '手动',
  'pre-save': '改动前', 'pre-reset': '恢复出厂前', 'pre-restore': '还原前'
};

function fmtTime(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function renderBackupPanel() {
  const editor = $('#tpl-editor');
  editor.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'bak-head';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = '模板备份';
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = '每 24 小时自动备份一次，每次改动前也会自动备份，保留最近 50 份。还原会覆盖当前全部模板。';
  const bakNow = document.createElement('button');
  bakNow.className = 'btn btn-glass';
  bakNow.style.marginLeft = 'auto';
  bakNow.textContent = '立即备份';
  bakNow.addEventListener('click', async () => {
    await window.api.backupTemplates();
    renderBackupPanel();
  });
  head.appendChild(title);
  head.appendChild(hint);
  head.appendChild(bakNow);
  editor.appendChild(head);

  const baks = await window.api.listTemplateBackups();
  if (!baks.length) {
    const empty = document.createElement('div');
    empty.className = 'bak-empty';
    empty.textContent = '暂无备份。';
    editor.appendChild(empty);
    return;
  }

  for (const b of baks) {
    const item = document.createElement('div');
    item.className = 'bak-item';
    const time = document.createElement('span');
    time.className = 'bak-time';
    time.textContent = fmtTime(b.created_at);
    const reason = document.createElement('span');
    reason.className = 'bak-reason';
    reason.textContent = REASON_LABEL[b.reason] || b.reason;
    const restore = document.createElement('button');
    restore.className = 'btn btn-glass';
    restore.style.marginLeft = 'auto';
    restore.textContent = '还原';
    restore.addEventListener('click', async () => {
      if (!confirm(`还原到 ${fmtTime(b.created_at)} 的模板备份？当前全部模板将被覆盖（还原前会自动再备份一份当前版本）。`)) return;
      await window.api.restoreTemplateBackup(b.id);
      await reloadTemplates();
      state.tplEditingKey = state.templates.length ? state.templates[0].key : null;
      state.tplView = 'edit';
      renderTplList();
      renderTplEditor();
      syncTplActions();
    });
    item.appendChild(time);
    item.appendChild(reason);
    item.appendChild(restore);
    editor.appendChild(item);
  }
}

function toggleBackupView() {
  state.tplView = state.tplView === 'edit' ? 'backups' : 'edit';
  renderTplEditor();
  syncTplActions();
}

/* ============================================================
   七-2、办案日志与邮寄记录
   ============================================================ */
let recTab = 'logs';

function openRecords(tab) {
  recTab = tab || 'logs';
  document.querySelectorAll('#rec-tabs button').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === recTab));
  $('#rec-title').textContent = `案件记录 · ${state.matter.name}`;
  renderRecBody();
  $('#rec-mask').classList.remove('hidden');
}

async function renderRecBody() {
  const body = $('#rec-body');
  body.innerHTML = '';
  if (recTab === 'logs') await renderLogsTab(body);
  else await renderMailsTab(body);
  attachScrollHint(body);
}

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const todayISO = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

async function renderLogsTab(body) {
  // 录入表单：日期 + 工时 + 内容，Enter 即存
  const form = document.createElement('div');
  form.className = 'rec-form';
  form.innerHTML = `
    <div class="row">
      <input type="date" class="w-date" id="lg-date" value="${todayISO()}">
      <input type="number" class="w-hours" id="lg-hours" min="0" step="0.5" placeholder="工时(h)">
      <button id="lg-add" class="btn btn-primary btn-mini">记一笔</button>
    </div>
    <div class="row">
      <textarea id="lg-content" rows="2" placeholder="今天为这个案件做了什么？如：与当事人电话沟通开庭准备 1 小时（Enter 保存，Shift+Enter 换行）"></textarea>
    </div>`;
  body.appendChild(form);

  const save = async () => {
    const content = $('#lg-content', form).value.trim();
    if (!content) return;
    await window.api.addLog(state.matter.id, content, $('#lg-hours', form).value, $('#lg-date', form).value);
    renderRecBody();
    renderBoard(); // 刷新计数
  };
  $('#lg-add', form).addEventListener('click', save);
  $('#lg-content', form).addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
  });

  const logs = await window.api.listLogs(state.matter.id);
  const totalH = logs.reduce((s, l) => s + (l.hours || 0), 0);
  if (logs.length) {
    const sum = document.createElement('div');
    sum.className = 'rec-sum';
    sum.textContent = `共 ${logs.length} 条记录` + (totalH ? `，累计工时 ${totalH} 小时` : '');
    body.appendChild(sum);
  }
  if (!logs.length) {
    body.appendChild(Object.assign(document.createElement('div'), { className: 'rec-empty', textContent: '还没有日志，从上面记下第一笔。' }));
    return;
  }
  for (const l of logs) {
    const item = document.createElement('div');
    item.className = 'rec-item';
    item.innerHTML = `
      <div class="r-date">${l.log_date}</div>
      <div class="r-main">${escapeHtml(l.content)}${l.hours ? `<div class="r-meta">工时 ${l.hours} 小时</div>` : ''}</div>
      <button class="r-del" title="删除">✕</button>`;
    item.querySelector('.r-del').addEventListener('click', async () => {
      if (!confirm('删除这条日志？')) return;
      await window.api.deleteLog(l.id);
      renderRecBody();
      renderBoard();
    });
    body.appendChild(item);
  }
  $('#lg-content', form).focus();
}

async function renderMailsTab(body) {
  const form = document.createElement('div');
  form.className = 'rec-form';
  form.innerHTML = `
    <div class="row">
      <input type="date" class="w-date" id="ml-date" value="${todayISO()}">
      <input type="text" class="w-flex" id="ml-recipient" placeholder="寄往（收件人／单位，如：××区人民法院立案庭）">
    </div>
    <div class="row">
      <input type="text" class="w-flex" id="ml-contents" placeholder="所寄材料（点下方标签快速选择，或直接输入）">
    </div>
    <div class="mtag-row" id="ml-tags"></div>
    <div class="row">
      <div class="courier-chips">
        <button class="courier-chip active" data-c="顺丰">顺丰</button>
        <button class="courier-chip" data-c="EMS">EMS</button>
        <button class="courier-chip" data-c="">其他</button>
      </div>
      <input type="text" class="w-flex hidden" id="ml-courier-other" placeholder="输入快递公司">
      <input type="text" class="w-flex" id="ml-tracking" placeholder="快递单号">
      <button id="ml-add" class="btn btn-primary btn-mini">记一笔</button>
    </div>`;
  body.appendChild(form);

  // 材料快捷标签：默认常用项 + 历史输入自动沉淀
  const DEFAULT_MAIL_TAGS = ['律师函', '代理手续', '委托合同', '授权委托书', '起诉状', '上诉状', '证据材料', '辩护意见'];
  let mailTags;
  try { mailTags = JSON.parse(await window.api.getSetting('mail_tags')) || DEFAULT_MAIL_TAGS.slice(); }
  catch (_) { mailTags = DEFAULT_MAIL_TAGS.slice(); }

  const contentsInput = $('#ml-contents', form);
  const tagsEl = $('#ml-tags', form);
  const saveTags = () => window.api.setSetting('mail_tags', JSON.stringify(mailTags));
  const renderMailTags = () => {
    tagsEl.innerHTML = '';
    for (const t of mailTags) {
      const chip = document.createElement('button');
      chip.className = 'mtag';
      chip.innerHTML = `${escapeHtml(t)}<span class="mtag-x" title="移除该标签">✕</span>`;
      chip.addEventListener('click', (e) => {
        if (e.target.classList.contains('mtag-x')) {
          mailTags = mailTags.filter(x => x !== t);
          saveTags();
          renderMailTags();
          return;
        }
        const v = contentsInput.value.trim();
        contentsInput.value = v ? (v.includes(t) ? v : v + '、' + t) : t;
        contentsInput.focus();
      });
      tagsEl.appendChild(chip);
    }
  };
  renderMailTags();

  const learnTags = (contents) => {
    let changed = false;
    contents.split(/[、，,;；]/).map(s => s.trim()).forEach(part => {
      if (!part || part.length > 16 || mailTags.includes(part)) return;
      mailTags.unshift(part);
      changed = true;
    });
    if (mailTags.length > 24) mailTags = mailTags.slice(0, 24);
    if (changed) saveTags();
  };

  // 快递公司三选：顺丰 / EMS / 其他（输入）
  let courierSel = '顺丰';
  const otherInput = $('#ml-courier-other', form);
  form.querySelectorAll('.courier-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      form.querySelectorAll('.courier-chip').forEach(x => x.classList.toggle('active', x === chip));
      courierSel = chip.dataset.c;
      otherInput.classList.toggle('hidden', courierSel !== '');
      if (courierSel === '') otherInput.focus();
    });
  });

  const save = async () => {
    const recipient = $('#ml-recipient', form).value.trim();
    const contents = $('#ml-contents', form).value.trim();
    if (!recipient && !contents) return;
    await window.api.addMail(state.matter.id, {
      mail_date: $('#ml-date', form).value,
      recipient, contents,
      courier: courierSel !== '' ? courierSel : otherInput.value.trim(),
      tracking_no: $('#ml-tracking', form).value.trim()
    });
    learnTags(contents);
    renderRecBody();
    renderBoard();
  };
  $('#ml-add', form).addEventListener('click', save);
  form.querySelectorAll('input[type=text]').forEach(inp =>
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); }));

  const mails = await window.api.listMails(state.matter.id);
  if (!mails.length) {
    body.appendChild(Object.assign(document.createElement('div'), { className: 'rec-empty', textContent: '还没有邮寄记录。寄出文书后顺手记一笔，单号永不丢。' }));
    return;
  }
  for (const m of mails) {
    const item = document.createElement('div');
    item.className = 'rec-item';
    const meta = [m.courier, m.tracking_no].filter(Boolean).join(' · ');
    item.innerHTML = `
      <div class="r-date">${m.mail_date}</div>
      <div class="r-main"><b>${escapeHtml(m.recipient)}</b>　${escapeHtml(m.contents)}${meta ? `<div class="r-meta">${escapeHtml(meta)}　<a href="javascript:void(0)" class="r-copy-track">复制单号</a></div>` : ''}</div>
      <button class="r-del" title="删除">✕</button>`;
    const cp = item.querySelector('.r-copy-track');
    if (cp) cp.addEventListener('click', () => navigator.clipboard.writeText(m.tracking_no));
    item.querySelector('.r-del').addEventListener('click', async () => {
      if (!confirm('删除这条邮寄记录？')) return;
      await window.api.deleteMail(m.id);
      renderRecBody();
      renderBoard();
    });
    body.appendChild(item);
  }
}

async function copyRecords() {
  const btn = $('#rec-copy');
  let text = '';
  if (recTab === 'logs') {
    const logs = await window.api.listLogs(state.matter.id);
    text = `【${state.matter.name}】办案日志\n` + logs.map(l =>
      `${l.log_date}　${l.content}${l.hours ? `（${l.hours}h）` : ''}`).reverse().join('\n');
  } else {
    const mails = await window.api.listMails(state.matter.id);
    text = `【${state.matter.name}】邮寄记录\n` + mails.map(m =>
      `${m.mail_date}　寄往：${m.recipient}　材料：${m.contents}${m.tracking_no ? `　${m.courier || ''} ${m.tracking_no}` : ''}`).reverse().join('\n');
  }
  await navigator.clipboard.writeText(text);
  const old = btn.textContent;
  btn.textContent = '已复制 ✓';
  setTimeout(() => btn.textContent = old, 1200);
}

/* ============================================================
   七-3、期限提醒（顶栏铃铛 + 系统通知）
   ============================================================ */
const dayDiff = (dateStr) => {
  const t = new Date(todayISO() + 'T00:00:00');
  const d = new Date(dateStr + 'T00:00:00');
  return Math.round((d - t) / 86400000);
};

async function refreshBell() {
  const items = await window.api.listReminders();
  // 关注窗口：过期 30 天内 ~ 未来 30 天
  const focus = items.filter(it => { const d = dayDiff(it.date); return d >= -30 && d <= 30; });
  const urgent = focus.filter(it => { const d = dayDiff(it.date); return d >= 0 && d <= 7; });
  $('#bell-dot').classList.toggle('hidden', urgent.length === 0);
  return { focus, urgent };
}

async function renderBellPop() {
  const { focus } = await refreshBell();
  const pop = $('#bell-pop');
  pop.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'set-label';
  title.style.padding = '4px 8px 8px';
  title.textContent = "期限提醒（开启提醒的案件：封皮日期、任务截止日、日程事件都会提醒）";
  pop.appendChild(title);

  if (!focus.length) {
    pop.appendChild(Object.assign(document.createElement('div'), {
      className: 'bell-empty',
      textContent: '前后 30 天内没有临期事项。在案件信息条点提醒按钮可为案件开启提醒。'
    }));
    return;
  }
  for (const it of focus) {
    const d = dayDiff(it.date);
    const days = d > 0 ? `还有 ${d} 天` : (d === 0 ? '今天！' : `已过 ${-d} 天`);
    const cls = d < 0 ? 'over' : (d <= 7 ? 'urgent' : '');
    const item = document.createElement('div');
    item.className = 'bell-item';
    item.innerHTML = `
      <div class="b-top"><span class="b-label">${escapeHtml(it.label)}</span><span class="b-days ${cls}">${it.date} · ${days}</span></div>
      <div class="b-sub">${escapeHtml(it.matter_name)}</div>`;
    item.addEventListener('click', async () => {
      $('#bell-pop').classList.add('hidden');
      state.currentId = it.matter_id;
      await loadAll(it.matter_id);
    });
    pop.appendChild(item);
  }
  attachScrollHint(pop);
}

let notifiedKeys = new Set();
async function checkDeadlineNotifications() {
  try {
    const { urgent } = await refreshBell();
    for (const it of urgent) {
      const key = `${it.matter_id}|${it.label}|${it.date}`;
      if (notifiedKeys.has(key)) continue;
      notifiedKeys.add(key);
      const d = dayDiff(it.date);
      new Notification('MatterVibe 期限提醒', {
        body: `${it.matter_name}\n${it.label}：${it.date}（${d === 0 ? '就是今天！' : `还有 ${d} 天`}）`
      });
    }
  } catch (_) {}
}

/* ============================================================
   七-4、AI 接口设置
   ============================================================ */
async function openAiApi() {
  const st = await window.api.aiApiStatus();
  if (!st.token) await window.api.aiApiConfig({ regenToken: true });
  syncAiUi(await window.api.aiApiStatus());
  $('#ai-mask').classList.remove('hidden');
}

function syncAiUi(st) {
  $('#ai-enabled').checked = st.enabled;
  $('#ai-readonly').checked = st.readonly;
  $('#ai-port').value = st.port;
  $('#ai-token').value = st.token;
  const s = $('#ai-status');
  s.textContent = st.running ? `运行中 · http://127.0.0.1:${st.port}/api` : '已关闭';
  s.classList.toggle('on', st.running);
}

/* ============================================================
   七-5、升级欢迎页
   ============================================================ */
const UPGRADE_WHATS = [
  '软件更名为 MatterVibe，旧数据已自动迁移到新目录，零损失（旧目录保留未删）',
  '新增日历月视图：事件按日显示、点某天看当日全部日程；标注法定节假日与调休',
  '克隆案件移入「案件管理」每行的 ⎘ 按钮；修复程序坞图标'
];

function showUpgrade(info) {
  $('#up-ver').textContent = '版本 ' + (info.appVersion || '') + '\u3000数据结构 v' + info.from + ' → v' + info.to;
  const wrap = $('#up-whats');
  wrap.innerHTML = '';
  for (const t of UPGRADE_WHATS) {
    const d = document.createElement('div');
    d.className = 'uw';
    d.textContent = t;
    wrap.appendChild(d);
  }
  $('#up-mask').classList.remove('hidden');
}

/* ============================================================
   八-2、图标选择器（Lucide 开源图标，内嵌离线；案件与模板通用）
   ============================================================ */
function openIconPicker(current, onSelect) {
  const grid = $('#icon-grid');
  grid.innerHTML = '';

  for (const name of MF_ICON_NAMES) {
    const cell = document.createElement('button');
    cell.className = 'icon-cell' + (name === current ? ' active' : '');
    cell.title = name;
    cell.innerHTML = mfIconSvg(name, 19);
    cell.addEventListener('click', () => {
      $('#ip-mask').classList.add('hidden');
      onSelect(name);
    });
    grid.appendChild(cell);
  }
  attachScrollHint(grid);
  $('#ip-mask').classList.remove('hidden');
}

// 图标渲染兼容：Lucide 名称渲染为矢量图，老的 emoji 原样显示
function anyIconHtml(icon, size = 15) {
  if (icon && MF_ICONS[icon]) return mfIconSvg(icon, size);
  const span = document.createElement('span');
  span.textContent = icon || '📁';
  return span.outerHTML;
}

/* ============================================================
   九、字号设置（立即预览，5 秒未确认自动恢复）
   ============================================================ */
const FONT_SIZES = ['small', 'medium', 'large'];
let savedFontSize = 'medium';
let fontRevertTimer = null;
let fontCountdownTimer = null;

function applyFontSize(size) {
  if (!FONT_SIZES.includes(size)) size = 'medium';
  document.body.classList.remove('font-small', 'font-medium', 'font-large');
  document.body.classList.add('font-' + size);
  document.querySelectorAll('#font-cards .font-card').forEach(b => {
    b.classList.toggle('active', b.dataset.size === size);
  });
}

function clearFontTimers() {
  clearTimeout(fontRevertTimer);
  clearInterval(fontCountdownTimer);
  fontRevertTimer = null;
  fontCountdownTimer = null;
}

function hideFontConfirm() {
  clearFontTimers();
  $('#font-confirm').classList.add('hidden');
}

function previewFontSize(size) {
  applyFontSize(size);
  if (size === savedFontSize) { hideFontConfirm(); return; }

  clearFontTimers();
  const confirmRow = $('#font-confirm');
  const text = $('#font-confirm-text');
  confirmRow.classList.remove('hidden');

  let remain = 5;
  text.textContent = `保留此字号？${remain} 秒后恢复`;
  fontCountdownTimer = setInterval(() => {
    remain -= 1;
    if (remain > 0) text.textContent = `保留此字号？${remain} 秒后恢复`;
  }, 1000);
  fontRevertTimer = setTimeout(() => {
    applyFontSize(savedFontSize);
    hideFontConfirm();
  }, 5000);
}

async function keepFontSize() {
  const active = document.querySelector('#font-cards .font-card.active');
  if (!active) return;
  savedFontSize = active.dataset.size;
  await window.api.setSetting('font_size', savedFontSize);
  hideFontConfirm();
}

async function initFontSetting() {
  savedFontSize = (await window.api.getSetting('font_size')) || 'medium';
  applyFontSize(savedFontSize);
  document.querySelectorAll('#font-cards .font-card').forEach(b => {
    b.addEventListener('click', () => previewFontSize(b.dataset.size));
  });
  $('#btn-font-keep').addEventListener('click', keepFontSize);
}

function openPrefs() {
  applyFontSize(savedFontSize);
  hideFontConfirm();
  $('#prefs-mask').classList.remove('hidden');
}

function closePrefs() {
  // 关闭偏好设置时若有未确认的字号预览，立即恢复
  if (!$('#font-confirm').classList.contains('hidden')) {
    applyFontSize(savedFontSize);
  }
  hideFontConfirm();
  $('#prefs-mask').classList.add('hidden');
}

/* ============================================================
   十、设置面板
   ============================================================ */
function toggleSettings(force) {
  const pop = $('#settings-pop');
  const show = force !== undefined ? force : pop.classList.contains('hidden');
  pop.classList.toggle('hidden', !show);
}

/* ============================================================
   十一、启动
   ============================================================ */
async function bootstrap() {
  await reloadTemplates();
  await initFontSetting();
  initSearch();
  initBoardWheel();

  $('#btn-sidebar-toggle').addEventListener('click', toggleSidebar);

  // 设置面板
  $('#btn-settings').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSettings();
  });
  $('#settings-pop').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    if (!$('#settings-pop').classList.contains('hidden')) toggleSettings(false);
  });

  $('#set-manage').addEventListener('click', () => {
    toggleSettings(false);
    openMatterManager();
  });
  $('#set-template').addEventListener('click', () => {
    toggleSettings(false);
    openTemplateManager();
  });
  $('#set-prefs').addEventListener('click', () => {
    toggleSettings(false);
    openPrefs();
  });

  // 偏好设置
  $('#prefs-close').addEventListener('click', closePrefs);
  $('#prefs-mask').addEventListener('click', (e) => {
    if (e.target === $('#prefs-mask')) closePrefs();
  });

  // 图标选择器
  $('#ip-close').addEventListener('click', () => $('#ip-mask').classList.add('hidden'));
  $('#ip-mask').addEventListener('click', (e) => {
    if (e.target === $('#ip-mask')) $('#ip-mask').classList.add('hidden');
  });

  // 窗口控制（关闭在最右）
  $('#win-min').addEventListener('click', () => window.api.winMinimize());
  $('#win-max').addEventListener('click', () => window.api.winMaximize());
  $('#win-close').addEventListener('click', () => window.api.winClose());

  // 演示数据 / 彩蛋
  $('#demo-exit').addEventListener('click', exitDemoMode);
  initEgg();
  initPacmanFloat();

  // 首页 / 日历导航
  $('#nav-home').addEventListener('click', () => showView('home'));
  $('#nav-calendar').addEventListener('click', () => showView('calendar'));
  $('#cal-prev').addEventListener('click', () => calShift(-1));
  $('#cal-next').addEventListener('click', () => calShift(1));
  $('#cal-today').addEventListener('click', () => {
    const t = new Date(); calYear = t.getFullYear(); calMonth = t.getMonth(); renderCalendar();
  });
  $('#day-close').addEventListener('click', () => $('#day-mask').classList.add('hidden'));
  $('#day-mask').addEventListener('click', (e) => { if (e.target === $('#day-mask')) $('#day-mask').classList.add('hidden'); });
  document.querySelectorAll('#home-seg button').forEach(b =>
    b.addEventListener('click', () => {
      homeTab = b.dataset.tab;
      document.querySelectorAll('#home-seg button').forEach(x => x.classList.toggle('active', x === b));
      renderHome();
    }));

  // 律师工具箱（独立窗口，顶栏按钮）
  $('#btn-toolbox-top').addEventListener('click', () => openToolboxFloat());
  window.api.onToolboxShow(() => openToolboxFloat());
  window.api.onMaxState((v) => document.body.classList.toggle('win-maximized', !!v));

  // 期限铃铛
  $('#btn-bell').addEventListener('click', async (e) => {
    e.stopPropagation();
    const pop = $('#bell-pop');
    if (pop.classList.contains('hidden')) {
      await renderBellPop();
      pop.classList.remove('hidden');
      toggleSettings(false);
    } else {
      pop.classList.add('hidden');
    }
  });
  $('#bell-pop').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => $('#bell-pop').classList.add('hidden'));

  // 案件记录弹层
  document.querySelectorAll('#rec-tabs button').forEach(b => {
    b.addEventListener('click', () => {
      recTab = b.dataset.tab;
      document.querySelectorAll('#rec-tabs button').forEach(x => x.classList.toggle('active', x === b));
      renderRecBody();
    });
  });
  $('#rec-close').addEventListener('click', () => $('#rec-mask').classList.add('hidden'));
  $('#rec-copy').addEventListener('click', copyRecords);
  $('#rec-mask').addEventListener('click', (e) => {
    if (e.target === $('#rec-mask')) $('#rec-mask').classList.add('hidden');
  });

  // AI 接口设置
  $('#set-aiapi').addEventListener('click', () => { toggleSettings(false); openAiApi(); });
  $('#ai-close').addEventListener('click', () => $('#ai-mask').classList.add('hidden'));
  $('#ai-mask').addEventListener('click', (e) => {
    if (e.target === $('#ai-mask')) $('#ai-mask').classList.add('hidden');
  });
  const aiApply = async (cfg) => syncAiUi(await window.api.aiApiConfig(cfg));
  $('#ai-enabled').addEventListener('change', (e) => aiApply({ enabled: e.target.checked }));
  $('#ai-readonly').addEventListener('change', (e) => aiApply({ readonly: e.target.checked }));
  $('#ai-port').addEventListener('change', (e) => aiApply({ port: parseInt(e.target.value, 10) || 2046 }));
  $('#ai-regen').addEventListener('click', async () => {
    if (!confirm('重新生成令牌？旧令牌将立即失效。')) return;
    aiApply({ regenToken: true });
  });
  $('#ai-copy-token').addEventListener('click', async (e) => {
    await navigator.clipboard.writeText($('#ai-token').value);
    const b = e.currentTarget, old = b.textContent;
    b.textContent = '✓';
    setTimeout(() => b.textContent = old, 1000);
  });

  // AI 外部写入后实时刷新界面
  window.api.onChanged(async () => {
    await loadAll(state.currentId);
    refreshBell();
    if (currentView === 'home') renderHome();
    if (currentView === 'calendar') renderCalendar();
  });

  // 期限提醒：启动 5 秒后首查，此后每 30 分钟一查
  setTimeout(checkDeadlineNotifications, 5000);
  setInterval(checkDeadlineNotifications, 30 * 60 * 1000);
  refreshBell();

  $('#up-close').addEventListener('click', async () => {
    $('#up-mask').classList.add('hidden');
    await window.api.upgradeAck();
  });
  const up = await window.api.upgradeInfo();
  if (up) showUpgrade(up);

  // 自动迁移：若本次启动确实从旧版本平滑迁移了数据，仅做一次轻量告知（不主动追问）
  try {
    const mig = await window.api.migrateResult();
    if (mig && mig.migrated) {
      await loadAll();
      if (currentView === 'home') renderHome();
      notify(mig.recovered
        ? '已检测到旧版本数据并自动恢复。你的案件、日志、备份都已回来。'
        : '已从旧版本平滑迁移你的全部数据。', '数据迁移');
    }
    // 不再主动弹"是否恢复旧数据"——如需手动恢复/导入，可在 设置 → 从旧版本恢复数据… 中操作
  } catch (e) {}

  // 设置：设备同步（弹层）
  $('#set-sync').addEventListener('click', async () => {
    toggleSettings(false);
    const info = await window.api.syncInfo();
    $('#sync-info').innerHTML = '本机设备号：<b>' + info.device + '</b>　·　累计操作记录：<b>' + info.opCount + '</b> 条';
    await loadCloudStatus();
    $('#sync-mask').classList.remove('hidden');
  });
  $('#sync-close').addEventListener('click', () => $('#sync-mask').classList.add('hidden'));
  $('#sync-mask').addEventListener('click', (e) => { if (e.target === $('#sync-mask')) $('#sync-mask').classList.add('hidden'); });

  // 同步弹层 tab 切换
  document.querySelectorAll('#sync-tabs button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#sync-tabs button').forEach(x => x.classList.toggle('active', x === b));
      const tab = b.dataset.tab;
      $('#sync-pane-cloud').classList.toggle('hidden', tab !== 'cloud');
      $('#sync-pane-manual').classList.toggle('hidden', tab !== 'manual');
    });
  });

  async function loadCloudStatus() {
    const st = await window.api.cloudStatus();
    const modal = document.querySelector('.modal-sync');
    modal.classList.toggle('cloud-on', st.enabled);
    $('#cloud-url').value = st.url || 'https://dav.jianguoyun.com/dav/';
    $('#cloud-account').value = st.account || '';
    $('#cloud-interval').value = String(st.interval || 0);
    const line = $('#cloud-status-line');
    if (st.enabled) {
      const last = st.lastSync ? new Date(st.lastSync).toLocaleString('zh-CN') : '尚未同步';
      line.textContent = '✓ 已启用坚果云同步　·　上次同步：' + last;
    } else {
      line.textContent = '';
    }
  }

  $('#cloud-test').addEventListener('click', async () => {
    const cfg = { url: $('#cloud-url').value.trim(), account: $('#cloud-account').value.trim(), password: $('#cloud-password').value };
    if (!cfg.account || !cfg.password) { notify('请先填写坚果云账户与应用密码。'); return; }
    $('#cloud-test').textContent = '测试中…';
    const r = await window.api.cloudTest(cfg);
    $('#cloud-test').textContent = '测试连接';
    if (r.ok) notify('连接成功！坚果云配置正确。', '测试连接');
    else notify('连接失败：' + r.error, '测试连接');
  });

  $('#cloud-save').addEventListener('click', async () => {
    const url = $('#cloud-url').value.trim();
    const account = $('#cloud-account').value.trim();
    const password = $('#cloud-password').value;
    const p1 = $('#cloud-pass1').value, p2 = $('#cloud-pass2').value;
    const interval = parseInt($('#cloud-interval').value, 10) || 0;
    if (!account || !password) { notify('请填写坚果云账户与应用密码。'); return; }
    if (!p1) { notify('请设置加密口令。'); return; }
    if (p1 !== p2) { notify('两次输入的加密口令不一致，请重新输入。'); return; }
    if (p1.length < 6) { notify('加密口令太短，建议至少 6 位，并包含字母和数字。'); return; }
    $('#cloud-save').textContent = '连接中…';
    const r = await window.api.cloudSaveConfig({ url, account, password, passphrase: p1, interval });
    $('#cloud-save').textContent = '保存并启用';
    if (r.ok) {
      await loadCloudStatus();
      notify('坚果云同步已启用。建议现在点「导出口令备份」把加密口令保存到安全的地方。', '配置成功');
    } else {
      notify('配置失败：' + r.error, '配置失败');
    }
  });

  $('#cloud-sync-now').addEventListener('click', async () => {
    $('#cloud-sync-now').textContent = '同步中…';
    const r = await window.api.cloudSyncNow();
    $('#cloud-sync-now').textContent = '立即同步';
    if (r.ok) {
      await loadAll(); if (currentView === 'home') renderHome();
      await loadCloudStatus();
      notify('同步完成：从 ' + r.devices + ' 台其他设备合并了 ' + r.applied + ' 条改动。', '同步完成');
    } else {
      notify('同步失败：' + r.error, '同步失败');
    }
  });

  $('#cloud-export-pass').addEventListener('click', async () => {
    const r = await window.api.cloudExportPassphrase();
    if (r && !r.canceled) notify('加密口令备份已导出到：\n' + r.file + '\n\n请妥善保管，换设备时需要它。', '导出成功');
    else if (r && r.error) notify(r.error);
  });

  $('#cloud-disable').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: '停用坚果云同步', body: '停用后将不再自动上传/拉取。本地数据和云端已上传的数据都不受影响，可随时重新启用。', okText: '停用', danger: true });
    if (!ok) return;
    await window.api.cloudDisable();
    await loadCloudStatus();
  });

  $('#sync-do-export').addEventListener('click', async () => {
    const r = await window.api.syncExport();
    if (r && !r.canceled) notify('同步包已导出到：\n' + r.file + '\n\n把它拷到另一台设备，用「导入并合并」即可。', '导出成功');
  });
  $('#sync-do-import').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: '导入并合并', body: '将合并所选同步包中的数据到本机。\n当前数据会先自动备份留底。继续？', okText: '导入合并' });
    if (!ok) return;
    const r = await window.api.syncImport();
    if (r && !r.canceled) {
      await loadAll(); if (currentView === 'home') renderHome();
      $('#sync-mask').classList.add('hidden');
      notify('合并完成：新增 ' + r.result.applied + ' 条，跳过 ' + r.result.skipped + ' 条（已存在）。', '同步合并完成');
    }
  });

  // 设置：手动从旧版本恢复
  $('#set-recover').addEventListener('click', async () => {
    toggleSettings(false);
    const legacy = await window.api.migrateLegacyExists();
    if (!legacy) { notify('未找到可恢复的旧版本数据目录。'); return; }
    if (confirm('找到旧版本数据目录：\n' + legacy.dir + '\n\n恢复会用旧数据覆盖当前数据（当前数据会先自动备份留底），恢复后软件将自动重启一次。继续？')) {
      await window.api.migrateRecoverNow();
    }
  });

  // 关于
  $('#set-about').addEventListener('click', () => {
    toggleSettings(false);
    $('#about-mask').classList.remove('hidden');
    attachScrollHint(document.querySelector('.about-body'));
  });
  $('#about-close').addEventListener('click', () => $('#about-mask').classList.add('hidden'));
  $('#about-mask').addEventListener('click', (e) => {
    if (e.target === $('#about-mask')) $('#about-mask').classList.add('hidden');
  });

  // 使用帮助
  $('#set-help').addEventListener('click', () => {
    toggleSettings(false);
    $('#help-mask').classList.remove('hidden');
  });
  $('#help-close').addEventListener('click', () => $('#help-mask').classList.add('hidden'));
  $('#help-mask').addEventListener('click', (e) => {
    if (e.target === $('#help-mask')) $('#help-mask').classList.add('hidden');
  });

  // 首次引导页
  $('#onboard-start').addEventListener('click', () => {
    $('#onboard-mask').classList.add('hidden');
  });
  $('#onboard-demo').addEventListener('click', async () => {
    $('#onboard-mask').classList.add('hidden');
    try {
      await window.api.demoImport();
      await loadAll();
      showView('home');
    } catch (e) {}
  });

  // 新建案件
  $('#btn-new-matter').addEventListener('click', openNewMatterModal);
  $('#btn-modal-cancel').addEventListener('click', () => $('#modal-mask').classList.add('hidden'));
  $('#btn-modal-create').addEventListener('click', createFromModal);
  $('#modal-mask').addEventListener('click', (e) => {
    if (e.target === $('#modal-mask')) $('#modal-mask').classList.add('hidden');
  });
  $('#new-matter-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createFromModal();
  });
  $('#nm-choose').addEventListener('click', async () => {
    const p = await window.api.chooseFolder('选择案件文件夹的存放位置');
    if (!p) return;
    nmParent = p;
    await window.api.setSetting('folder_parent', p);
    $('#nm-parent').textContent = p;
    $('#nm-parent').title = p;
    $('#nm-mkdir').checked = true;
  });

  // 案件管理
  $('#mm-close').addEventListener('click', closeMatterManager);
  $('#mm-delete').addEventListener('click', mmDeleteSelected);
  document.querySelectorAll('#mm-mode-tabs button').forEach(b =>
    b.addEventListener('click', () => switchMmMode(b.dataset.mode)));
  $('#bk-now').addEventListener('click', backupNow);
  $('#bk-reveal').addEventListener('click', () => window.api.backupReveal());
  $('#bk-export').addEventListener('click', async () => {
    const r = await window.api.backupExport();
    if (r && !r.canceled) notify('已导出副本到：\n' + r.file, '导出成功');
  });
  $('#bk-import').addEventListener('click', async () => {
    if (!confirm('导入会用所选数据库替换当前全部数据。\n当前数据会先自动备份留底。继续？')) return;
    const r = await window.api.backupImport();
    if (r && !r.canceled) {
      await loadAll();
      if (mmMode === 'backup') renderBackupList();
      notify('导入完成。原数据已在导入前自动备份留底。', '导入完成');
    }
  });
  $('#mm-select-all').addEventListener('change', (e) => {
    state.mmSelected = e.target.checked ? new Set(state.matters.map(m => m.id)) : new Set();
    renderMmList();
  });
  $('#mm-mask').addEventListener('click', (e) => {
    if (e.target === $('#mm-mask')) closeMatterManager();
  });

  // 模板编辑器
  $('#btn-tpl-close').addEventListener('click', () => $('#tpl-mask').classList.add('hidden'));
  $('#btn-tpl-save').addEventListener('click', saveTemplateFromEditor);
  $('#btn-tpl-reset').addEventListener('click', resetTemplateFromEditor);
  $('#btn-tpl-new').addEventListener('click', createNewTemplate);
  $('#btn-tpl-export').addEventListener('click', async () => {
    if (!state.tplEditingKey) { notify('请先在左侧选择一套模板'); return; }
    const r = await window.api.exportTemplate(state.tplEditingKey);
    if (r && !r.canceled) notify('模板已导出到：\n' + r.file + '\n\n可以发给同事，或提交到模板库分享你的办案思路。', '导出成功');
  });
  $('#btn-tpl-import').addEventListener('click', async () => {
    const r = await window.api.importTemplate();
    if (r && !r.canceled) {
      state.templates = await window.api.listTemplates();
      state.tplEditingKey = state.templates[state.templates.length - 1].key;
      renderTplList();
      renderTplEditor();
      syncTplActions();
      notify('已导入模板「' + r.result.name + '」（' + r.result.stages + ' 个阶段）。它作为一套新模板加入，未覆盖你已有的模板。', '导入成功');
    }
  });
  $('#btn-tpl-backups').addEventListener('click', toggleBackupView);
  $('#tpl-mask').addEventListener('click', (e) => {
    if (e.target === $('#tpl-mask')) $('#tpl-mask').classList.add('hidden');
  });

  await loadAll();
  showView('home');
  await maybeOfferDemoData();
}

bootstrap();
