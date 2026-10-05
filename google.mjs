import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// Google OAuth tokens are used only for this exchange; our own sessions remain authoritative.
export function createGoogleOAuth({ origin, secure }) {
  const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const enabled = !!(clientId && clientSecret);
  if ((clientId || clientSecret) && !enabled) throw new Error('请完整配置 Google Client ID 和 Secret');
  if (enabled && (!process.env.PUBLIC_ORIGIN || (!secure && process.env.NODE_ENV !== 'test'))) throw new Error('Google 登录需要 HTTPS PUBLIC_ORIGIN');
  const testOrigin = process.env.NODE_ENV === 'test' ? process.env.GOOGLE_OAUTH_TEST_ORIGIN : '';
  if (testOrigin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(testOrigin)) throw new Error('测试 Google OAuth 服务必须在本机');
  const discoveryURL = testOrigin ? `${testOrigin}/.well-known/openid-configuration` : 'https://accounts.google.com/.well-known/openid-configuration';
  const callback = `${origin}/api/auth/google/callback`;
  let cached, expiresAt = 0, loading;
  function endpoint(value, hostname) {
    const url = new URL(value);
    if (url.username || url.password || url.hash || (testOrigin ? url.origin !== testOrigin : url.protocol !== 'https:' || url.hostname !== hostname || url.port)) throw new Error('Google OAuth 服务地址无效');
    return url;
  }
  async function discovery() {
    if (cached && expiresAt > Date.now()) return cached;
    if (!loading) loading = (async () => {
      const r = await fetch(discoveryURL, { signal: AbortSignal.timeout(7000) });
      if (!r.ok) throw new Error('Google 登录服务暂时不可用');
      const d = await r.json();
      if (d.issuer !== 'https://accounts.google.com') throw new Error('Google OAuth 签发者无效');
      const authorization = endpoint(d.authorization_endpoint, 'accounts.google.com');
      const token = endpoint(d.token_endpoint, 'oauth2.googleapis.com');
      const jwks = endpoint(d.jwks_uri, 'www.googleapis.com');
      cached = { authorization, token, keys: createRemoteJWKSet(jwks, { timeoutDuration: 7000 }) };
      const ttl = Number(r.headers.get('cache-control')?.match(/\bmax-age=(\d+)/)?.[1] || 300);
      expiresAt = Date.now() + Math.min(ttl, 3600) * 1000;
      return cached;
    })().finally(() => { loading = undefined; });
    return loading;
  }
  async function authorizationURL({ state, verifier, nonce }) {
    const d = await discovery(), url = new URL(d.authorization);
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code', scope: 'openid profile', state, nonce, prompt: 'select_account', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return url.href;
  }
  async function verify(code, { verifier, nonce }) {
    const d = await discovery();
    const r = await fetch(d.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callback, grant_type: 'authorization_code', code_verifier: verifier }), signal: AbortSignal.timeout(7000) });
    const tokens = await r.json();
    if (!r.ok || typeof tokens.id_token !== 'string') throw new Error('Google 登录失败');
    const { payload: p } = await jwtVerify(tokens.id_token, d.keys, { algorithms: ['RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: clientId, requiredClaims: ['sub', 'iat', 'exp', 'nonce'], maxTokenAge: '10m', clockTolerance: 5 });
    if (p.nonce !== nonce || typeof p.sub !== 'string' || !p.sub || p.sub.length > 255 || (p.azp !== undefined && p.azp !== clientId) || (Array.isArray(p.aud) && p.aud.length > 1 && p.azp !== clientId)) throw new Error('Google 登录身份验证失败');
    let avatar = '';
    if (typeof p.picture === 'string' && p.picture.length <= 2000) {
      try { const u = new URL(p.picture); if (u.protocol === 'https:' && !u.username && !u.password && (u.hostname === 'googleusercontent.com' || u.hostname.endsWith('.googleusercontent.com'))) avatar = u.href; } catch {}
    }
    return { subject: p.sub, name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 40) : 'Google 用户', avatar };
  }
  return { enabled, authorizationURL, verify };
}
