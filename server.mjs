import http from 'node:http';
import { isIP } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.mjs';
import { createF1Handler, createF1Service } from './f1.mjs';
import { createF1Preferences } from './f1-preferences.mjs';
import { createF1Subscriptions } from './f1-subscriptions.mjs';
process.umask(0o077);
const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
mkdirSync(DATA, { recursive: true, mode: 0o700 });
const f1Service = createF1Service({ dataDir: DATA });
const handleF1 = createF1Handler({ dataDir: DATA, publicDir: join(ROOT, 'public'), service:f1Service });
let adminKey = process.env.ADMIN_KEY;
if (!adminKey) {
  const keyFile = join(DATA, 'admin-key.txt');
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(24).toString('base64url'), { mode: 0o600 });
  adminKey = readFileSync(keyFile, 'utf8').trim();
}
if (adminKey.length < 16) throw new Error('ADMIN_KEY 至少需要 16 个字符');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4321);
const ORIGIN = (process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE = process.env.COOKIE_SECURE === 'true' || ORIGIN.startsWith('https://');
const db = new DatabaseSync(join(DATA, 'paddock.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
class ApiError extends Error {constructor(status,message){super(message);this.status=status;}}
const accounts=createAuth({db,dataDir:DATA,origin:ORIGIN,secure:SECURE,adminKey,send,jsonBody});
const {requireUser}=accounts;
const handleF1Preferences=createF1Preferences({db,requireUser,jsonBody,send});
const f1Subscriptions=createF1Subscriptions({db,requireUser,jsonBody,send,service:f1Service,origin:ORIGIN});
async function jsonBody(req){const chunks=[];let n=0;for await (const chunk of req){n+=chunk.length;if(n>524288)throw new ApiError(413,'内容过大');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError(400,'请求格式不正确');}}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function route(req,res){
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' https:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  const u=new URL(req.url,'http://localhost');const p=u.pathname;const method=req.method;
  const peer=req.socket.remoteAddress||'unknown';
  const trusted=(process.env.TRUST_PROXY_IPS||'').split(',').map(s=>s.trim());
  // Cloudflare overwrites these headers. Only act on them through our local Tunnel.
  const realIP=process.env.CLOUDFLARE_TUNNEL === 'true' ? req.headers['cf-connecting-ip'] : req.headers['x-real-ip'];
  const tunnelRequest=process.env.CLOUDFLARE_TUNNEL === 'true'&&trusted.includes(peer)&&typeof realIP==='string'&&!!isIP(realIP);
  if(tunnelRequest&&req.headers['x-forwarded-proto']==='http'){
    res.writeHead(308,{'Location':new URL(req.url,ORIGIN.replace(/^http:/,'https:')).toString(),'Cache-Control':'no-store'});
    return res.end();
  }
  if(!['GET','HEAD'].includes(method)){
    const origin=req.headers.origin;
    const allowed=new Set([ORIGIN]);if(!process.env.PUBLIC_ORIGIN){allowed.add(`http://127.0.0.1:${PORT}`);}
    if(!origin||!allowed.has(origin))throw new ApiError(403,'请求来源不受信任');
    if(req.headers['sec-fetch-site']==='cross-site')throw new ApiError(403,'跨站请求被拒绝');
  }
  const ip=trusted.includes(peer)&&typeof realIP==='string'&&isIP(realIP)?realIP:peer;
  if(await accounts.handle(req,res,u,ip))return;
  if(await handleF1Preferences(req,res,u))return;
  if(await f1Subscriptions.handle(req,res,u))return;
  if(await handleF1(req,res))return;
  if (!['GET','HEAD'].includes(method)) throw new ApiError(405,'不支持的操作');
  const files={'/':'f1.html','/index.html':'f1.html','/style.css':'style.css','/favicon.svg':'favicon.svg','/vendor/simplewebauthn.js':'vendor/simplewebauthn.js'};
  const file=files[p];
  if(!file) throw new ApiError(404,'页面不存在');
  const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
  res.writeHead(200,{'Content-Type':types[extname(file)],'Cache-Control':file.endsWith('.html')?'no-cache':'public, max-age=300'});
  res.end(method==='HEAD'?undefined:readFileSync(join(ROOT,'public',file)));
}
setInterval(()=>accounts.cleanup(),60000).unref();
const server=http.createServer((req,res)=>{route(req,res).catch(e=>{if(!e.status)console.error(e);if(!res.headersSent&&!res.destroyed)send(res,e.status||500,{error:e.status?e.message:'服务器暂时遇到问题，请稍后重试'});else if(!res.destroyed)res.destroy();});});
server.requestTimeout=120000;server.headersTimeout=15000;
server.listen(PORT,HOST,()=>{console.log(`F1 Paddock → http://${HOST==='0.0.0.0'?'localhost':HOST}:${PORT}`);console.log('管理员密钥：使用 ADMIN_KEY 环境变量，或查看 DATA_DIR/admin-key.txt。');});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
