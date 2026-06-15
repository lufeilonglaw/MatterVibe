// db.js —— SQLite3 本地数据库逻辑（单文件 law_practice.db）
// 引擎说明：采用 sql.js（SQLite3 官方 C 源码编译的 WebAssembly 版本），
// 生成的 law_practice.db 是标准 SQLite3 格式单文件，可用任何 SQLite 工具直接打开；
// 同时彻底免去 node-gyp / Xcode 原生编译，保证「npm install 即可运行」。

'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { TEMPLATES } = require('./templates');

let db = null;
let dbPath = null;
let backupDir = null;

const SCHEMA_VERSION = 10;
const FULL_BACKUP_INTERVAL = 12 * 3600 * 1000;
const FULL_BACKUP_KEEP = 60;

// ---------- 持久化：每次写操作后将内存库落盘为标准 .db 文件 ----------
function persist() {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

// ---------- 小工具 ----------
function run(sql, params = []) {
  db.run(sql, params);
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function one(sql, params = []) {
  const rows = all(sql, params);
  return rows.length ? rows[0] : null;
}

function lastId() {
  return one('SELECT last_insert_rowid() AS id').id;
}

const now = () => new Date().toISOString();

// ---------- 初始化：建库建表 ----------
let SQL = null;
let upgradedFrom = 0;

async function init(userDataDir) {
  SQL = await initSqlJs({
    locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm')
  });

  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  dbPath = path.join(userDataDir, 'law_practice.db');
  backupDir = path.join(userDataDir, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }

  run(`CREATE TABLE IF NOT EXISTS matters (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL DEFAULT '民商事',
        icon        TEXT NOT NULL DEFAULT '',
        cover_info  TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL
      )`);

  run(`CREATE TABLE IF NOT EXISTS stages (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
        name      TEXT NOT NULL,
        position  INTEGER NOT NULL DEFAULT 0
      )`);

  run(`CREATE TABLE IF NOT EXISTS tasks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        stage_id     INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
        content      TEXT NOT NULL,
        is_completed INTEGER NOT NULL DEFAULT 0,
        position     INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT
      )`);

  // 模板表：可编辑的四套模板（首次启动用出厂模板植入）
  run(`CREATE TABLE IF NOT EXISTS templates (
        key         TEXT PRIMARY KEY,
        icon        TEXT NOT NULL,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        cover       TEXT NOT NULL,
        stages      TEXT NOT NULL,
        position    INTEGER NOT NULL DEFAULT 0
      )`);

  const tplCount = one('SELECT COUNT(*) AS c FROM templates').c;
  if (tplCount === 0) {
    Object.values(TEMPLATES).forEach((t, i) => {
      run('INSERT INTO templates (key, icon, name, type, description, cover, stages, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        t.key, t.icon, t.name, t.type, t.description || '', JSON.stringify(t.cover), JSON.stringify(t.stages), i
      ]);
    });
  }

  // 设置表（字号偏好等）
  run(`CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      )`);

  // 模板备份表：定期自动备份 + 每次改动前自动备份，保留最近 50 份
  run(`CREATE TABLE IF NOT EXISTS logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id  INTEGER NOT NULL,
        log_date   TEXT NOT NULL,
        content    TEXT NOT NULL,
        hours      REAL,
        created_at TEXT NOT NULL
      )`);

  run(`CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id   INTEGER,
        event_date  TEXT NOT NULL,
        event_time  TEXT,
        kind        TEXT NOT NULL DEFAULT 'custom',
        title       TEXT NOT NULL,
        note        TEXT,
        done        INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      )`);

  run(`CREATE TABLE IF NOT EXISTS oplog (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        op_id       TEXT NOT NULL UNIQUE,
        device      TEXT NOT NULL,
        actor       TEXT,
        entity      TEXT NOT NULL,
        entity_id   TEXT,
        action      TEXT NOT NULL,
        payload     TEXT,
        lamport     INTEGER NOT NULL DEFAULT 0,
        ts          TEXT NOT NULL
      )`);

  run(`CREATE TABLE IF NOT EXISTS mails (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id   INTEGER NOT NULL,
        mail_date   TEXT NOT NULL,
        recipient   TEXT NOT NULL,
        contents    TEXT NOT NULL,
        courier     TEXT,
        tracking_no TEXT,
        note        TEXT,
        created_at  TEXT NOT NULL
      )`);

  run(`CREATE TABLE IF NOT EXISTS template_backups (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        reason     TEXT NOT NULL DEFAULT 'auto',
        data       TEXT NOT NULL
      )`);

  // ---- 老库列迁移 ----
  const hasColumn = (table, col) =>
    all(`PRAGMA table_info(${table})`).some(r => r.name === col);
  if (!hasColumn('matters', 'icon')) {
    run("ALTER TABLE matters ADD COLUMN icon TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn('matters', 'remind')) {
    run("ALTER TABLE matters ADD COLUMN remind INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn('matters', 'folder')) {
    run("ALTER TABLE matters ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn('matters', 'archived')) {
    run("ALTER TABLE matters ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn('tasks', 'due_date')) {
    run("ALTER TABLE tasks ADD COLUMN due_date TEXT");
  }
  // 同步用全局唯一 ID（uid）：给六张实体表加 uid 列并为存量数据回填
  const UID_TABLES = ['matters', 'stages', 'tasks', 'logs', 'mails', 'events'];
  for (const tb of UID_TABLES) {
    if (!hasColumn(tb, 'uid')) {
      run(`ALTER TABLE ${tb} ADD COLUMN uid TEXT`);
      // 回填：用 设备号-表-自增id 生成稳定 uid
      const rows = all(`SELECT id FROM ${tb}`);
      for (const r of rows) {
        run(`UPDATE ${tb} SET uid = ? WHERE id = ?`, ['local-' + tb + '-' + r.id, r.id]);
      }
    }
  }
  if (!hasColumn('templates', 'description')) {
    run("ALTER TABLE templates ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }
  // 出厂模板描述回填（仅在为空时）
  Object.values(TEMPLATES).forEach(t => {
    run("UPDATE templates SET description = ? WHERE key = ? AND (description IS NULL OR description = '')",
      [t.description || '', t.key]);
  });

  // 老库缺失的出厂模板自动补插（如 2.6 新增的行政案件模板）
  Object.values(TEMPLATES).forEach(t => {
    const exist = one('SELECT key FROM templates WHERE key = ?', [t.key]);
    if (!exist) {
      const maxPos = one('SELECT COALESCE(MAX(position), -1) AS p FROM templates').p;
      run('INSERT INTO templates (key, icon, name, type, description, cover, stages, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        t.key, t.icon, t.name, t.type, t.description || '',
        JSON.stringify(t.cover), JSON.stringify(t.stages), maxPos + 1
      ]);
    }
  });

  const prevVer = parseInt(getSetting('schema_version') || '0', 10);
  setSetting('schema_version', String(SCHEMA_VERSION));

  // 同步基础：本机设备号（首次随机生成，长期固定）与 Lamport 逻辑时钟
  if (!getSetting('device_id')) {
    setSetting('device_id', 'dev-' + Math.random().toString(36).slice(2, 10));
  }
  if (!getSetting('lamport')) setSetting('lamport', '0');

  const lastBak = one('SELECT created_at FROM template_backups ORDER BY id DESC LIMIT 1');
  if (!lastBak || (Date.now() - Date.parse(lastBak.created_at)) > 24 * 3600 * 1000) {
    backupTemplates('auto');
  }

  persist();

  if (prevVer && prevVer < SCHEMA_VERSION) {
    fullBackup('upgrade-from-v' + prevVer);
    upgradedFrom = prevVer;
  }
  maybeAutoFullBackup();

  return dbPath;
}

/* ============================================================
   全量备份：整库快照
   ============================================================ */
function fullBackup(reason) {
  reason = reason || 'manual';
  if (!db || !backupDir) return null;
  persist();
  const p = n => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = d.getFullYear() + p(d.getMonth()+1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  const dest = path.join(backupDir, 'mattervibe-' + stamp + '-' + reason + '.db');
  fs.copyFileSync(dbPath, dest);
  setSetting('last_full_backup', new Date().toISOString());
  pruneFullBackups();
  return dest;
}

function maybeAutoFullBackup() {
  const last = getSetting('last_full_backup');
  if (!last || (Date.now() - Date.parse(last)) > FULL_BACKUP_INTERVAL) {
    fullBackup('auto');
  }
}

function pruneFullBackups() {
  const files = fs.readdirSync(backupDir)
    .filter(f => (f.indexOf('mattervibe-') === 0 || f.indexOf('matterflow-') === 0) && f.endsWith('.db'))
    .sort();
  while (files.length > FULL_BACKUP_KEEP) {
    const old = files.shift();
    try { fs.unlinkSync(path.join(backupDir, old)); } catch (e) {}
  }
}

function listFullBackups() {
  if (!backupDir || !fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter(f => (f.indexOf('mattervibe-') === 0 || f.indexOf('matterflow-') === 0) && f.endsWith('.db'))
    .map(function (f) {
      const st = fs.statSync(path.join(backupDir, f));
      const m = f.match(/matter(?:flow|vibe)-(\d{8})-(\d{6})-(.+)\.db/);
      let when = st.mtime.toISOString();
      let reason = 'manual';
      if (m) {
        when = m[1].slice(0,4) + '-' + m[1].slice(4,6) + '-' + m[1].slice(6,8) + 'T' + m[2].slice(0,2) + ':' + m[2].slice(2,4) + ':' + m[2].slice(4,6);
        reason = m[3];
      }
      return { file: f, path: path.join(backupDir, f), when: when, reason: reason, size: st.size };
    })
    .sort(function (a, b) { return b.file.localeCompare(a.file); });
}

async function restoreFullBackup(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('备份文件不存在');
  fullBackup('pre-restore');
  const buf = fs.readFileSync(filePath);
  const test = new SQL.Database(buf);
  test.close();
  db = new SQL.Database(buf);
  persist();
  return true;
}

async function importDb(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('文件不存在');
  const buf = fs.readFileSync(filePath);
  let test;
  try { test = new SQL.Database(buf); } catch (e) { throw new Error('不是有效的数据库文件'); }
  const hasMatters = test.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='matters'").length > 0;
  test.close();
  if (!hasMatters) throw new Error('该文件不是 MatterVibe 数据库（缺少 matters 表）');
  fullBackup('pre-import');
  db = new SQL.Database(buf);
  persist();
  return true;
}

function getUpgradedFrom() { return upgradedFrom; }

function getSchemaInfo() {
  return {
    version: SCHEMA_VERSION,
    stored: parseInt(getSetting('schema_version') || '0', 10),
    lastFullBackup: getSetting('last_full_backup') || null
  };
}

// ---------- 案件 ----------
function listMatters() {
  return all('SELECT id, name, type, icon, remind, folder, archived, created_at FROM matters WHERE archived = 0 ORDER BY created_at DESC, id DESC');
}

function listArchivedMatters() {
  return all('SELECT id, name, type, icon, remind, folder, archived, created_at FROM matters WHERE archived = 1 ORDER BY created_at DESC, id DESC');
}

function setMatterArchived(matterId, on) {
  run('UPDATE matters SET archived = ? WHERE id = ?', [on ? 1 : 0, matterId]);
  persist();
  const uid = uidById('matters', matterId);
  if (uid) logOp('matter', uid, 'archive', { archived: on ? 1 : 0 });
}

function getMatter(matterId) {
  const matter = one('SELECT * FROM matters WHERE id = ?', [matterId]);
  if (!matter) return null;
  matter.cover_info = JSON.parse(matter.cover_info || '[]');
  matter.stages = all(
    'SELECT * FROM stages WHERE matter_id = ? ORDER BY position ASC, id ASC',
    [matterId]
  );
  for (const s of matter.stages) {
    s.tasks = all(
      'SELECT * FROM tasks WHERE stage_id = ? ORDER BY is_completed ASC, position ASC, id ASC',
      [s.id]
    );
  }
  return matter;
}

function getTemplateRow(templateKey) {
  const row = one('SELECT * FROM templates WHERE key = ?', [templateKey]);
  if (!row) throw new Error('未知模板：' + templateKey);
  return {
    key: row.key, icon: row.icon, name: row.name, type: row.type,
    cover: JSON.parse(row.cover), stages: JSON.parse(row.stages)
  };
}

const TYPE_DEFAULT_ICON = { '执行': 'gavel', '刑事': 'shield-check', '民商事': 'scales', '非诉': 'file-text', '行政': 'bank' };

function createMatter(name, templateKey) {
  const tpl = getTemplateRow(templateKey);
  const finalName = (name && name.trim()) || '案件名称';
  const icon = TYPE_DEFAULT_ICON[tpl.type] || 'briefcase';
  const coverJson = JSON.stringify(tpl.cover);
  const createdAt = now();
  const matterUid = genUid();
  run('INSERT INTO matters (uid, name, type, icon, cover_info, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    matterUid, finalName, tpl.type, icon, coverJson, createdAt
  ]);
  const matterId = lastId();
  logOp('matter', matterUid, 'create', {
    name: finalName, type: tpl.type, icon, cover_info: coverJson, created_at: createdAt
  });
  tpl.stages.forEach((stage, si) => {
    const stageUid = genUid();
    run('INSERT INTO stages (uid, matter_id, name, position) VALUES (?, ?, ?, ?)', [stageUid, matterId, stage.name, si]);
    const stageId = lastId();
    logOp('stage', stageUid, 'create', { matter_uid: matterUid, name: stage.name });
    stage.tasks.forEach((content, ti) => {
      const taskUid = genUid();
      run('INSERT INTO tasks (uid, stage_id, content, is_completed, position) VALUES (?, ?, ?, 0, ?)', [
        taskUid, stageId, content, ti
      ]);
      logOp('task', taskUid, 'create', { stage_uid: stageUid, content, is_completed: 0 });
    });
  });
  persist();
  return matterId;
}

function cloneMatter(matterId) {
  const src = getMatter(matterId);
  if (!src) throw new Error('案件不存在');
  run('INSERT INTO matters (name, type, icon, cover_info, created_at) VALUES (?, ?, ?, ?, ?)', [
    src.name + '（副本）',
    src.type,
    src.icon || '',
    JSON.stringify(src.cover_info),
    now()
  ]);
  const newId = lastId();
  for (const s of src.stages) {
    run('INSERT INTO stages (matter_id, name, position) VALUES (?, ?, ?)', [newId, s.name, s.position]);
    const newStageId = lastId();
    for (const t of s.tasks) {
      run(
        'INSERT INTO tasks (stage_id, content, is_completed, position, completed_at) VALUES (?, ?, ?, ?, ?)',
        [newStageId, t.content, t.is_completed, t.position, t.completed_at]
      );
    }
  }
  persist();
  return newId;
}

function setMatterFolder(matterId, folder) {
  run('UPDATE matters SET folder = ? WHERE id = ?', [folder || '', matterId]);
  persist();
}

function setMatterRemind(matterId, on) {
  run('UPDATE matters SET remind = ? WHERE id = ?', [on ? 1 : 0, matterId]);
  persist();
  const uid = uidById('matters', matterId);
  if (uid) logOp('matter', uid, 'remind', { remind: on ? 1 : 0 });
}

/* ---------- 办案日志 ---------- */
function listLogs(matterId) {
  return all('SELECT * FROM logs WHERE matter_id = ? ORDER BY log_date DESC, id DESC', [matterId]);
}

function addLog(matterId, content, hours, logDate) {
  const uid = genUid();
  const ld = logDate || now().slice(0, 10);
  const c = String(content || '').trim();
  const h = (hours === undefined || hours === null || hours === '') ? null : Number(hours);
  const ca = now();
  run('INSERT INTO logs (uid, matter_id, log_date, content, hours, created_at) VALUES (?, ?, ?, ?, ?, ?)', [uid, matterId, ld, c, h, ca]);
  const id = one('SELECT last_insert_rowid() AS id').id;
  persist();
  logOp('log', uid, 'create', { matter_uid: uidById('matters', matterId), content: c, hours: h, log_date: ld, created_at: ca });
  return id;
}

function deleteLog(id) {
  const uid = uidById('logs', id);
  run('DELETE FROM logs WHERE id = ?', [id]);
  persist();
  if (uid) logOp('log', uid, 'delete', {});
}

/* ---------- 邮寄记录 ---------- */
function listMails(matterId) {
  return all('SELECT * FROM mails WHERE matter_id = ? ORDER BY mail_date DESC, id DESC', [matterId]);
}

function addMail(matterId, data) {
  const uid = genUid();
  const md = data.mail_date || now().slice(0, 10);
  const rc = String(data.recipient || '').trim();
  const ct = String(data.contents || '').trim();
  const cr = String(data.courier || '').trim();
  const tn = String(data.tracking_no || '').trim();
  const nt = String(data.note || '').trim();
  const ca = now();
  run('INSERT INTO mails (uid, matter_id, mail_date, recipient, contents, courier, tracking_no, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [uid, matterId, md, rc, ct, cr, tn, nt, ca]);
  const id = one('SELECT last_insert_rowid() AS id').id;
  persist();
  logOp('mail', uid, 'create', { matter_uid: uidById('matters', matterId), mail_date: md, recipient: rc, contents: ct, courier: cr, tracking_no: tn, created_at: ca });
  return id;
}

function deleteMail(id) {
  const uid = uidById('mails', id);
  run('DELETE FROM mails WHERE id = ?', [id]);
  persist();
  if (uid) logOp('mail', uid, 'delete', {});
}

function getRecordCounts(matterId) {
  return {
    logs: one('SELECT COUNT(*) AS c FROM logs WHERE matter_id = ?', [matterId]).c,
    mails: one('SELECT COUNT(*) AS c FROM mails WHERE matter_id = ?', [matterId]).c
  };
}

/* ---------- 期限扫描：从开启提醒的案件封皮中解析日期 ---------- */
const DATE_RE = /(\d{4})\s*[年./\-]\s*(\d{1,2})\s*[月./\-]\s*(\d{1,2})\s*日?/g;

function getDeadlines() {
  const rows = all('SELECT id, name, cover_info FROM matters WHERE remind = 1');
  const out = [];
  for (const m of rows) {
    let cover;
    try { cover = JSON.parse(m.cover_info); } catch (_) { continue; }
    for (const [label, value] of cover) {
      if (!value) continue;
      let match;
      DATE_RE.lastIndex = 0;
      while ((match = DATE_RE.exec(String(value))) !== null) {
        const y = +match[1], mo = +match[2], d = +match[3];
        if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
        const p = n => String(n).padStart(2, '0');
        out.push({
          matter_id: m.id,
          matter_name: m.name,
          label,
          value: String(value),
          date: `${y}-${p(mo)}-${p(d)}`
        });
      }
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// 统一提醒源：开启提醒（remind=1）的案件，其全部带日期的事项——
// 封皮日期 + 任务截止日 + 结构化事件，都纳入提醒。这样"日程"上属于已开提醒案件的事，都会被"催"。
function getReminders() {
  const out = [];
  // a) 封皮日期（沿用 getDeadlines，已只取 remind=1 的案件）
  for (const dl of getDeadlines()) {
    out.push({ matter_id: dl.matter_id, matter_name: dl.matter_name, label: dl.label, date: dl.date, source: 'cover' });
  }
  // b) 已开提醒案件的任务截止日
  const dueTasks = all(`
    SELECT t.content, t.due_date, m.id AS matter_id, m.name AS matter_name
    FROM tasks t JOIN stages s ON t.stage_id = s.id JOIN matters m ON s.matter_id = m.id
    WHERE m.remind = 1 AND m.archived = 0 AND t.is_completed = 0
      AND t.due_date IS NOT NULL AND t.due_date != ''
  `);
  for (const t of dueTasks) {
    out.push({ matter_id: t.matter_id, matter_name: t.matter_name, label: '任务：' + t.content, date: t.due_date, source: 'task' });
  }
  // c) 已开提醒案件的结构化事件（未完成）
  const evs = all(`
    SELECT e.title, e.event_date, e.kind, m.id AS matter_id, m.name AS matter_name
    FROM events e JOIN matters m ON e.matter_id = m.id
    WHERE m.remind = 1 AND m.archived = 0 AND e.done = 0
      AND e.event_date IS NOT NULL AND e.event_date != ''
  `);
  const kindLabel = { hearing: '开庭', evidence: '举证', mediation: '调解', deadline: '期限', custom: '' };
  for (const e of evs) {
    const pre = kindLabel[e.kind] ? (kindLabel[e.kind] + '：') : '';
    out.push({ matter_id: e.matter_id, matter_name: e.matter_name, label: pre + e.title, date: e.event_date, source: 'event' });
  }
  // 去重（同案同日同标题）
  const seen = new Set();
  const dedup = [];
  for (const it of out) {
    const k = it.matter_id + '|' + it.date + '|' + it.label;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(it);
  }
  dedup.sort((a, b) => a.date.localeCompare(b.date));
  return dedup;
}

/* ============================================================
   结构化事件（events）：开庭/举证/调解续封/自定义，支撑首页与日历
   ============================================================ */
const EVENT_KINDS = ['hearing', 'evidence', 'mediation', 'custom'];

function listEvents(opts) {
  opts = opts || {};
  let sql = 'SELECT e.*, m.name AS matter_name FROM events e LEFT JOIN matters m ON e.matter_id = m.id';
  const cond = [], args = [];
  if (opts.from) { cond.push('e.event_date >= ?'); args.push(opts.from); }
  if (opts.to)   { cond.push('e.event_date <= ?'); args.push(opts.to); }
  if (opts.matterId) { cond.push('e.matter_id = ?'); args.push(opts.matterId); }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ' ORDER BY e.event_date ASC, e.event_time ASC, e.id ASC';
  return all(sql, args);
}

function addEvent(data) {
  const uid = genUid();
  const kind = EVENT_KINDS.indexOf(data.kind) >= 0 ? data.kind : 'custom';
  const title = String(data.title || '').trim() || '未命名事项';
  const note = String(data.note || '').trim() || null;
  const etime = data.event_time || null;
  const ca = now();
  run('INSERT INTO events (uid, matter_id, event_date, event_time, kind, title, note, done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)', [
    uid, data.matter_id || null, data.event_date, etime, kind, title, note, ca
  ]);
  const id = one('SELECT last_insert_rowid() AS id').id;
  persist();
  logOp('event', uid, 'create', { matter_uid: data.matter_id ? uidById('matters', data.matter_id) : null, event_date: data.event_date, event_time: etime, kind, title, note, done: 0, created_at: ca });
  return id;
}

function updateEvent(id, data) {
  const e = one('SELECT * FROM events WHERE id = ?', [id]);
  if (!e) throw new Error('事件不存在');
  const ed = data.event_date || e.event_date;
  const et = data.event_time !== undefined ? data.event_time : e.event_time;
  const kd = data.kind || e.kind;
  const ti = data.title !== undefined ? String(data.title).trim() : e.title;
  const nt = data.note !== undefined ? String(data.note).trim() : e.note;
  run('UPDATE events SET matter_id = ?, event_date = ?, event_time = ?, kind = ?, title = ?, note = ? WHERE id = ?', [
    data.matter_id !== undefined ? data.matter_id : e.matter_id, ed, et, kd, ti, nt, id
  ]);
  persist();
  logOp('event', e.uid, 'update', { event_date: ed, event_time: et, kind: kd, title: ti, note: nt });
}

function setEventDone(id, done) {
  run('UPDATE events SET done = ? WHERE id = ?', [done ? 1 : 0, id]);
  persist();
  const uid = uidById('events', id);
  if (uid) logOp('event', uid, 'done', { done: done ? 1 : 0 });
}

function deleteEvent(id) {
  const uid = uidById('events', id);
  run('DELETE FROM events WHERE id = ?', [id]);
  persist();
  if (uid) logOp('event', uid, 'delete', {});
}

// 删案连带清理事件
function deleteMatterEvents(matterId) {
  run('DELETE FROM events WHERE matter_id = ?', [matterId]);
}

/* 首页/日历统一数据流：合并 events + 封皮日期(只读虚拟事件) + 未完成任务(无日期不入历) */
function getAgenda(opts) {
  opts = opts || {};
  const from = opts.from, to = opts.to;
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);

  const items = [];

  // a) 结构化事件
  for (const e of listEvents({ from, to })) {
    items.push({
      source: 'event', id: e.id, date: e.event_date, time: e.event_time || '',
      kind: e.kind, title: e.title, note: e.note || '',
      matter_id: e.matter_id, matter_name: e.matter_name || '', done: !!e.done
    });
  }

  // b) 封皮日期（来自开启提醒的案件），作为只读虚拟事件并入；与已存在的同案同日同标题事件去重
  const seen = new Set(items.map(i => `${i.matter_id}|${i.date}|${i.title}`));
  for (const dl of getDeadlines()) {
    const key = `${dl.matter_id}|${dl.date}|${dl.label}`;
    if (seen.has(key)) continue;
    if (!inRange(dl.date)) continue;
    items.push({
      source: 'cover', id: 'cover-' + dl.matter_id + '-' + dl.label, date: dl.date, time: '',
      kind: 'deadline', title: dl.label, note: dl.value,
      matter_id: dl.matter_id, matter_name: dl.matter_name, done: false
    });
  }

  // c) 带截止日期的未完成任务，作为待办事件并入日程
  const dueTasks = all(`
    SELECT t.id, t.uid, t.content, t.due_date, t.is_completed,
           m.id AS matter_id, m.name AS matter_name
    FROM tasks t
    JOIN stages s ON t.stage_id = s.id
    JOIN matters m ON s.matter_id = m.id
    WHERE t.due_date IS NOT NULL AND t.due_date != '' AND m.archived = 0
  `);
  for (const t of dueTasks) {
    if (!inRange(t.due_date)) continue;
    items.push({
      source: 'task', id: 'task-' + t.id, task_id: t.id, date: t.due_date, time: '',
      kind: 'task', title: t.content, note: '',
      matter_id: t.matter_id, matter_name: t.matter_name, done: !!t.is_completed
    });
  }

  items.sort((a, b) => (a.date + (a.time || '99:99')).localeCompare(b.date + (b.time || '99:99')));
  return items;
}

// 设置/清除任务截止日期（设了就会进日程）
function setTaskDue(taskId, due) {
  const d = due ? String(due) : null;
  run('UPDATE tasks SET due_date = ? WHERE id = ?', [d, taskId]);
  persist();
  const uid = uidById('tasks', taskId);
  if (uid) logOp('task', uid, 'due', { due_date: d });
}

// 首页统计卡 + 待办清单
function getDashboard() {
  const p = n => String(n).padStart(2, '0');
  const today = new Date();
  const tIso = today.getFullYear() + '-' + p(today.getMonth()+1) + '-' + p(today.getDate());
  const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate() + (7 - (today.getDay() || 7)));
  const wIso = weekEnd.getFullYear() + '-' + p(weekEnd.getMonth()+1) + '-' + p(weekEnd.getDate());
  const in7 = new Date(today); in7.setDate(in7.getDate() + 7);
  const s7 = in7.getFullYear() + '-' + p(in7.getMonth()+1) + '-' + p(in7.getDate());

  const agenda = getAgenda({});
  const active = agenda.filter(a => !a.done);

  const todayItems = active.filter(a => a.date === tIso);
  const weekHearings = active.filter(a => a.kind === 'hearing' && a.date >= tIso && a.date <= wIso);
  const next7 = active.filter(a => a.date >= tIso && a.date <= s7);
  const overdue = active.filter(a => a.date < tIso);

  return {
    today: tIso,
    counts: {
      today: todayItems.length,
      weekHearings: weekHearings.length,
      next7: next7.length,
      overdue: overdue.length
    },
    todayItems,
    upcoming: active.filter(a => a.date >= tIso).slice(0, 40),
    overdue: overdue.slice(0, 40)
  };
}

/* ============================================================
   演示数据：首次使用可一键导入，便于体验；可一次性清除进入正式使用
   ============================================================ */
function isDemoMode() { return getSetting('demo_mode') === '1'; }
function isDemoDismissed() { return getSetting('demo_dismissed') === '1'; }

// 相对今天偏移 n 天的 ISO 日期
function dayOffset(n) {
  const d = new Date(); d.setDate(d.getDate() + n);
  const p = x => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
}

function importDemoData() {
  if (isDemoDismissed()) return { ok: false, reason: 'dismissed' };

  // 每类模板各建一个演示案件，填充封皮、划销部分任务、加日志/邮寄/事件
  const demos = [
    { tpl: 'minshangshi', name: '【演示】某买卖合同货款纠纷', cover: [['案号','（2026）演0101民初001号'],['原告','示范甲贸易有限公司'],['被告','示范乙制造有限公司'],['标的额','128.6万元'],['承办法官','示范法官（示范区法院）'],['开庭日期', dayOffset(5) + ' 上午9:30'],['举证期限', dayOffset(2)]],
      events: [['hearing', dayOffset(5), '09:30', '第一次开庭'], ['evidence', dayOffset(2), '', '举证期限届满'], ['custom', dayOffset(8), '14:00', '与对方代理人庭外沟通调解']],
      logs: [['接受委托，与当事人沟通案情、梳理交易往来', 2, dayOffset(-8)], ['整理购销合同、送货单、对账单，制作证据目录', 3, dayOffset(-5)], ['起草民事起诉状并网上提交立案', 1.5, dayOffset(-3)], ['立案成功，缴纳诉讼费，准备开庭材料', 1, dayOffset(-1)]],
      mails: [[dayOffset(-3), '示范区人民法院立案庭', '民事起诉状、证据材料一式三份、授权委托书、律师事务所函', '顺丰', 'SF1234567890'], [dayOffset(-1), '示范乙制造有限公司', '催款律师函', 'EMS', 'EA12345678CN']],
      doneTasks: 4 },
    { tpl: 'minshangshi', name: '【演示】某股权转让纠纷', cover: [['案号','（2026）演0105民初018号'],['原告','示范丙'],['被告','示范丁、示范戊'],['标的额','450万元'],['争议焦点','股权转让款支付与工商变更']],
      events: [['hearing', dayOffset(14), '10:00', '开庭审理'], ['evidence', dayOffset(9), '', '举证期限届满']],
      logs: [['研究股权转让协议及补充协议，分析付款条件', 2.5, dayOffset(-6)], ['与当事人确认诉讼请求与计算依据', 1.5, dayOffset(-4)]],
      mails: [[dayOffset(-2), '示范市中级人民法院', '民事起诉状及证据材料', '顺丰', 'SF2345678901']],
      doneTasks: 3 },
    { tpl: 'zhixing', name: '【演示】某借款合同执行案', cover: [['执行案号','（2026）演0102执001号'],['申请执行人','示范己'],['被执行人','示范庚科技有限公司'],['执行标的','85万元及利息'],['执行依据','（2025）演0101民初888号判决']],
      events: [['custom', dayOffset(7), '', '向法院申请查询被执行人银行账户'], ['custom', dayOffset(20), '', '财产线索补充提交'], ['custom', dayOffset(-3), '', '申请纳入失信被执行人名单（已逾期提醒示例）']],
      logs: [['立案后提交财产调查申请', 1, dayOffset(-10)], ['查得被执行人名下两个银行账户，申请冻结', 1.5, dayOffset(-6)], ['申请对被执行人法定代表人限制高消费', 1, dayOffset(-2)]],
      mails: [[dayOffset(-6), '示范区人民法院执行局', '财产保全申请书、调查令申请', '顺丰', 'SF3456789012'], [dayOffset(-2), '示范区人民法院执行局', '限制高消费申请书', 'EMS', 'EA23456789CN']],
      doneTasks: 5 },
    { tpl: 'xingshi', name: '【演示】某涉嫌职务侵占辩护案', cover: [['案号','（2026）演0103刑初001号'],['被告人','示范辛'],['涉嫌罪名','职务侵占罪'],['办案阶段','审查起诉'],['羁押情况','取保候审'],['承办检察官','示范检察官']],
      events: [['custom', dayOffset(1), '10:00', '会见当事人'], ['custom', dayOffset(4), '', '向检察院提交不起诉法律意见'], ['custom', dayOffset(-2), '', '阅卷（已逾期提醒示例）']],
      logs: [['首次会见，了解基本案情与工作经历', 1.5, dayOffset(-9)], ['到检察院阅卷，复制电子卷宗', 3, dayOffset(-7)], ['研究在案证据，撰写出罪辩护思路', 4, dayOffset(-4)], ['会见核实关键事实，固定辩护方案', 1.5, dayOffset(-1)]],
      mails: [[dayOffset(-6), '示范市人民检察院', '委托手续、辩护人意见书', 'EMS', 'EA34567890CN'], [dayOffset(-3), '示范市人民检察院', '取保候审申请书、羁押必要性审查申请', '顺丰', 'SF4567890123']],
      doneTasks: 3 },
    { tpl: 'xingshi', name: '【演示】某涉嫌合同诈骗会见案', cover: [['案号','（侦）演公刑侦001号'],['犯罪嫌疑人','示范壬'],['涉嫌罪名','合同诈骗罪'],['办案阶段','侦查阶段'],['羁押情况','刑事拘留→逮捕']],
      events: [['custom', dayOffset(2), '', '看守所会见'], ['deadline', dayOffset(6), '', '侦查羁押期限关注节点']],
      logs: [['家属委托，办理委托手续', 1, dayOffset(-5)], ['首次看守所会见，告知诉讼权利', 2, dayOffset(-3)]],
      mails: [[dayOffset(-4), '示范县公安局', '律师会见手续、委托书', 'EMS', 'EA45678901CN']],
      doneTasks: 2 },
    { tpl: 'feisu', name: '【演示】某科技公司常年法律顾问', cover: [['客户','示范科技有限公司'],['服务内容','合同审查、合规咨询、用工管理'],['服务期限','2026.01–2026.12'],['对接人','示范法务总监'],['年度顾问费','15万元']],
      events: [['custom', dayOffset(10), '14:00', '季度合规专题会议'], ['custom', dayOffset(25), '', '员工手册修订评审']],
      logs: [['审查供应商框架采购协议，出具修改意见', 3, dayOffset(-12)], ['就数据合规问题提供书面咨询意见', 2, dayOffset(-7)], ['参加管理层会议，解答用工与股权激励问题', 2, dayOffset(-3)]],
      mails: [[dayOffset(-7), '示范科技有限公司', '法律咨询意见书（数据合规）', '顺丰', 'SF5678901234']],
      doneTasks: 6 },
    { tpl: 'feisu', name: '【演示】某并购项目尽职调查', cover: [['项目','示范集团收购示范标的公司60%股权'],['客户','示范集团有限公司'],['交易金额','约8000万元'],['工作阶段','法律尽职调查']],
      events: [['custom', dayOffset(15), '', '尽调报告初稿交付'], ['custom', dayOffset(30), '10:00', '交易文件谈判']],
      logs: [['制定尽调清单，发送资料需求', 2, dayOffset(-9)], ['审查标的公司工商、合同、诉讼、知识产权资料', 5, dayOffset(-5)], ['梳理重大风险点，撰写尽调报告框架', 3, dayOffset(-2)]],
      mails: [],
      doneTasks: 4 },
    { tpl: 'xingzheng', name: '【演示】某行政处罚诉讼案', cover: [['案号','（2026）演0104行初001号'],['原告','示范癸'],['被告','示范市场监督管理局'],['被诉行为','行政处罚决定（罚款20万元）'],['起诉期限', dayOffset(3)]],
      events: [['deadline', dayOffset(3), '', '起诉期限届满'], ['hearing', dayOffset(18), '14:00', '开庭审理'], ['evidence', dayOffset(12), '', '举证期限届满']],
      logs: [['研究被诉处罚决定及证据材料，分析合法性', 3, dayOffset(-5)], ['撰写行政起诉状，论证处罚程序违法', 2.5, dayOffset(-2)]],
      mails: [[dayOffset(-1), '示范区人民法院', '行政起诉状、证据材料、政府信息公开答复', '顺丰', 'SF6789012345']],
      doneTasks: 2 },
    { tpl: 'xingzheng', name: '【演示】某行政复议案', cover: [['复议机关','示范市人民政府'],['申请人','示范子'],['被申请人','示范区城市管理局'],['复议事项','撤销限期拆除决定'],['申请期限', dayOffset(6)]],
      events: [['deadline', dayOffset(6), '', '复议申请期限'], ['custom', dayOffset(1), '', '准备复议申请材料']],
      logs: [['接受委托，研究行政行为与证据', 2, dayOffset(-3)]],
      mails: [],
      doneTasks: 1 }
  ];

  for (const d of demos) {
    const mid = createMatter(d.name, d.tpl);
    const m = getMatter(mid);
    // 封皮：按要素名更新，多余的追加
    const cover = m.cover_info.slice();
    for (const [k, v] of d.cover) {
      const idx = cover.findIndex(p => p[0] === k);
      if (idx >= 0) cover[idx] = [k, v]; else cover.push([k, v]);
    }
    updateCoverInfo(mid, cover);
    setMatterRemind(mid, true); // 开启提醒，让封皮日期进入首页与日历
    // 划销前 N 个任务，体现"进行中"
    let toComplete = d.doneTasks;
    for (const st of m.stages) {
      for (const t of st.tasks) {
        if (toComplete <= 0) break;
        setTaskCompleted(t.id, true);
        toComplete--;
      }
      if (toComplete <= 0) break;
    }
    for (const [kind, date, time, title] of d.events) addEvent({ matter_id: mid, event_date: date, event_time: time || null, kind, title });
    for (const [c, h, dt] of d.logs) addLog(mid, c, h, dt);
    for (const [dt, r, c, courier, tno] of d.mails) addMail(mid, { mail_date: dt, recipient: r, contents: c, courier, tracking_no: tno });
  }

  setSetting('demo_mode', '1');
  persist();
  return { ok: true, count: demos.length };
}

// 清除全部数据，进入正式使用（不可逆：标记 demo_dismissed，今后不再提示导入）
function clearDemoAndStart() {
  // 删除所有案件及其级联数据
  const ids = all('SELECT id FROM matters').map(r => r.id);
  for (const id of ids) deleteMatter(id);
  // 清空独立事件（无案件关联的）
  run('DELETE FROM events');
  run('DELETE FROM logs');
  run('DELETE FROM mails');
  setSetting('demo_mode', '0');
  setSetting('demo_dismissed', '1');
  persist();
  return { ok: true };
}

/* ============================================================
   同步地基：操作日志（oplog）+ 同步包导出/导入合并
   设计为带 device/actor 维度，未来团队多用户可直接复用
   ============================================================ */
function getDeviceId() { return getSetting('device_id') || 'dev-unknown'; }

function nextLamport(remote) {
  const cur = parseInt(getSetting('lamport') || '0', 10);
  const next = Math.max(cur, remote || 0) + 1;
  setSetting('lamport', String(next));
  return next;
}

// 生成全局唯一 ID（设备号 + 时间 + 随机），用于跨设备标识实体
function genUid() {
  return getDeviceId() + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 按 uid 查本地自增 id
function idByUid(table, uid) {
  if (!uid) return null;
  const r = one(`SELECT id FROM ${table} WHERE uid = ?`, [uid]);
  return r ? r.id : null;
}

// 按本地自增 id 反查 uid（写操作记 oplog 时用）
function uidById(table, id) {
  if (id == null) return null;
  const r = one(`SELECT uid FROM ${table} WHERE id = ?`, [id]);
  return r ? r.uid : null;
}

// 记录一条操作。entityUid 用全局 uid 标识实体（而非本地自增 id）
function logOp(entity, entityUid, action, payload) {
  try {
    const opId = getDeviceId() + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    run('INSERT INTO oplog (op_id, device, actor, entity, entity_id, action, payload, lamport, ts) VALUES (?,?,?,?,?,?,?,?,?)', [
      opId, getDeviceId(), getSetting('actor') || null,
      entity, entityUid != null ? String(entityUid) : null, action,
      payload != null ? JSON.stringify(payload) : null,
      nextLamport(0), now()
    ]);
  } catch (e) { /* 记录失败不影响主流程 */ }
}

// 导出同步包：本机全部 oplog（供另一台设备合并）。后续可改为只导出"对方未有的增量"
function exportSyncPackage() {
  const ops = all('SELECT * FROM oplog ORDER BY lamport ASC, id ASC');
  return {
    format: 'mattervibe-sync',
    version: 1,
    device: getDeviceId(),
    exported_at: now(),
    schema: SCHEMA_VERSION,
    ops: ops
  };
}

// 导入并合并对方同步包：按 op_id 去重，回放本机没有的操作
function importSyncPackage(pkg) {
  if (!pkg || pkg.format !== 'mattervibe-sync' || !Array.isArray(pkg.ops)) {
    throw new Error('不是有效的 MatterVibe 同步包');
  }
  let applied = 0, skipped = 0;
  for (const op of pkg.ops) {
    const exists = one('SELECT 1 AS x FROM oplog WHERE op_id = ?', [op.op_id]);
    if (exists) { skipped++; continue; }
    // 记录这条 oplog（保留来源 device/lamport）
    run('INSERT INTO oplog (op_id, device, actor, entity, entity_id, action, payload, lamport, ts) VALUES (?,?,?,?,?,?,?,?,?)', [
      op.op_id, op.device, op.actor || null, op.entity, op.entity_id, op.action, op.payload, op.lamport || 0, op.ts
    ]);
    nextLamport(op.lamport || 0); // 推进本机逻辑时钟
    try { applyOp(op); applied++; } catch (e) { /* 单条失败跳过，不阻断整体 */ }
  }
  persist();
  return { applied, skipped, total: pkg.ops.length };
}

// 回放一条来自其他设备的操作到当前数据库。
// 一切按全局 uid 定位；实体不存在则按需创建。冲突在第二步（冲突处理）再细化，
// 当前阶段：字段更新采用"后写覆盖"，删除采用直接删除。
function applyOp(op) {
  const p = op.payload ? JSON.parse(op.payload) : {};
  const uid = op.entity_id; // 这里存的是实体的全局 uid
  const key = op.entity + ':' + op.action;

  switch (key) {
    /* ---------- 案件 ---------- */
    case 'matter:create': {
      if (idByUid('matters', uid)) break; // 已存在则跳过，避免重复建
      run('INSERT INTO matters (uid, name, type, icon, cover_info, remind, folder, archived, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [uid, p.name, p.type || '民商事', p.icon || '', p.cover_info || '[]', p.remind || 0, p.folder || '', p.archived || 0, p.created_at || now()]);
      break;
    }
    case 'matter:cover': {
      const id = idByUid('matters', uid);
      if (id) run('UPDATE matters SET cover_info = ? WHERE id = ?', [p.cover_info, id]);
      break;
    }
    case 'matter:remind': {
      const id = idByUid('matters', uid);
      if (id) run('UPDATE matters SET remind = ? WHERE id = ?', [p.remind ? 1 : 0, id]);
      break;
    }
    case 'matter:archive': {
      const id = idByUid('matters', uid);
      if (id) run('UPDATE matters SET archived = ? WHERE id = ?', [p.archived ? 1 : 0, id]);
      break;
    }
    case 'matter:rename': {
      const id = idByUid('matters', uid);
      if (id) run('UPDATE matters SET name = ? WHERE id = ?', [p.name, id]);
      break;
    }
    case 'matter:icon': {
      const id = idByUid('matters', uid);
      if (id) run('UPDATE matters SET icon = ? WHERE id = ?', [p.icon, id]);
      break;
    }
    case 'matter:delete': {
      const id = idByUid('matters', uid);
      if (id) { run('DELETE FROM matters WHERE id = ?', [id]); cascadeDeleteMatter(id); }
      break;
    }

    /* ---------- 阶段 ---------- */
    case 'stage:create': {
      if (idByUid('stages', uid)) break;
      const mid = idByUid('matters', p.matter_uid);
      if (mid) {
        const maxPos = one('SELECT COALESCE(MAX(position),-1) AS p FROM stages WHERE matter_id = ?', [mid]).p;
        run('INSERT INTO stages (uid, matter_id, name, position) VALUES (?,?,?,?)', [uid, mid, p.name, maxPos + 1]);
      }
      break;
    }
    case 'stage:rename': {
      const id = idByUid('stages', uid);
      if (id) run('UPDATE stages SET name = ? WHERE id = ?', [p.name, id]);
      break;
    }
    case 'stage:move': {
      const id = idByUid('stages', uid);
      if (id) moveStage(id, p.to_index || 0);
      break;
    }
    case 'stage:delete': {
      const id = idByUid('stages', uid);
      if (id) { run('DELETE FROM stages WHERE id = ?', [id]); run('DELETE FROM tasks WHERE stage_id = ?', [id]); }
      break;
    }

    /* ---------- 任务 ---------- */
    case 'task:create': {
      if (idByUid('tasks', uid)) break;
      const sid = idByUid('stages', p.stage_uid);
      if (sid) {
        const maxPos = one('SELECT COALESCE(MAX(position),-1) AS p FROM tasks WHERE stage_id = ?', [sid]).p;
        run('INSERT INTO tasks (uid, stage_id, content, is_completed, position) VALUES (?,?,?,?,?)', [uid, sid, p.content, p.is_completed || 0, maxPos + 1]);
      }
      break;
    }
    case 'task:content': {
      const id = idByUid('tasks', uid);
      if (id) run('UPDATE tasks SET content = ? WHERE id = ?', [p.content, id]);
      break;
    }
    case 'task:complete': {
      const id = idByUid('tasks', uid);
      if (id) run('UPDATE tasks SET is_completed = ? WHERE id = ?', [p.completed ? 1 : 0, id]);
      break;
    }
    case 'task:delete': {
      const id = idByUid('tasks', uid);
      if (id) run('DELETE FROM tasks WHERE id = ?', [id]);
      break;
    }
    case 'task:due': {
      const id = idByUid('tasks', uid);
      if (id) run('UPDATE tasks SET due_date = ? WHERE id = ?', [p.due_date || null, id]);
      break;
    }

    /* ---------- 办案日志 ---------- */
    case 'log:create': {
      if (idByUid('logs', uid)) break;
      const mid = idByUid('matters', p.matter_uid);
      if (mid) run('INSERT INTO logs (uid, matter_id, content, hours, log_date, created_at) VALUES (?,?,?,?,?,?)',
        [uid, mid, p.content, p.hours || 0, p.log_date, p.created_at || now()]);
      break;
    }
    case 'log:delete': {
      const id = idByUid('logs', uid);
      if (id) run('DELETE FROM logs WHERE id = ?', [id]);
      break;
    }

    /* ---------- 邮寄 ---------- */
    case 'mail:create': {
      if (idByUid('mails', uid)) break;
      const mid = idByUid('matters', p.matter_uid);
      if (mid) run('INSERT INTO mails (uid, matter_id, mail_date, recipient, contents, courier, tracking_no, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [uid, mid, p.mail_date, p.recipient, p.contents, p.courier, p.tracking_no, p.created_at || now()]);
      break;
    }
    case 'mail:delete': {
      const id = idByUid('mails', uid);
      if (id) run('DELETE FROM mails WHERE id = ?', [id]);
      break;
    }

    /* ---------- 事件 ---------- */
    case 'event:create': {
      if (idByUid('events', uid)) break;
      const mid = p.matter_uid ? idByUid('matters', p.matter_uid) : null;
      run('INSERT INTO events (uid, matter_id, event_date, event_time, kind, title, note, done, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [uid, mid, p.event_date, p.event_time, p.kind || 'custom', p.title, p.note, p.done || 0, p.created_at || now()]);
      break;
    }
    case 'event:update': {
      const id = idByUid('events', uid);
      if (id) run('UPDATE events SET event_date = ?, event_time = ?, kind = ?, title = ?, note = ? WHERE id = ?',
        [p.event_date, p.event_time, p.kind, p.title, p.note, id]);
      break;
    }
    case 'event:done': {
      const id = idByUid('events', uid);
      if (id) run('UPDATE events SET done = ? WHERE id = ?', [p.done ? 1 : 0, id]);
      break;
    }
    case 'event:delete': {
      const id = idByUid('events', uid);
      if (id) run('DELETE FROM events WHERE id = ?', [id]);
      break;
    }
  }
}

// 级联删除案件的子数据（按本地 id）
function cascadeDeleteMatter(id) {
  run('DELETE FROM tasks WHERE stage_id IN (SELECT id FROM stages WHERE matter_id = ?)', [id]);
  run('DELETE FROM stages WHERE matter_id = ?', [id]);
  run('DELETE FROM logs WHERE matter_id = ?', [id]);
  run('DELETE FROM mails WHERE matter_id = ?', [id]);
  run('DELETE FROM events WHERE matter_id = ?', [id]);
}

function getSyncInfo() {
  return {
    device: getDeviceId(),
    actor: getSetting('actor') || '',
    opCount: one('SELECT COUNT(*) AS c FROM oplog').c,
    lamport: parseInt(getSetting('lamport') || '0', 10)
  };
}

function getDemoState() {
  return { mode: isDemoMode(), dismissed: isDemoDismissed() };
}

function setMatterIcon(matterId, icon) {
  run('UPDATE matters SET icon = ? WHERE id = ?', [icon || '', matterId]);
  persist();
}

function renameMatter(matterId, name) {
  run('UPDATE matters SET name = ? WHERE id = ?', [name, matterId]);
  persist();
  const uid = uidById('matters', matterId);
  if (uid) logOp('matter', uid, 'rename', { name });
}

function updateCoverInfo(matterId, coverArray) {
  const cj = JSON.stringify(coverArray);
  run('UPDATE matters SET cover_info = ? WHERE id = ?', [cj, matterId]);
  persist();
  const uid = uidById('matters', matterId);
  if (uid) logOp('matter', uid, 'cover', { cover_info: cj });
}

function deleteMatter(matterId) {
  const uid = uidById('matters', matterId);
  const stageIds = all('SELECT id FROM stages WHERE matter_id = ?', [matterId]).map(r => r.id);
  for (const sid of stageIds) run('DELETE FROM tasks WHERE stage_id = ?', [sid]);
  run('DELETE FROM stages WHERE matter_id = ?', [matterId]);
  run('DELETE FROM logs WHERE matter_id = ?', [matterId]);
  run('DELETE FROM mails WHERE matter_id = ?', [matterId]);
  run('DELETE FROM events WHERE matter_id = ?', [matterId]);
  run('DELETE FROM matters WHERE id = ?', [matterId]);
  persist();
  if (uid) logOp('matter', uid, 'delete', {});
}

// ---------- 阶段列 ----------
function addStage(matterId, name) {
  const uid = genUid();
  const maxPos = one('SELECT COALESCE(MAX(position), -1) AS p FROM stages WHERE matter_id = ?', [matterId]).p;
  run('INSERT INTO stages (uid, matter_id, name, position) VALUES (?, ?, ?, ?)', [uid, matterId, name, maxPos + 1]);
  const id = lastId();
  persist();
  logOp('stage', uid, 'create', { matter_uid: uidById('matters', matterId), name });
  return id;
}

function renameStage(stageId, name) {
  run('UPDATE stages SET name = ? WHERE id = ?', [name, stageId]);
  persist();
  const uid = uidById('stages', stageId);
  if (uid) logOp('stage', uid, 'rename', { name });
}

// 重排阶段顺序：把 stageId 移动到目标索引 toIndex（同案件内）
function moveStage(stageId, toIndex) {
  const st = one('SELECT matter_id FROM stages WHERE id = ?', [stageId]);
  if (!st) return;
  const stages = all('SELECT id FROM stages WHERE matter_id = ? ORDER BY position ASC, id ASC', [st.matter_id]);
  const ids = stages.map(s => s.id).filter(id => id !== stageId);
  const idx = Math.max(0, Math.min(toIndex, ids.length));
  ids.splice(idx, 0, stageId);
  ids.forEach((id, i) => run('UPDATE stages SET position = ? WHERE id = ?', [i, id]));
  persist();
  const uid = uidById('stages', stageId);
  if (uid) logOp('stage', uid, 'move', { to_index: idx });
}

function deleteStage(stageId) {
  const uid = uidById('stages', stageId);
  run('DELETE FROM tasks WHERE stage_id = ?', [stageId]);
  run('DELETE FROM stages WHERE id = ?', [stageId]);
  persist();
  if (uid) logOp('stage', uid, 'delete', {});
}

// ---------- 卡片任务 ----------
function addTask(stageId, content) {
  const uid = genUid();
  const maxPos = one(
    'SELECT COALESCE(MAX(position), -1) AS p FROM tasks WHERE stage_id = ? AND is_completed = 0',
    [stageId]
  ).p;
  run('INSERT INTO tasks (uid, stage_id, content, is_completed, position) VALUES (?, ?, ?, 0, ?)', [
    uid, stageId, content, maxPos + 1
  ]);
  const id = lastId();
  persist();
  logOp('task', uid, 'create', { stage_uid: uidById('stages', stageId), content, is_completed: 0 });
  return id;
}

function updateTaskContent(taskId, content) {
  run('UPDATE tasks SET content = ? WHERE id = ?', [content, taskId]);
  persist();
  const uid = uidById('tasks', taskId);
  if (uid) logOp('task', uid, 'content', { content });
}

function setTaskCompleted(taskId, completed) {
  if (completed) {
    run('UPDATE tasks SET is_completed = 1, completed_at = ? WHERE id = ?', [now(), taskId]);
  } else {
    const t = one('SELECT stage_id FROM tasks WHERE id = ?', [taskId]);
    const maxPos = one(
      'SELECT COALESCE(MAX(position), -1) AS p FROM tasks WHERE stage_id = ? AND is_completed = 0',
      [t.stage_id]
    ).p;
    run('UPDATE tasks SET is_completed = 0, completed_at = NULL, position = ? WHERE id = ?', [
      maxPos + 1, taskId
    ]);
  }
  persist();
  const uid = uidById('tasks', taskId);
  if (uid) logOp('task', uid, 'complete', { completed: completed ? 1 : 0 });
}

function deleteTask(taskId) {
  const uid = uidById('tasks', taskId);
  run('DELETE FROM tasks WHERE id = ?', [taskId]);
  persist();
  if (uid) logOp('task', uid, 'delete', {});
}

// 拖拽移动：移动到目标列 toStageId 的未完成区第 toIndex 位，并重排两列 position
function moveTask(taskId, toStageId, toIndex) {
  const moving = one('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!moving) return;
  const fromStageId = moving.stage_id;

  // 目标列未完成任务（剔除自身）按当前顺序取出
  const target = all(
    'SELECT id FROM tasks WHERE stage_id = ? AND is_completed = 0 AND id != ? ORDER BY position ASC, id ASC',
    [toStageId, taskId]
  ).map(r => r.id);

  const idx = Math.max(0, Math.min(toIndex, target.length));
  target.splice(idx, 0, taskId);
  target.forEach((id, i) => {
    run('UPDATE tasks SET stage_id = ?, position = ? WHERE id = ?', [toStageId, i, id]);
  });

  // 原列重排（跨列移动时）
  if (fromStageId !== toStageId) {
    const rest = all(
      'SELECT id FROM tasks WHERE stage_id = ? AND is_completed = 0 ORDER BY position ASC, id ASC',
      [fromStageId]
    ).map(r => r.id);
    rest.forEach((id, i) => run('UPDATE tasks SET position = ? WHERE id = ?', [i, id]));
  }
  persist();
}

function getTemplates() {
  return all('SELECT * FROM templates ORDER BY position ASC').map(row => ({
    key: row.key, icon: row.icon, name: row.name, type: row.type,
    description: row.description || '',
    cover: JSON.parse(row.cover),
    stages: JSON.parse(row.stages)
  }));
}

// ---------- 模板备份 ----------
function backupTemplates(reason = 'manual') {
  const rows = all('SELECT * FROM templates ORDER BY position ASC');
  run('INSERT INTO template_backups (created_at, reason, data) VALUES (?, ?, ?)', [
    now(), reason, JSON.stringify(rows)
  ]);
  // 仅保留最近 50 份
  run(`DELETE FROM template_backups WHERE id NOT IN (
        SELECT id FROM template_backups ORDER BY id DESC LIMIT 50
      )`);
  persist();
}

function listTemplateBackups() {
  return all('SELECT id, created_at, reason FROM template_backups ORDER BY id DESC');
}

function restoreTemplateBackup(backupId) {
  const bak = one('SELECT * FROM template_backups WHERE id = ?', [backupId]);
  if (!bak) throw new Error('备份不存在');
  backupTemplates('pre-restore'); // 还原前先把当前状态再备份一份
  const rows = JSON.parse(bak.data);
  run('DELETE FROM templates');
  rows.forEach(r => {
    run('INSERT INTO templates (key, icon, name, type, description, cover, stages, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      r.key, r.icon, r.name, r.type, r.description || '', r.cover, r.stages, r.position
    ]);
  });
  persist();
}

// 新建自定义模板
function createTemplate() {
  backupTemplates('pre-save');
  const key = 'custom_' + Date.now();
  const maxPos = one('SELECT COALESCE(MAX(position), -1) AS p FROM templates').p;
  run('INSERT INTO templates (key, icon, name, type, description, cover, stages, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    key, 'folder', '新模板', '民商事', '',
    JSON.stringify([['案号', ''], ['承办法官', ''], ['委托人', ''], ['备注', '']]),
    JSON.stringify([{ name: '📂 阶段一', tasks: [] }]),
    maxPos + 1
  ]);
  persist();
  return key;
}

// 删除自定义模板（出厂模板不可删除，只能恢复出厂）
function deleteTemplate(key) {
  if (TEMPLATES[key]) throw new Error('出厂模板不可删除');
  backupTemplates('pre-save');
  run('DELETE FROM templates WHERE key = ?', [key]);
  persist();
}

// ---------- 模板导入/导出（用于分享"办案思路"）----------
// 模板文件格式（.mvtpl.json）：
// { format:'mattervibe-template', version:1, author, exported_at,
//   template:{ name, type, icon, description, cover:[[k,v]...],
//              stages:[{name, note, tasks:[...]}...] } }
function exportTemplate(key) {
  const row = one('SELECT * FROM templates WHERE key = ?', [key]);
  if (!row) throw new Error('模板不存在');
  return {
    format: 'mattervibe-template',
    version: 1,
    author: getSetting('actor') || '',
    exported_at: now(),
    template: {
      name: row.name,
      type: row.type,
      icon: row.icon,
      description: row.description || '',
      cover: JSON.parse(row.cover),
      stages: JSON.parse(row.stages)
    }
  };
}

// 校验并导入一个模板包；导入为"新增"的自定义模板，绝不覆盖现有模板
function importTemplate(pkg) {
  if (!pkg || pkg.format !== 'mattervibe-template' || !pkg.template) {
    throw new Error('不是有效的 MatterVibe 模板文件');
  }
  const t = pkg.template;
  if (!t.name || !Array.isArray(t.stages)) {
    throw new Error('模板文件缺少必要字段（name / stages）');
  }
  // 规整 stages：确保每个阶段有 name 和 tasks 数组，note 可选
  const stages = t.stages.map(st => ({
    name: String(st.name || '📂 阶段'),
    note: st.note ? String(st.note) : '',
    tasks: Array.isArray(st.tasks) ? st.tasks.map(x => String(x)) : []
  }));
  const cover = Array.isArray(t.cover) ? t.cover : [];
  backupTemplates('pre-import');
  const key = 'imported_' + Date.now();
  const maxPos = one('SELECT COALESCE(MAX(position), -1) AS p FROM templates').p;
  run('INSERT INTO templates (key, icon, name, type, description, cover, stages, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    key, t.icon || 'folder', String(t.name), t.type || '民商事', t.description || '',
    JSON.stringify(cover), JSON.stringify(stages), maxPos + 1
  ]);
  persist();
  return { key, name: t.name, stages: stages.length };
}

// ---------- 设置 ----------
function getSetting(key) {
  const row = one('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key, String(value)
  ]);
  persist();
}

// 保存编辑后的模板（data: {icon, name, type, cover:[[k,v]...], stages:[{name,tasks:[]}...]}）
function saveTemplate(key, data) {
  backupTemplates('pre-save'); // 改动前自动备份
  run('UPDATE templates SET icon = ?, name = ?, type = ?, description = ?, cover = ?, stages = ? WHERE key = ?', [
    data.icon || '📁',
    data.name || '未命名模板',
    data.type || '民商事',
    data.description || '',
    JSON.stringify(data.cover || []),
    JSON.stringify(data.stages || []),
    key
  ]);
  persist();
}

// 恢复某套模板为出厂内容
function resetTemplate(key) {
  const t = TEMPLATES[key];
  if (!t) throw new Error('该模板没有出厂版本：' + key);
  backupTemplates('pre-reset'); // 恢复出厂前自动备份
  run('UPDATE templates SET icon = ?, name = ?, type = ?, description = ?, cover = ?, stages = ? WHERE key = ?', [
    t.icon, t.name, t.type, t.description || '', JSON.stringify(t.cover), JSON.stringify(t.stages), key
  ]);
  persist();
}

function getDbPath() { return dbPath; }
function getBackupDir() { return backupDir; }

module.exports = {
  init, getDbPath,
  listMatters, listArchivedMatters, setMatterArchived, getMatter, createMatter, cloneMatter, renameMatter,
  setMatterIcon, setMatterRemind, setMatterFolder, updateCoverInfo, deleteMatter,
  listLogs, addLog, deleteLog,
  listMails, addMail, deleteMail,
  getRecordCounts, getDeadlines, getReminders,
  listEvents, addEvent, updateEvent, setEventDone, deleteEvent,
  getAgenda, getDashboard,
  importDemoData, clearDemoAndStart, getDemoState, isDemoMode, isDemoDismissed,
  logOp, exportSyncPackage, importSyncPackage, getSyncInfo, getDeviceId, genUid,
  addStage, renameStage, moveStage, deleteStage,
  addTask, updateTaskContent, setTaskCompleted, setTaskDue, deleteTask, moveTask,
  getTemplates, saveTemplate, resetTemplate,
  exportTemplate, importTemplate,
  createTemplate, deleteTemplate,
  backupTemplates, listTemplateBackups, restoreTemplateBackup,
  fullBackup, listFullBackups, restoreFullBackup, importDb,
  maybeAutoFullBackup, getSchemaInfo, getUpgradedFrom, getBackupDir,
  getSetting, setSetting
};
