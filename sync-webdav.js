'use strict';
/* ============================================================
   MatterVibe WebDAV 客户端（坚果云等）
   仅用 Node 内置 https/http，无第三方依赖。
   提供：确保目录存在、上传文件、下载文件、列目录。
   所有方法返回 Promise，错误信息中文化便于排查。
   ============================================================ */
const https = require('https');
const http = require('http');
const { URL } = require('url');

// 发一个 WebDAV 请求
function request(cfg, method, remotePath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    let base;
    try { base = new URL(cfg.url); } catch (e) { return reject(new Error('服务器地址格式不正确')); }
    // 拼接路径（base 路径 + remotePath）
    const basePath = base.pathname.replace(/\/+$/, '');
    const full = basePath + '/' + String(remotePath).replace(/^\/+/, '');
    const isHttps = base.protocol === 'https:';
    const lib = isHttps ? https : http;
    const auth = 'Basic ' + Buffer.from(cfg.account + ':' + cfg.password).toString('base64');
    const headers = Object.assign({
      'Authorization': auth,
      'User-Agent': 'MatterVibe-Sync'
    }, extraHeaders || {});
    if (body != null) headers['Content-Length'] = Buffer.byteLength(body);

    const req = lib.request({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || (isHttps ? 443 : 80),
      path: encodeURI(full),
      method,
      headers,
      timeout: 20000
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('连接超时：请检查网络或服务器地址')); });
    req.on('error', (e) => reject(new Error('网络错误：' + (e && e.message ? e.message : e))));
    if (body != null) req.write(body);
    req.end();
  });
}

// 友好地把 HTTP 状态码翻成中文错误
function statusError(status, ctx) {
  if (status === 401) return new Error('认证失败：账户或应用密码不正确（注意：坚果云需用“应用密码”，不是登录密码）');
  if (status === 403) return new Error('没有权限访问该目录');
  if (status === 404) return new Error(ctx + '：路径不存在');
  if (status === 507) return new Error('云端空间不足');
  return new Error(ctx + '：服务器返回状态 ' + status);
}

// 确保远端目录存在（MKCOL，已存在则忽略）
async function ensureDir(cfg, dir) {
  const r = await request(cfg, 'MKCOL', dir + '/', null);
  // 201 创建成功；405/301 表示已存在；都算 OK
  if (r.status === 201 || r.status === 405 || r.status === 301 || r.status === 200) return true;
  if (r.status === 401) throw statusError(401, '创建目录');
  // 某些服务器对已存在目录返回其他码，宽容处理
  return true;
}

// 上传文件（PUT，覆盖）
async function putFile(cfg, remotePath, content) {
  const r = await request(cfg, 'PUT', remotePath, content, { 'Content-Type': 'application/octet-stream' });
  if (r.status === 200 || r.status === 201 || r.status === 204) return true;
  throw statusError(r.status, '上传');
}

// 下载文件（GET）；404 返回 null（文件还不存在）
async function getFile(cfg, remotePath) {
  const r = await request(cfg, 'GET', remotePath, null);
  if (r.status === 200) return r.body;
  if (r.status === 404) return null;
  throw statusError(r.status, '下载');
}

// 列目录下的文件名（PROPFIND，Depth:1），返回文件名数组
async function listDir(cfg, dir) {
  const r = await request(cfg, 'PROPFIND', dir + '/', null, { 'Depth': '1', 'Content-Type': 'application/xml' });
  if (r.status === 404) return [];
  if (r.status !== 207 && r.status !== 200) throw statusError(r.status, '列目录');
  // 简单解析 <d:href> 里的文件名（不引 XML 库）
  const names = [];
  const re = /<[a-zA-Z]*:?href>([^<]+)<\/[a-zA-Z]*:?href>/g;
  let m;
  while ((m = re.exec(r.body)) !== null) {
    let href = decodeURIComponent(m[1]);
    href = href.replace(/\/+$/, '');
    const name = href.split('/').pop();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// 测试连接：确保目录可访问（用于配置时的“测试连接”按钮）
async function testConnection(cfg, dir) {
  await ensureDir(cfg, dir);
  await listDir(cfg, dir);
  return true;
}

module.exports = { ensureDir, putFile, getFile, listDir, testConnection };
