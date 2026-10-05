import { randomBytes, randomInt, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { createGoogleOAuth } from './google.mjs';
import { validPassword, hashPassword, verifyPassword } from './passwords.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const id = () => randomBytes(16).toString('hex');
const equal = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export class AuthError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new AuthError(status, message); };
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : fail(400, '请输入有效内容');
const cookieValue = (req, name) => (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1) || '';
const returnTo = value => value === '/f1?settings=1' ? value : '/';

function verificationEmail(code, mode) {
  const action = mode === 'link' ? '绑定邮箱' : mode === 'reauth' ? '验证身份' : '登录';
  return `<!doctype html><html lang="zh-CN"><body style="margin:0;background:#f6f8fa;font-family:Arial,sans-serif;color:#24292f"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px"><table role="presentation" width="100%" style="max-width:560px;background:#fff;border:1px solid #d0d7de;border-radius:12px" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:36px 24px"><p style="font-size:18px;font-weight:bold;margin:0 0 24px">F1 围场</p><h1 style="font-size:26px;margin:0 0 28px">确认是你本人</h1><table role="presentation" width="100%" style="border:1px solid #d0d7de;border-radius:8px"><tr><td align="center" style="padding:24px 12px"><p style="margin:0 0 20px">使用以下验证码完成${action}</p><p style="font-family:monospace;font-size:36px;letter-spacing:8px;margin:0 0 24px">${code}</p><p style="line-height:1.7;margin:0">验证码 <strong>10 分钟</strong>内有效，仅可使用一次。</p><p style="line-height:1.7;margin:18px 0 0"><strong>请勿向任何人分享验证码。</strong><br>我们不会通过电话或邮件索取验证码。</p></td></tr></table><p style="font-size:14px;line-height:1.8;color:#57606a;margin:28px 0 0">你收到这封邮件，是因为有人请求${action}。<br>如果不是你本人操作，请忽略此邮件。</p></td></tr></table><p style="font-size:12px;color:#6e7781">F1 围场</p></td></tr></table></body></html>`;
}

export function createAuth({ db, dataDir, origin, secure, adminKey, send, jsonBody }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '', role TEXT NOT NULL CHECK(role IN ('admin','member')), created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS single_owner ON users(role) WHERE role='admin';
    CREATE TABLE IF NOT EXISTS identities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL, subject TEXT NOT NULL, UNIQUE(provider,subject));
    CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS passwords (user_id TEXT PRIMARY KEY REFERENCES users(id), digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, verified_at INTEGER NOT NULL, method TEXT NOT NULL, remembered INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_requests (id TEXT PRIMARY KEY, kind TEXT NOT NULL, browser_hash TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT OR IGNORE INTO users VALUES ('owner','管理员','','admin',?)").run(Date.now());
  const secretFile = join(dataDir, 'auth-secret.txt');
  if (!process.env.AUTH_SECRET && !existsSync(secretFile)) writeFileSync(secretFile, token(), { mode: 0o600, flag: 'wx' });
  const secret = process.env.AUTH_SECRET || readFileSync(secretFile, 'utf8').trim();
  if (secret.length < 32) throw new Error('AUTH_SECRET 至少需要 32 字符');
  const mac = value => createHmac('sha256', secret).update(value).digest('hex');
  const github = { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET, adminId: process.env.GITHUB_ADMIN_ID };
  const githubEnabled = !!(github.clientId && github.clientSecret);
  const google = createGoogleOAuth({ origin, secure });
  if ((github.clientId || github.clientSecret) && !githubEnabled) throw new Error('请完整配置 GitHub Client ID 和 Secret');
  if (github.adminId && !/^\d+$/.test(github.adminId)) throw new Error('GITHUB_ADMIN_ID 必须是数字 ID');
  if (githubEnabled && (!process.env.PUBLIC_ORIGIN || (!secure && process.env.NODE_ENV !== 'test'))) throw new Error('GitHub 登录需要 HTTPS PUBLIC_ORIGIN');
  if (github.adminId) {
    const previous = db.prepare("SELECT * FROM identities WHERE provider='github' AND subject=?").get(github.adminId);
    if (previous && previous.user_id !== 'owner') throw new Error('站主 GitHub 身份已属于其他账号，拒绝自动合并');
    db.prepare("INSERT OR IGNORE INTO identities VALUES (?, 'owner','github',?)").run(id(), github.adminId);
  }
  const testOrigin = process.env.NODE_ENV === 'test' ? process.env.GITHUB_OAUTH_TEST_ORIGIN : '';
  if (testOrigin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(testOrigin)) throw new Error('测试 OAuth 服务必须在本机');
  const githubSite = testOrigin || 'https://github.com', githubApi = testOrigin || 'https://api.github.com';
  const emailEnabled = !!(process.env.SMTP_HOST && process.env.MAIL_FROM);
  const mailer = emailEnabled ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', requireTLS: process.env.NODE_ENV !== 'test' && process.env.SMTP_SECURE !== 'true', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined, connectionTimeout: 10000, socketTimeout: 15000, logger: false, debug: false }) : null;
  const rpID = new URL(origin).hostname;
  const passkeyEnabled = secure || rpID === 'localhost';
  const cookie = (name, value, age) => `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const user = uid => db.prepare('SELECT id,name,avatar,role FROM users WHERE id=?').get(uid);
  function rate(key, max, ms) {
    const k = mac(key), now = Date.now();
    db.prepare('INSERT INTO auth_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN until_at<=? THEN 1 ELSE count+1 END, until_at=CASE WHEN until_at<=? THEN excluded.until_at ELSE until_at END').run(k, now + ms, now, now);
    if (db.prepare('SELECT count FROM auth_limits WHERE key=?').get(k).count > max) fail(429, '操作太频繁，请稍后再试');
  }
  function auth(req) {
    const raw = cookieValue(req, 'paddock_session');
    if (!raw) return null;
    const s = db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(raw), Date.now());
    return s ? { ...s, user: user(s.user_id) } : null;
  }
  function requireUser(req) {
    const s = auth(req); if (!s) fail(401, '请先登录');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== s.csrf) fail(403, '验证已失效，请刷新后重试');
    return s;
  }
  function requireAdmin(req) { const s = requireUser(req); if (s.user.role !== 'admin') fail(403, '只有站主可以管理空间'); return s; }
  function fresh(req) { const s = requireUser(req); if (s.verified_at < Date.now() - 300000) fail(428, '请先重新验证身份，再管理登录方式'); return s; }
  function newSession(req, res, uid, remembered, method) {
    const old = auth(req); if (old) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(old.token_hash);
    const raw = token(), csrf = token(), age = remembered ? 30 * 86400 : 43200;
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run(hash(raw), uid, csrf, Date.now() + age * 1000, Date.now(), method, remembered ? 1 : 0);
    res.setHeader('Set-Cookie', cookie('paddock_session', raw, age));
    return { authenticated: true, csrf, user: user(uid) };
  }
  function flow(req, res, kind, payload, ms = 300000) {
    let browser = cookieValue(req, 'paddock_auth');
    if (!/^[\w-]{43}$/.test(browser)) browser = token();
    res.setHeader('Set-Cookie', cookie('paddock_auth', browser, 1200));
    const raw = token(); db.prepare('INSERT INTO auth_requests(id,kind,browser_hash,payload,expires_at) VALUES (?,?,?,?,?)').run(hash(raw), kind, hash(browser), JSON.stringify(payload), Date.now() + ms);
    return raw;
  }
  function pending(req, raw, kind, consume = true) {
    if (typeof raw !== 'string') fail(400, '验证请求无效或已过期');
    const row = db.prepare('SELECT * FROM auth_requests WHERE id=? AND kind=?').get(hash(raw), kind);
    if (!row || row.expires_at <= Date.now() || row.browser_hash !== hash(cookieValue(req, 'paddock_auth'))) fail(400, '验证请求无效或已过期');
    if (consume) db.prepare('DELETE FROM auth_requests WHERE id=?').run(row.id);
    return { ...row, data: JSON.parse(row.payload) };
  }
  function intent(req, body) {
    const mode = body.intent || 'login';
    if (!['login', 'link', 'reauth'].includes(mode)) fail(400, '无效的登录操作');
    const s = mode === 'link' ? fresh(req) : mode === 'reauth' ? requireUser(req) : null;
    return { mode, session: s?.token_hash, uid: s?.user_id, remember: s ? !!s.remembered : body.remember === true, returnTo: returnTo(body.returnTo) };
  }
  function checkIntent(req, p) {
    if (p.mode === 'login') return;
    const s = p.mode === 'link' ? fresh(req) : requireUser(req);
    if (s.token_hash !== p.session || s.user_id !== p.uid) fail(403, '账号状态已改变，请重新开始');
  }
  function identityResult(req, res, p, provider, subject, profile) {
    checkIntent(req, p);
    const existing = db.prepare('SELECT * FROM identities WHERE provider=? AND subject=?').get(provider, subject);
    if (p.mode === 'link') {
      if (existing && existing.user_id !== p.uid) fail(409, '该登录方式已绑定其他账号，不能自动合并');
      if (!existing) db.prepare('INSERT INTO identities VALUES (?,?,?,?)').run(id(), p.uid, provider, subject);
      return { ok: true, linked: true };
    }
    if (p.mode === 'reauth' && (!existing || existing.user_id !== p.uid)) fail(403, '请使用当前账号已绑定的登录方式验证');
    let uid = existing?.user_id;
    if (!uid) {
      uid = id();
      db.exec('BEGIN IMMEDIATE');
      try { db.prepare("INSERT INTO users VALUES (?,?,?,'member',?)").run(uid, profile.name, profile.avatar || '', Date.now()); db.prepare('INSERT INTO identities VALUES (?,?,?,?)').run(id(), uid, provider, subject); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    return newSession(req, res, uid, p.remember, provider);
  }
  function account(s) {
    return { user: s.user, passwordSet: !!db.prepare('SELECT user_id FROM passwords WHERE user_id=?').get(s.user_id), passwordNeedsCurrent: s.method === 'password', recentVerification: s.verified_at >= Date.now() - 300000, identities: db.prepare('SELECT id,provider,subject FROM identities WHERE user_id=?').all(s.user_id), passkeys: db.prepare('SELECT id,name,created_at FROM passkeys WHERE user_id=?').all(s.user_id) };
  }
  function cleanup() { const now = Date.now(); for (const [table, field] of [['sessions', 'expires_at'], ['auth_requests', 'expires_at'], ['auth_limits', 'until_at']]) db.prepare(`DELETE FROM ${table} WHERE ${field}<=?`).run(now); }
  function ensureRemaining(s) {
    const count = db.prepare(`SELECT (SELECT count(*) FROM identities WHERE user_id=? AND ((provider='github' AND ?=1) OR (provider='email' AND ?=1) OR (provider='google' AND ?=1))) + (SELECT count(*) FROM passkeys WHERE user_id=? AND ?=1) AS n`).get(s.user_id, Number(githubEnabled), Number(emailEnabled), Number(google.enabled), s.user_id, Number(passkeyEnabled)).n;
    if (s.user.role !== 'admin' && count <= 1) fail(409, '请先添加另一种登录方式');
  }
  async function githubStart(req, res, body, ip) {
    if (!githubEnabled) fail(404, 'GitHub 登录尚未配置');
    rate(`github:${ip}`, 20, 900000);
    const p = intent(req, body), verifier = token();
    const state = flow(req, res, 'github', { ...p, verifier });
    const params = new URLSearchParams({ client_id: github.clientId, redirect_uri: `${origin}/api/auth/github/callback`, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    return `${githubSite}/login/oauth/authorize?${params}`;
  }
  async function handle(req, res, u, ip) {
    const path = u.pathname, method = req.method;
    if (path === '/api/session' && method === 'GET') { const s = auth(req); send(res, 200, { authenticated: !!s, csrf: s?.csrf, user: s?.user || null, githubEnabled, googleEnabled: google.enabled, methods: { github: githubEnabled, google: google.enabled, email: emailEnabled, password: secure || ['localhost', '127.0.0.1'].includes(rpID), passkey: passkeyEnabled } }); return true; }
    if (path === '/api/auth/password/login' && method === 'POST') {
      if (!secure && !['localhost', '127.0.0.1'].includes(rpID)) fail(403, '密码登录需要 HTTPS');
      rate(`password-ip:${ip}`, 20, 900000);
      const b = await jsonBody(req), email = text(b.email, 254).toLowerCase();
      rate(`password-email:${email}`, 10, 900000);
      if (typeof b.password !== 'string' || Buffer.byteLength(b.password) > 512) fail(401, '邮箱或密码不正确');
      const p = intent(req, b);
      if (p.mode === 'link') fail(400, '请在账号设置中设置密码');
      const row = db.prepare("SELECT p.user_id,p.digest FROM passwords p JOIN identities i ON i.user_id=p.user_id WHERE i.provider='email' AND i.subject=?").get(email);
      const verified = await verifyPassword(b.password, row?.digest);
      if (!verified || !row || db.prepare("SELECT p.digest FROM passwords p JOIN identities i ON i.user_id=p.user_id WHERE i.provider='email' AND i.subject=?").get(email)?.digest !== row.digest) fail(401, '邮箱或密码不正确');
      checkIntent(req, p);
      if (p.mode === 'reauth' && row.user_id !== p.uid) fail(403, '请使用当前账号已绑定的登录方式验证');
      send(res, 200, newSession(req, res, row.user_id, p.remember, 'password')); return true;
    }
    if (path === '/api/account/password' && method === 'PUT') {
      if (!secure && !['localhost', '127.0.0.1'].includes(rpID)) fail(403, '设置密码需要 HTTPS');
      const s = fresh(req);
      rate(`password-change:${s.user_id}`, 10, 900000);
      const b = await jsonBody(req);
      if (!validPassword(b.password)) fail(400, '请使用 15–128 个字符的密码，避免常见密码或重复单个字符');
      if (!db.prepare("SELECT id FROM identities WHERE user_id=? AND provider='email'").get(s.user_id)) fail(409, '请先绑定并验证邮箱，再设置密码');
      const previous = db.prepare('SELECT digest FROM passwords WHERE user_id=?').get(s.user_id)?.digest;
      if (previous && s.method === 'password') {
        if (typeof b.currentPassword !== 'string' || Buffer.byteLength(b.currentPassword) > 512 || !await verifyPassword(b.currentPassword, previous)) fail(403, '当前密码不正确；忘记密码可使用邮箱验证码重新验证');
      }
      const digest = await hashPassword(b.password);
      // Hashing yields: recheck session and credential before committing to avoid races.
      const current = fresh(req);
      if (current.token_hash !== s.token_hash || db.prepare('SELECT digest FROM passwords WHERE user_id=?').get(s.user_id)?.digest !== previous) fail(409, '账号状态已改变，请重新开始');
      if (!db.prepare("SELECT id FROM identities WHERE user_id=? AND provider='email'").get(s.user_id)) fail(409, '请先绑定邮箱');
      db.prepare('INSERT INTO passwords VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET digest=excluded.digest').run(s.user_id, digest);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(s.user_id);
      const emails = db.prepare("SELECT subject FROM identities WHERE user_id=? AND provider='email'").all(s.user_id).map(i => i.subject);
      for (const row of db.prepare('SELECT id,payload FROM auth_requests').all()) {
        const p = JSON.parse(row.payload);
        if (p.uid === s.user_id || emails.includes(p.email)) db.prepare('DELETE FROM auth_requests WHERE id=?').run(row.id);
      }
      send(res, 200, newSession(req, res, s.user_id, !!s.remembered, 'password')); return true;
    }
    if (path === '/api/login' && method === 'POST') {
      rate(`key:${ip}`, 10, 900000); const b = await jsonBody(req);
      if (typeof b.key !== 'string' || !equal(b.key, adminKey)) fail(401, '管理员密钥不正确');
      if (b.intent === 'reauth' && requireUser(req).user_id !== 'owner') fail(403, '请验证当前账号');
      send(res, 200, newSession(req, res, 'owner', b.remember === true || (b.intent === 'reauth' && !!auth(req)?.remembered), 'recovery')); return true;
    }
    if (['/api/logout', '/api/logout-all'].includes(path) && method === 'POST') {
      const s = requireUser(req); db.prepare(path.endsWith('-all') ? 'DELETE FROM sessions WHERE user_id=?' : 'DELETE FROM sessions WHERE token_hash=?').run(path.endsWith('-all') ? s.user_id : s.token_hash);
      res.setHeader('Set-Cookie', cookie('paddock_session', '', 0)); send(res, 200, { ok: true }); return true;
    }
    if (path === '/api/account' && method === 'GET') { send(res, 200, account(requireUser(req))); return true; }
    if (path === '/api/account' && method === 'PATCH') { const s = requireUser(req), b = await jsonBody(req); db.prepare('UPDATE users SET name=? WHERE id=?').run(text(b.name, 40), s.user_id); send(res, 200, { ok: true }); return true; }
    if (path === '/api/account' && method === 'DELETE') {
      const s = fresh(req), b = await jsonBody(req);
      if (s.user.role === 'admin') fail(403, '站主账号不能注销，请在账号设置中管理登录方式');
      if (b.confirmation !== '注销账号') fail(400, '请输入“注销账号”确认此操作');
      db.exec('BEGIN IMMEDIATE');
      try {
        // Release identities only after revoking this account and its pending verification flows.
        const emails = new Set(db.prepare("SELECT subject FROM identities WHERE user_id=? AND provider='email'").all(s.user_id).map(i => i.subject));
        const sessionHashes = new Set(db.prepare('SELECT token_hash FROM sessions WHERE user_id=?').all(s.user_id).map(row => row.token_hash));
        for (const row of db.prepare('SELECT id,payload FROM auth_requests').all()) {
          const p = JSON.parse(row.payload);
          if (p.uid === s.user_id || sessionHashes.has(p.session) || emails.has(p.email)) db.prepare('DELETE FROM auth_requests WHERE id=?').run(row.id);
        }
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(s.user_id);
        db.prepare('DELETE FROM passkeys WHERE user_id=?').run(s.user_id);
        db.prepare('DELETE FROM passwords WHERE user_id=?').run(s.user_id);
        db.prepare('DELETE FROM identities WHERE user_id=?').run(s.user_id);
        db.prepare('DELETE FROM users WHERE id=?').run(s.user_id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      res.setHeader('Set-Cookie', [cookie('paddock_session', '', 0), cookie('paddock_auth', '', 0)]);
      send(res, 200, { ok: true }); return true;
    }
    if (path.startsWith('/api/account/identities/') && method === 'DELETE') {
      const s = fresh(req), ident = db.prepare('SELECT * FROM identities WHERE id=? AND user_id=?').get(path.split('/').pop(), s.user_id);
      if (!ident) fail(404, '登录方式不存在');
      if (ident.provider === 'github' && ident.subject === github.adminId) fail(409, '站主 GitHub 由服务器配置管理，请保留此恢复方式');
      ensureRemaining(s); db.prepare('DELETE FROM identities WHERE id=?').run(ident.id);
      if (ident.provider === 'email' && !db.prepare("SELECT id FROM identities WHERE user_id=? AND provider='email'").get(s.user_id)) { db.prepare('DELETE FROM passwords WHERE user_id=?').run(s.user_id); db.prepare("DELETE FROM sessions WHERE user_id=? AND method='password' AND token_hash<>?").run(s.user_id, s.token_hash); }
      send(res, 200, { ok: true }); return true;
    }
    if (path.startsWith('/api/account/passkeys/') && ['PATCH', 'DELETE'].includes(method)) {
      const s = fresh(req), key = db.prepare('SELECT id FROM passkeys WHERE id=? AND user_id=?').get(path.split('/').pop(), s.user_id);
      if (!key) fail(404, '通行密钥不存在');
      if (method === 'DELETE') { ensureRemaining(s); db.prepare('DELETE FROM passkeys WHERE id=?').run(key.id); }
      else { const b = await jsonBody(req); db.prepare('UPDATE passkeys SET name=? WHERE id=?').run(text(b.name, 60), key.id); }
      send(res, 200, { ok: true }); return true;
    }
    if (path === '/api/auth/google/start' && method === 'POST') {
      if (!google.enabled) fail(404, 'Google 登录尚未配置');
      rate(`google:${ip}`, 20, 900000);
      const p = intent(req, await jsonBody(req)), verifier = token(), nonce = token();
      const state = flow(req, res, 'google', { ...p, verifier, nonce });
      try { send(res, 200, { url: await google.authorizationURL({ state, verifier, nonce }) }); }
      catch { db.prepare('DELETE FROM auth_requests WHERE id=?').run(hash(state)); fail(503, 'Google 登录暂时不可用，请稍后重试'); }
      return true;
    }
    if (path === '/api/auth/google/callback' && method === 'GET') {
      let p, result = 'google-failed';
      try {
        if (!google.enabled) fail(404, 'Google 登录尚未配置');
        p = pending(req, u.searchParams.get('state'), 'google').data;
        if (u.searchParams.get('error') === 'access_denied') result = 'google-cancelled';
        else {
          const profile = await google.verify(text(u.searchParams.get('code'), 2000), p);
          identityResult(req, res, p, 'google', profile.subject, profile);
          result = p.mode === 'link' ? 'linked' : 'google';
        }
      } catch (e) { result = e.status === 409 ? 'conflict' : e.status === 428 ? 'reauth' : 'google-failed'; }
      const target = new URL(p?.returnTo || '/', origin); target.searchParams.set('auth', result);
      res.writeHead(303, { Location: target.pathname + target.search + target.hash, 'Cache-Control': 'no-store' }); res.end(); return true;
    }
    if (path === '/api/auth/github' && method === 'GET') { const url = await githubStart(req, res, { remember: u.searchParams.get('remember') === 'true', returnTo: u.searchParams.get('returnTo') }, ip); res.writeHead(303, { Location: url, 'Cache-Control': 'no-store' }); res.end(); return true; }
    if (path === '/api/auth/github/start' && method === 'POST') { send(res, 200, { url: await githubStart(req, res, await jsonBody(req), ip) }); return true; }
    if (path === '/api/auth/github/callback' && method === 'GET') {
      let p, result = 'failed';
      try {
        if (!githubEnabled) fail(404, 'GitHub 登录尚未配置');
        p = pending(req, u.searchParams.get('state'), 'github').data;
        const code = text(u.searchParams.get('code'), 2000);
        const r = await fetch(`${githubSite}/login/oauth/access_token`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'paddock-blog' }, body: new URLSearchParams({ client_id: github.clientId, client_secret: github.clientSecret, code, redirect_uri: `${origin}/api/auth/github/callback`, code_verifier: p.verifier }), signal: AbortSignal.timeout(7000) });
        const t = await r.json(); if (!r.ok || typeof t.access_token !== 'string' || !t.access_token) fail(400, 'GitHub 登录失败');
        const response = await fetch(`${githubApi}/user`, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'paddock-blog' }, signal: AbortSignal.timeout(7000) });
        const profile = await response.json(); if (!response.ok || !Number.isSafeInteger(profile.id)) fail(400, 'GitHub 账号无效');
        // OAuth callbacks are cross-site GETs; state + browser binding supplies CSRF protection.
        identityResult(req, res, p, 'github', String(profile.id), { name: String(profile.login || 'GitHub 用户').slice(0, 40), avatar: /^https:\/\/avatars\.githubusercontent\.com\//.test(profile.avatar_url || '') ? profile.avatar_url : '' });
        result = p.mode === 'link' ? 'linked' : 'github';
      } catch (e) { result = e.status === 409 ? 'conflict' : e.status === 428 ? 'reauth' : 'failed'; }
      const target = new URL(p?.returnTo || '/', origin); target.searchParams.set('auth', result);
      res.writeHead(303, { Location: target.pathname + target.search + target.hash, 'Cache-Control': 'no-store' }); res.end(); return true;
    }
    if (path === '/api/auth/email/request' && method === 'POST') {
      if (!emailEnabled) fail(404, '邮箱登录尚未配置');
      const b = await jsonBody(req), email = text(b.email, 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, '请输入有效邮箱');
      const p = intent(req, b);
      rate(`mail-ip:${ip}`, 20, 3600000); rate(`mail-address:${email}`, 5, 3600000); rate(`mail-cooldown:${email}`, 1, 60000);
      const code = String(randomInt(0, 1000000)).padStart(6, '0'), nonce = token();
      const requestId = flow(req, res, 'email', { ...p, email, nonce, codeHash: mac(nonce + ':' + code) }, 600000);
      try { await mailer.sendMail({ from: process.env.MAIL_FROM, to: email, subject: 'paddock · 你的登录验证码', text: `确认你的身份 · paddock\n\n你的验证码是 ${code}\n\n验证码 10 分钟内有效，仅可使用一次。\n请勿向任何人分享验证码，我们不会通过电话或邮件索取验证码。\n若不是你本人操作，请忽略此邮件。`, html: verificationEmail(code, p.mode) }); }
      catch { db.prepare('DELETE FROM auth_requests WHERE id=?').run(hash(requestId)); fail(503, '邮件暂时无法发送，请稍后重试或使用其他登录方式'); }
      send(res, 200, { requestId, expiresIn: 600, retryAfter: 60 }); return true;
    }
    if (path === '/api/auth/email/verify' && method === 'POST') {
      if (!emailEnabled) fail(404, '邮箱登录尚未配置');
      rate(`mail-verify:${ip}`, 50, 600000);
      const b = await jsonBody(req), row = pending(req, b.requestId, 'email', false), p = row.data;
      if (row.attempts >= 5) fail(429, '验证码尝试次数已用完，请重新获取');
      db.prepare('UPDATE auth_requests SET attempts=attempts+1 WHERE id=?').run(row.id);
      if (typeof b.code !== 'string' || !/^\d{6}$/.test(b.code) || !equal(mac(p.nonce + ':' + b.code), p.codeHash)) fail(400, '验证码不正确');
      db.prepare('DELETE FROM auth_requests WHERE id=?').run(row.id);
      send(res, 200, identityResult(req, res, p, 'email', p.email, { name: '访客' })); return true;
    }
    if (path.startsWith('/api/auth/passkey/') && method === 'POST') {
      if (!passkeyEnabled) fail(404, '此环境不支持通行密钥');
      rate(`passkey:${ip}`, 60, 600000); const b = await jsonBody(req);
      if (path.endsWith('/register/options')) {
        const s = fresh(req), keys = db.prepare('SELECT id,transports FROM passkeys WHERE user_id=?').all(s.user_id);
        if (keys.length >= 20) fail(400, '最多保存 20 个通行密钥');
        const options = await generateRegistrationOptions({ rpName: 'F1 围场', rpID, userID: new TextEncoder().encode(s.user_id), userName: s.user.name + ' · ' + s.user_id.slice(0, 8), userDisplayName: s.user.name, attestationType: 'none', excludeCredentials: keys.map(k => ({ id: k.id, transports: JSON.parse(k.transports) })), authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
        const requestId = flow(req, res, 'register', { uid: s.user_id, session: s.token_hash, challenge: options.challenge, name: text(b.name || '我的通行密钥', 60) });
        send(res, 200, { options, requestId }); return true;
      }
      if (path.endsWith('/register/verify')) {
        const s = fresh(req), p = pending(req, b.requestId, 'register').data;
        if (p.uid !== s.user_id || p.session !== s.token_hash) fail(403, '账号状态已改变');
        let verification;
        try { verification = await verifyRegistrationResponse({ response: b.response, expectedChallenge: p.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }); } catch { fail(400, '通行密钥验证失败，请重新操作'); }
        if (!verification.verified || !verification.registrationInfo) fail(400, '通行密钥验证失败');
        const current = fresh(req);
        if (current.token_hash !== p.session) fail(403, '账号状态已改变');
        const credential = verification.registrationInfo.credential;
        if (db.prepare('SELECT id FROM passkeys WHERE id=?').get(credential.id)) fail(409, '通行密钥已绑定');
        db.prepare('INSERT INTO passkeys VALUES (?,?,?,?,?,?,?)').run(credential.id, s.user_id, p.name, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports || []), Date.now());
        send(res, 200, { ok: true }); return true;
      }
      if (path.endsWith('/login/options')) {
        const p = intent(req, b); if (p.mode === 'link') fail(400, '请从账号设置添加通行密钥');
        const keys = p.uid ? db.prepare('SELECT id,transports FROM passkeys WHERE user_id=?').all(p.uid) : [];
        const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', ...(p.uid ? { allowCredentials: keys.map(k => ({ id: k.id, transports: JSON.parse(k.transports) })) } : {}) });
        send(res, 200, { options, requestId: flow(req, res, 'passkey', { ...p, challenge: options.challenge }) }); return true;
      }
      if (path.endsWith('/login/verify')) {
        const p = pending(req, b.requestId, 'passkey').data; checkIntent(req, p);
        const key = typeof b.response?.id === 'string' ? db.prepare('SELECT * FROM passkeys WHERE id=?').get(b.response.id) : null;
        if (!key || (p.uid && key.user_id !== p.uid)) fail(400, '通行密钥验证失败');
        let verification;
        try { verification = await verifyAuthenticationResponse({ response: b.response, expectedChallenge: p.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true, credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter, transports: JSON.parse(key.transports) } }); } catch { fail(400, '通行密钥验证失败，请重试'); }
        if (!verification.verified) fail(400, '通行密钥验证失败');
        checkIntent(req, p);
        if (!db.prepare('SELECT id FROM passkeys WHERE id=? AND user_id=?').get(key.id, key.user_id)) fail(400, '通行密钥已移除');
        db.prepare('UPDATE passkeys SET counter=? WHERE id=?').run(verification.authenticationInfo.newCounter, key.id);
        send(res, 200, newSession(req, res, key.user_id, p.remember, 'passkey')); return true;
      }
    }
    return false;
  }
  return { handle, auth, requireUser, requireAdmin, rate, cleanup };
}
