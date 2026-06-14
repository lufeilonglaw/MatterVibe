'use strict';
/* ============================================================
   MatterVibe 同步加密模块（端到端加密）
   - 用用户口令通过 PBKDF2 派生密钥
   - AES-256-GCM 加密（带认证标签，防篡改）
   - 加密产物为自包含 JSON：含盐、IV、认证标签、密文
   口令永不出本机、永不上传；云端只存下面 encrypt() 的产物。
   仅依赖 Node 内置 crypto，无第三方依赖。
   ============================================================ */
const crypto = require('crypto');

const PBKDF2_ITERATIONS = 200000; // 迭代次数，抗暴力破解
const SALT_LEN = 16;
const IV_LEN = 12;             // GCM 推荐 12 字节
const KEY_LEN = 32;            // AES-256
const MAGIC = 'MVENC1';        // 格式标识

// 用口令 + 盐派生密钥
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
}

// 加密：明文字符串 → 自包含密文对象（可 JSON.stringify 后上传）
function encrypt(plaintext, password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    magic: MAGIC,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64')
  };
}

// 解密：密文对象 + 口令 → 明文字符串；口令错或数据被篡改会抛错
function decrypt(payload, password) {
  if (!payload || payload.magic !== MAGIC) {
    throw new Error('不是有效的加密数据');
  }
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    // GCM 认证失败 = 口令错误或数据损坏
    throw new Error('解密失败：加密口令不正确，或云端数据已损坏');
  }
}

// 生成一个"口令校验串"：用口令加密一段固定文本，存到云端。
// 换设备时用它验证用户输入的口令是否正确（不必下载全部数据）。
const VERIFY_TEXT = 'mattervibe-passphrase-check';
function makeVerifier(password) {
  return encrypt(VERIFY_TEXT, password);
}
function checkVerifier(verifier, password) {
  try {
    return decrypt(verifier, password) === VERIFY_TEXT;
  } catch (e) {
    return false;
  }
}

module.exports = { encrypt, decrypt, makeVerifier, checkVerifier };
