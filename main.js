// main.js —— MatterVibe 主进程
// macOS 原生毛玻璃（vibrancy）+ 无边框窗口 + 全部数据库 IPC 通道

'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const syncCrypto = require('./sync-crypto');
const webdav = require('./sync-webdav');

let win = null;

/* ============================================================
   AI 本地接口（供 Marvis / 小龙虾 OpenClaw 等 Agent 调用）
   仅监听 127.0.0.1，Bearer Token 鉴权，默认关闭，可只读
   ============================================================ */
let apiServer = null;

function notifyDataChanged() {
  BrowserWindow.getAllWindows().forEach(w => {
    try { w.webContents.send('mf:changed'); } catch (_) {}
  });
}

function apiJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function startApiServer() {
  stopApiServer();
  const port = parseInt(db.getSetting('api_port') || '2046', 10);
  const token = db.getSetting('api_token') || '';
  const readonly = db.getSetting('api_readonly') === '1';

  apiServer = http.createServer((req, res) => {
    // 鉴权
    const auth = req.headers['authorization'] || '';
    if (!token || auth !== `Bearer ${token}`) {
      return apiJson(res, 401, { ok: false, error: '未授权：请携带 Authorization: Bearer <token>' });
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    if (parts[0] !== 'api') return apiJson(res, 404, { ok: false, error: '未知路径' });

    const finish = (fn) => {
      try {
        const data = fn();
        apiJson(res, 200, { ok: true, data: data === undefined ? null : data });
      } catch (e) {
        apiJson(res, 400, { ok: false, error: String(e && e.message || e) });
      }
    };

    if (req.method === 'GET') {
      if (parts[1] === 'health') return finish(() => ({ app: 'MatterVibe', version: app.getVersion(), readonly }));
      if (parts[1] === 'matters' && !parts[2]) return finish(() => db.listMatters());
      if (parts[1] === 'matters' && parts[2]) return finish(() => db.getMatter(+parts[2]));
      if (parts[1] === 'templates') return finish(() => db.getTemplates().map(t => ({ key: t.key, name: t.name, type: t.type, description: t.description })));
      if (parts[1] === 'deadlines') return finish(() => db.getDeadlines());
      if (parts[1] === 'agenda') return finish(() => db.getAgenda({ from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
      if (parts[1] === 'events') return finish(() => db.listEvents({ from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
      if (parts[1] === 'logs' && parts[2]) return finish(() => db.listLogs(+parts[2]));
      if (parts[1] === 'mails' && parts[2]) return finish(() => db.listMails(+parts[2]));
      return apiJson(res, 404, { ok: false, error: '未知接口' });
    }

    if (req.method === 'POST') {
      if (readonly) return apiJson(res, 403, { ok: false, error: '接口处于只读模式' });
      const chunks = [];
      let received = 0;
      req.on('data', c => {
        received += c.length;
        if (received > 1e6) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        let b = {};
        try {
          const raw = Buffer.concat(chunks).toString('utf8'); // 始终按 UTF-8 解码，防止中文乱码
          b = raw ? JSON.parse(raw) : {};
        } catch (_) {
          return apiJson(res, 400, { ok: false, error: '请求体不是合法 JSON（请确保以 UTF-8 编码发送）' });
        }
        const done = (fn) => { finish(fn); notifyDataChanged(); };

        // 建案
        if (parts[1] === 'matters' && !parts[2]) {
          return done(() => ({ id: db.createMatter(b.name, b.template || 'minshangshi') }));
        }
        // 更新封皮：merge 模式，按要素名更新或追加
        if (parts[1] === 'matters' && parts[2] === undefined) {}
        if (parts[1] === 'matters' && parts[2] && parts[3] === 'cover') {
          return done(() => {
            const matter = db.getMatter(+parts[2]);
            if (!matter) throw new Error('案件不存在');
            const cover = matter.cover_info.slice();
            for (const [k, v] of (b.updates || [])) {
              // 防御：疑似乱码的 key（含连续问号或全为问号）不入库，避免污染封皮
              if (/\?{2,}/.test(String(k)) || /^\?+$/.test(String(k).trim())) continue;
              const idx = cover.findIndex(p => p[0] === k);
              if (idx >= 0) cover[idx] = [k, String(v)];
              else cover.push([k, String(v)]);
            }
            db.updateCoverInfo(+parts[2], cover);
            return { cover };
          });
        }
        // 加阶段
        if (parts[1] === 'stages') {
          return done(() => ({ id: db.addStage(b.matter_id, b.name || '📂 新阶段') }));
        }
        // 加任务：支持 stage_id 或 matter_id + stage_name 健壮匹配
        if (parts[1] === 'tasks' && !parts[2]) {
          return done(() => {
            let stageId = b.stage_id;
            if (!stageId && b.matter_id) {
              const matter = db.getMatter(+b.matter_id);
              if (!matter) throw new Error('案件不存在');
              if (b.stage_name) {
                // 归一化：去掉 emoji/符号/空格后双向包含匹配，提升命中率
                const norm = s => String(s).replace(/[\s\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\uFE0F\u{1F1E6}-\u{1F1FF}]/gu, '').trim();
                const want = norm(b.stage_name);
                let hit = matter.stages.find(s => norm(s.name) === want)
                       || matter.stages.find(s => norm(s.name).includes(want) || want.includes(norm(s.name)));
                if (!hit) {
                  const names = matter.stages.map(s => s.name).join(' / ');
                  throw new Error('未找到匹配阶段「' + b.stage_name + '」。该案件可用阶段为：' + names + '。请改用其中一个名称，或直接用 stage_id。');
                }
                stageId = hit.id;
              } else {
                stageId = matter.stages.length ? matter.stages[0].id : null;
              }
            }
            if (!stageId) throw new Error('缺少 stage_id 或 matter_id');
            if (!b.content) throw new Error('缺少 content');
            return { id: db.addTask(stageId, String(b.content)) };
          });
        }
        // 划销/恢复任务
        if (parts[1] === 'tasks' && parts[2] && parts[3] === 'complete') {
          return done(() => { db.setTaskCompleted(+parts[2], b.done !== false); return null; });
        }
        // 结构化事件（开庭/举证/调解续封/自定义）
        if (parts[1] === 'events') {
          return done(() => ({ id: db.addEvent(b) }));
        }
        // 办案日志
        if (parts[1] === 'logs') {
          return done(() => ({ id: db.addLog(b.matter_id, b.content, b.hours, b.date) }));
        }
        // 邮寄记录
        if (parts[1] === 'mails') {
          return done(() => ({ id: db.addMail(b.matter_id, b) }));
        }
        return apiJson(res, 404, { ok: false, error: '未知接口' });
      });
      return;
    }
    apiJson(res, 405, { ok: false, error: '不支持的方法' });
  });

  apiServer.listen(port, '127.0.0.1');
  apiServer.on('error', () => { apiServer = null; });
}

function stopApiServer() {
  if (apiServer) { try { apiServer.close(); } catch (_) {} apiServer = null; }
}


function createWindow() {
  const isMac = process.platform === 'darwin';
  const opts = {
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    title: 'MatterVibe',
    icon: path.join(__dirname, 'assets', isMac ? 'icon.png' : 'icon.ico'), // 任务栏/窗口图标
    frame: false,                 // 无边框：窗口控制按钮自绘于右上角
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  };
  if (isMac) {
    // macOS：原生毛玻璃
    opts.vibrancy = 'under-window';
    opts.visualEffectState = 'active';
    opts.backgroundColor = '#00000000';
  } else {
    // Windows/Linux：无毛玻璃，用接近主题的纯色背景，避免透明导致的黑底/白底异常
    opts.backgroundColor = '#F4F5F8';
  }
  win = new BrowserWindow(opts);
  // 标记平台到 body class，供 CSS 关闭毛玻璃相关样式
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript("document.body.classList.add('" + (isMac ? 'is-mac' : 'is-win') + "')").catch(() => {});
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 窗口最大化/全屏状态变化 → 通知渲染层切换按钮图标
  const sendMax = (val) => { try { win.webContents.send('window:maxState', val); } catch (e) {} };
  win.on('enter-full-screen', () => sendMax(true));
  win.on('leave-full-screen', () => sendMax(false));
  win.on('maximize', () => sendMax(true));
  win.on('unmaximize', () => sendMax(false));
}

let upgradeInfo = null; // { from, to } 本次启动若发生结构升级

let migrationResult = null; // { migrated:bool, from:string, count:int } 供启动后提示

// 查找含有 law_practice.db 的旧数据目录
function findLegacyDir() {
  const cur = app.getPath('userData');
  const parent = path.dirname(cur);
  const candidates = ['MatterFlow', 'matterflow', 'matter-flow', 'Matterflow'];
  for (const name of candidates) {
    const dir = path.join(parent, name);
    if (dir !== cur && fs.existsSync(path.join(dir, 'law_practice.db'))) return dir;
  }
  return null;
}

// 数一个 sqlite 文件里的案件数（用文件大小粗判是否为"有数据的库"，不解析以免依赖）
function dbLooksNonEmpty(file) {
  try { return fs.statSync(file).size > 20000; } catch (e) { return false; }
}

function copyLegacy(legacy, cur) {
  fs.copyFileSync(path.join(legacy, 'law_practice.db'), path.join(cur, 'law_practice.db'));
  const legacyBak = path.join(legacy, 'backups');
  if (fs.existsSync(legacyBak)) {
    const newBak = path.join(cur, 'backups');
    if (!fs.existsSync(newBak)) fs.mkdirSync(newBak, { recursive: true });
    for (const f of fs.readdirSync(legacyBak)) {
      try { fs.copyFileSync(path.join(legacyBak, f), path.join(newBak, f)); } catch (e) {}
    }
  }
}

// 迁移完成标记文件（存在即表示已处理过，永不再迁移/再提示，避免重复与死循环）
function migratedFlagPath() { return path.join(app.getPath('userData'), '.legacy_migrated'); }
function isLegacyMigrated() { try { return fs.existsSync(migratedFlagPath()); } catch (e) { return false; } }
function markLegacyMigrated(from) {
  try { fs.writeFileSync(migratedFlagPath(), JSON.stringify({ at: new Date().toISOString(), from: from || '' })); } catch (e) {}
}

// 老数据目录（MatterFlow）→ 新目录（MatterVibe）平滑迁移，零数据损失
function migrateLegacyUserData() {
  try {
    if (isLegacyMigrated()) return;                      // 已处理过，绝不重复
    const cur = app.getPath('userData');                 // …/MatterVibe
    const newDb = path.join(cur, 'law_practice.db');
    const legacy = findLegacyDir();
    if (!legacy) return;

    if (!fs.existsSync(newDb)) {
      // 情况一：新目录没有库 —— 直接迁移
      copyLegacy(legacy, cur);
      markLegacyMigrated(legacy);
      migrationResult = { migrated: true, from: legacy };
      console.log('[MatterVibe] 已从旧目录迁移数据：' + legacy);
    } else if (!dbLooksNonEmpty(newDb) && dbLooksNonEmpty(path.join(legacy, 'law_practice.db'))) {
      // 情况二：新目录是空库，但旧目录有真实数据 —— 备份空库后用旧库覆盖
      try { fs.renameSync(newDb, newDb + '.empty-' + Date.now()); } catch (e) {}
      copyLegacy(legacy, cur);
      markLegacyMigrated(legacy);
      migrationResult = { migrated: true, from: legacy, recovered: true };
      console.log('[MatterVibe] 检测到空库，已用旧目录的数据恢复：' + legacy);
    }
    // 情况三：新目录已有真实数据 —— 不迁移，但也标记为已处理，今后不再提示
    else if (dbLooksNonEmpty(newDb)) {
      markLegacyMigrated('(new-db-already-has-data)');
    }
  } catch (e) { /* 迁移失败不阻断启动，旧数据仍在原处不受影响 */ }
}

// 显式锁定应用名与数据目录为 MatterVibe，避免 package.json name 字段大小写导致路径漂移
app.setName('MatterVibe');
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.mattervibe.app'); } catch (e) {}
}
try {
  const appSupport = app.getPath('appData');
  app.setPath('userData', path.join(appSupport, 'MatterVibe'));
} catch (e) { /* 某些平台 appData 不可用时退回默认 */ }

app.whenReady().then(async () => {
  // 数据目录：~/Library/Application Support/MatterVibe/law_practice.db
  if (!fs.existsSync(app.getPath('userData'))) {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
  }
  migrateLegacyUserData();

  // 程序坞（Dock）图标：开发态 npm start 也生效；打包态由 .icns 接管
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'))); } catch (e) {}
  }

  await db.init(app.getPath('userData'));
  const si = db.getSchemaInfo();
  // stored 已被 init 写成最新；用 init 内部对 prevVer 的判断由 db 暴露
  const uf = db.getUpgradedFrom();
  if (uf && uf < si.version) {
    upgradeInfo = { from: uf, to: si.version, appVersion: app.getVersion() };
  }
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC：渲染进程 <-> SQLite ----------
function registerIpc() {
  const H = (channel, fn) =>
    ipcMain.handle(channel, async (_e, ...args) => fn(...args));

  H('matters:list',      ()                       => db.listMatters());
  H('matters:archivedList', ()                    => db.listArchivedMatters());
  H('matters:archive',   (id, on)                 => { db.setMatterArchived(id, on); return true; });
  H('matters:get',       (id)                     => db.getMatter(id));
  H('matters:create',    (name, templateKey)      => db.createMatter(name, templateKey));
  H('matters:clone',     (id)                     => db.cloneMatter(id));
  H('matters:rename',    (id, name)               => db.renameMatter(id, name));
  H('matters:icon',      (id, icon)               => db.setMatterIcon(id, icon));
  H('matters:remind',    (id, on)                 => db.setMatterRemind(id, on));
  H('matters:folder',    (id, p)                  => db.setMatterFolder(id, p));

  // 文件夹：选择 / 在指定位置创建 / 打开
  H('folder:choose', async (title) => {
    const r = await dialog.showOpenDialog(win, {
      title: title || '选择文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
  });
  H('folder:createIn', (parent, name) => {
    const safe = String(name || '新案件').replace(/[\\/:*?"<>|]/g, '·').trim() || '新案件';
    const p = path.join(parent, safe);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    return p;
  });
  H('folder:open', async (p) => {
    if (!p || !fs.existsSync(p)) return '文件夹不存在或已被移动';
    const err = await shell.openPath(p);
    return err || '';
  });

  H('logs:list',         (matterId)               => db.listLogs(matterId));
  H('logs:add',          (matterId, content, hours, date) => db.addLog(matterId, content, hours, date));
  H('logs:delete',       (id)                     => db.deleteLog(id));

  H('mails:list',        (matterId)               => db.listMails(matterId));
  H('mails:add',         (matterId, data)         => db.addMail(matterId, data));
  H('mails:delete',      (id)                     => db.deleteMail(id));

  H('records:counts',    (matterId)               => db.getRecordCounts(matterId));
  H('deadlines:list',    ()                       => db.getDeadlines());
  H('reminders:list',    ()                       => db.getReminders());

  H('events:list',   (opts)      => db.listEvents(opts || {}));
  H('events:add',    (data)      => db.addEvent(data));
  H('events:update', (id, data)  => db.updateEvent(id, data));
  H('events:done',   (id, done)  => db.setEventDone(id, done));
  H('events:delete', (id)        => db.deleteEvent(id));
  H('agenda:list',   (opts)      => db.getAgenda(opts || {}));
  H('dashboard:get', ()          => db.getDashboard());

  H('demo:state',   ()  => db.getDemoState());
  H('demo:import',  ()  => { const r = db.importDemoData(); notifyDataChanged(); return r; });
  H('demo:clear',   ()  => { const r = db.clearDemoAndStart(); notifyDataChanged(); return r; });

  H('sync:info', () => db.getSyncInfo());
  H('sync:export', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: '导出同步包',
      defaultPath: 'mattervibe-sync-' + Date.now() + '.json',
      filters: [{ name: 'MatterVibe 同步包', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, JSON.stringify(db.exportSyncPackage()));
    return { canceled: false, file: r.filePath };
  });
  H('sync:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '导入并合并同步包',
      properties: ['openFile'],
      filters: [{ name: 'MatterVibe 同步包', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    try { db.fullBackup('pre-sync-import'); } catch (e) {}
    const pkg = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const res = db.importSyncPackage(pkg);
    notifyDataChanged();
    return { canceled: false, result: res };
  });

  /* ---------- 坚果云 / WebDAV 自动同步 ---------- */
  const CLOUD_DIR = 'MatterVibe';
  const VERIFIER_FILE = CLOUD_DIR + '/passphrase.verify';

  function cloudCfg() {
    return {
      url: db.getSetting('cloud_url') || 'https://dav.jianguoyun.com/dav/',
      account: db.getSetting('cloud_account') || '',
      password: db.getSetting('cloud_password') || ''
    };
  }
  function cloudEnabled() { return db.getSetting('cloud_enabled') === '1'; }
  function cloudPassphrase() { return db.getSetting('cloud_passphrase') || ''; }

  // 读取云端同步状态信息（供界面显示）
  H('cloud:status', () => ({
    enabled: cloudEnabled(),
    url: db.getSetting('cloud_url') || 'https://dav.jianguoyun.com/dav/',
    account: db.getSetting('cloud_account') || '',
    hasPassword: !!db.getSetting('cloud_password'),
    hasPassphrase: !!db.getSetting('cloud_passphrase'),
    interval: parseInt(db.getSetting('cloud_interval') || '0', 10), // 分钟，0=不定时
    lastSync: db.getSetting('cloud_last_sync') || '',
    device: db.getDeviceId()
  }));

  // 测试连接（配置时用）
  H('cloud:test', async (cfg) => {
    try {
      await webdav.testConnection({ url: cfg.url, account: cfg.account, password: cfg.password }, CLOUD_DIR);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 保存配置。首次设置口令时，在云端写入“口令校验串”；换设备时校验口令是否与云端一致
  H('cloud:saveConfig', async (cfg) => {
    const c = { url: cfg.url, account: cfg.account, password: cfg.password };
    try {
      await webdav.ensureDir(c, CLOUD_DIR);
      // 处理口令校验串
      const existing = await webdav.getFile(c, VERIFIER_FILE);
      if (existing) {
        // 云端已有校验串：必须用相同口令才能通过
        let v;
        try { v = JSON.parse(existing); } catch (e) { v = null; }
        if (v && !syncCrypto.checkVerifier(v, cfg.passphrase)) {
          return { ok: false, error: '加密口令与云端已有数据不一致。请输入与其他设备相同的加密口令，否则无法解密云端数据。' };
        }
      } else {
        // 云端没有：这是第一台设备，写入校验串
        const verifier = syncCrypto.makeVerifier(cfg.passphrase);
        await webdav.putFile(c, VERIFIER_FILE, JSON.stringify(verifier));
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
    db.setSetting('cloud_url', cfg.url);
    db.setSetting('cloud_account', cfg.account);
    db.setSetting('cloud_password', cfg.password);
    db.setSetting('cloud_passphrase', cfg.passphrase);
    db.setSetting('cloud_interval', String(cfg.interval || 0));
    db.setSetting('cloud_enabled', '1');
    scheduleCloudTimer();
    return { ok: true };
  });

  H('cloud:disable', () => {
    db.setSetting('cloud_enabled', '0');
    scheduleCloudTimer();
    return true;
  });

  // 执行一次云同步：上传本机 oplog（加密）+ 拉取其他设备并合并
  async function cloudSync() {
    if (!cloudEnabled()) return { ok: false, error: '未启用云同步' };
    const c = cloudCfg();
    const pass = cloudPassphrase();
    if (!c.account || !c.password || !pass) return { ok: false, error: '云同步配置不完整' };

    const device = db.getDeviceId();
    const myFile = CLOUD_DIR + '/ops-' + device + '.enc';
    let pulled = 0, applied = 0;

    // 同步前自动整库备份（保险绳）
    try { db.fullBackup('pre-cloud-sync'); } catch (e) {}

    await webdav.ensureDir(c, CLOUD_DIR);

    // 1) 上传本机全量 oplog（加密）
    const myPkg = db.exportSyncPackage();
    const cipher = JSON.stringify(syncCrypto.encrypt(JSON.stringify(myPkg), pass));
    await webdav.putFile(c, myFile, cipher);

    // 2) 列目录，下载其他设备的 ops 文件并合并
    const files = await webdav.listDir(c, CLOUD_DIR);
    for (const f of files) {
      if (!f.startsWith('ops-') || !f.endsWith('.enc')) continue;
      if (f === 'ops-' + device + '.enc') continue; // 跳过自己
      const raw = await webdav.getFile(c, CLOUD_DIR + '/' + f);
      if (!raw) continue;
      let pkg;
      try {
        const plain = syncCrypto.decrypt(JSON.parse(raw), pass);
        pkg = JSON.parse(plain);
      } catch (e) {
        // 单个文件解密失败不阻断其他文件；通常是口令不一致
        return { ok: false, error: '解密「' + f + '」失败：' + e.message };
      }
      const res = db.importSyncPackage(pkg);
      pulled++;
      applied += res.applied;
    }
    db.setSetting('cloud_last_sync', new Date().toISOString());
    notifyDataChanged();
    return { ok: true, devices: pulled, applied };
  }

  H('cloud:syncNow', async () => {
    try { return await cloudSync(); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // 导出加密口令备份文件（提示用户妥善保管）
  H('cloud:exportPassphrase', async () => {
    const pass = cloudPassphrase();
    if (!pass) return { canceled: true, error: '尚未设置加密口令' };
    const r = await dialog.showSaveDialog(win, {
      title: '导出加密口令备份',
      defaultPath: 'MatterVibe-加密口令备份.txt',
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    const content = 'MatterVibe 同步加密口令备份\n' +
      '========================================\n\n' +
      '加密口令：' + pass + '\n\n' +
      '说明：此口令用于加密同步到坚果云的案件数据。\n' +
      '· 在新设备上配置同步时，需输入完全相同的口令，才能解密云端数据。\n' +
      '· 此口令一旦遗忘，云端已加密的数据将无法恢复（本地数据不受影响）。\n' +
      '· 请将本文件保存在安全的地方（如密码管理器），切勿与他人共享。\n';
    fs.writeFileSync(r.filePath, content);
    return { canceled: false, file: r.filePath };
  });

  // 定时同步
  let cloudTimer = null;
  function scheduleCloudTimer() {
    if (cloudTimer) { clearInterval(cloudTimer); cloudTimer = null; }
    if (!cloudEnabled()) return;
    const mins = parseInt(db.getSetting('cloud_interval') || '0', 10);
    if (mins > 0) {
      cloudTimer = setInterval(() => { cloudSync().catch(() => {}); }, mins * 60 * 1000);
    }
  }
  // 启动时若已启用云同步，自动同步一次（“打开即同步”）
  setTimeout(() => {
    if (cloudEnabled()) cloudSync().catch(() => {});
    scheduleCloudTimer();
  }, 2500);


  // 全量备份 / 恢复 / 导入
  H('backup:run',     ()    => db.fullBackup('manual'));
  H('backup:list',    ()    => db.listFullBackups());
  H('backup:reveal',  ()    => { shell.showItemInFolder(db.getBackupDir()); return db.getBackupDir(); });
  H('backup:restore', async (file) => {
    await db.restoreFullBackup(file);
    notifyDataChanged();
    return true;
  });
  H('backup:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '导入 MatterVibe 数据库（.db）',
      properties: ['openFile'],
      filters: [{ name: 'MatterVibe 数据库', extensions: ['db'] }]
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    await db.importDb(r.filePaths[0]);
    notifyDataChanged();
    return { canceled: false, file: r.filePaths[0] };
  });
  H('backup:export', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: '导出当前数据库副本',
      defaultPath: `matterflow-导出-${Date.now()}.db`,
      filters: [{ name: 'MatterVibe 数据库', extensions: ['db'] }]
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.copyFileSync(db.getDbPath(), r.filePath);
    return { canceled: false, file: r.filePath };
  });

  // 升级信息（供升级欢迎页）
  H('upgrade:info', () => upgradeInfo);
  H('upgrade:ack',  () => { upgradeInfo = null; return true; });

  // 数据迁移结果 + 手动从旧版本恢复
  H('migrate:result', () => migrationResult);
  H('migrate:legacyExists', () => {
    if (isLegacyMigrated()) return null;          // 已处理过，不再提示
    const legacy = findLegacyDir();
    return legacy ? { dir: legacy, hasData: dbLooksNonEmpty(path.join(legacy, 'law_practice.db')) } : null;
  });
  H('migrate:recoverNow', async () => {
    const cur = app.getPath('userData');
    const legacy = findLegacyDir();
    if (!legacy) throw new Error('未找到旧版本数据目录');
    // 先把当前库整库备份留底，再用旧库覆盖，写入"已迁移"标记后重启——标记确保重启后不再触发恢复
    try { db.fullBackup('pre-legacy-recover'); } catch (e) {}
    copyLegacy(legacy, cur);
    markLegacyMigrated(legacy);
    setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
    return { from: legacy, willRestart: true };
  });

  // AI 接口管理
  H('aiapi:status', () => ({
    enabled: db.getSetting('api_enabled') === '1',
    running: !!apiServer,
    port: db.getSetting('api_port') || '2046',
    token: db.getSetting('api_token') || '',
    readonly: db.getSetting('api_readonly') === '1'
  }));
  H('aiapi:config', (cfg) => {
    if (cfg.regenToken || !db.getSetting('api_token')) {
      db.setSetting('api_token', crypto.randomBytes(16).toString('hex'));
    }
    if (cfg.port) db.setSetting('api_port', String(cfg.port));
    if (cfg.readonly !== undefined) db.setSetting('api_readonly', cfg.readonly ? '1' : '0');
    if (cfg.enabled !== undefined) {
      db.setSetting('api_enabled', cfg.enabled ? '1' : '0');
      cfg.enabled ? startApiServer() : stopApiServer();
    } else if (db.getSetting('api_enabled') === '1') {
      startApiServer(); // 端口/只读变更后重启
    }
    return {
      enabled: db.getSetting('api_enabled') === '1',
      running: !!apiServer,
      port: db.getSetting('api_port') || '2046',
      token: db.getSetting('api_token') || '',
      readonly: db.getSetting('api_readonly') === '1'
    };
  });
  H('matters:cover',     (id, coverArray)         => db.updateCoverInfo(id, coverArray));
  H('matters:delete',    (id)                     => db.deleteMatter(id));

  H('stages:add',        (matterId, name)         => db.addStage(matterId, name));
  H('stages:rename',     (stageId, name)          => db.renameStage(stageId, name));
  H('stages:move',       (stageId, toIndex)       => { db.moveStage(stageId, toIndex); return true; });
  H('stages:delete',     (stageId)                => db.deleteStage(stageId));

  H('tasks:add',         (stageId, content)       => db.addTask(stageId, content));
  H('tasks:update',      (taskId, content)        => db.updateTaskContent(taskId, content));
  H('tasks:complete',    (taskId, completed)      => db.setTaskCompleted(taskId, completed));
  H('tasks:delete',      (taskId)                 => db.deleteTask(taskId));
  H('tasks:move',        (taskId, stageId, index) => db.moveTask(taskId, stageId, index));
  H('tasks:due',         (taskId, due)            => { db.setTaskDue(taskId, due); return true; });

  H('templates:list',    ()                       => db.getTemplates());
  H('template:export', async (key) => {
    const pkg = db.exportTemplate(key);
    const safeName = (pkg.template.name || 'template').replace(/[\\/:*?"<>|]/g, '_');
    const r = await dialog.showSaveDialog(win, {
      title: '导出模板',
      defaultPath: safeName + '.mvtpl.json',
      filters: [{ name: 'MatterVibe 模板', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, JSON.stringify(pkg, null, 2));
    return { canceled: false, file: r.filePath };
  });
  H('template:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '导入模板',
      properties: ['openFile'],
      filters: [{ name: 'MatterVibe 模板', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    const pkg = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const res = db.importTemplate(pkg);
    return { canceled: false, result: res };
  });
  H('templates:save',    (key, data)              => db.saveTemplate(key, data));
  H('templates:reset',   (key)                    => db.resetTemplate(key));
  H('templates:new',     ()                       => db.createTemplate());
  H('templates:delete',  (key)                    => db.deleteTemplate(key));
  H('templates:backup',  ()                       => db.backupTemplates('manual'));
  H('templates:backups', ()                       => db.listTemplateBackups());
  H('templates:restore', (backupId)               => db.restoreTemplateBackup(backupId));

  H('settings:get',      (key)                    => db.getSetting(key));
  H('settings:set',      (key, value)             => db.setSetting(key, value));

  // 窗口控制（无边框窗口的自绘按钮）：按事件来源窗口分别处理
  ipcMain.handle('window:minimize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.minimize();
  });
  ipcMain.handle('window:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.setFullScreen(!w.isFullScreen()); // 最大化 = 进入/退出 macOS 全屏
  });
  ipcMain.handle('window:close', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w === win) app.quit();   // 主窗口关闭 = 退出应用
    else if (w) w.close();       // 工具箱等子窗口关闭 = 只关自己
  });

  // 律师工具箱（独立窗口）
  H('toolbox:open', () => { if (win) win.webContents.send('toolbox:show'); });

  // 备份所有案件：把整个 SQLite 单文件复制到 backups 目录，并在访达中显示
  H('data:backup', () => {
    const src = db.getDbPath();
    const dir = path.join(app.getPath('userData'), 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const p = n => String(n).padStart(2, '0');
    const d = new Date();
    const stamp = `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const dest = path.join(dir, `law_practice-${stamp}.db`);
    fs.copyFileSync(src, dest);
    shell.showItemInFolder(dest);
    return dest;
  });
}
