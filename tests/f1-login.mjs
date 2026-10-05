import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {chromium} from '@playwright/test';
const server=http.createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  const asset=path==='/'?'f1.html':path.slice(1);
  if(!['f1.html','f1.js','f1-account.js','f1.css','style.css','favicon.svg'].includes(asset)){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',asset.endsWith('.js')?'application/javascript':asset.endsWith('.css')?'text/css':'text/html');
  res.end(readFileSync(new URL('../public/'+asset,import.meta.url)));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();let authenticated=false;
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/session',r=>r.fulfill({json:{authenticated,csrf:authenticated?'test-csrf':null,user:authenticated?{id:'member',name:'Test member'}:null,methods:{password:true,email:true}}}));
  await page.route('**/api/f1/**',r=>r.fulfill({json:{season:2026,schedule:{data:[]},winners:{data:[]},drivers:{data:{}},constructors:{data:{}}}}));
  await page.route('**/api/account/f1-preferences',r=>r.fulfill({json:{driverId:null,constructorId:null}}));
  await page.route('**/api/account/f1-subscription',r=>r.fulfill({json:{enabled:false,emails:[],kinds:['race'],available:false}}));
  await page.route('**/api/auth/email/request',r=>{const b=r.request().postDataJSON();assert.equal(b.email,'fan@example.test');assert.equal(b.remember,true);return r.fulfill({json:{requestId:'otp-request'}});});
  await page.route('**/api/auth/email/verify',r=>{const b=r.request().postDataJSON();assert.equal(b.requestId,'otp-request');if(b.code!=='123456')return r.fulfill({status:400,json:{error:'验证码不正确'}});authenticated=true;return r.fulfill({json:{ok:true}});});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.locator('#f1-login').click();await page.waitForSelector('#f1-email-request');
  assert(await page.locator('#f1-password-panel').isHidden());assert(await page.locator('#f1-email-panel').isVisible());
  await page.locator('#f1-remember').check();await page.locator('[data-login-panel=password]').click();assert(await page.locator('#f1-password-login').isVisible());assert(await page.locator('#f1-email-panel').isHidden());assert(await page.locator('#f1-remember').isChecked());
  await page.locator('[data-login-panel=email]').click();await page.locator('#f1-email-request input').fill('fan@example.test');await page.locator('#f1-email-request button').click();await page.waitForSelector('#f1-email-verify');
  await page.locator('#f1-email-verify input').fill('000000');await page.locator('#f1-email-verify button').click();await page.waitForFunction(()=>document.querySelector('#f1-settings-error').textContent==='验证码不正确');
  for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:700});assert(await page.locator('#f1-settings-body').evaluate(e=>e.scrollWidth<=e.clientWidth));assert(await page.locator('#f1-settings-dialog').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));}
  await page.locator('#f1-email-verify input').fill('123456');await page.locator('#f1-email-verify button').click();await page.waitForSelector('#f1-preferences-form');assert.equal(await page.locator('#f1-login').innerText(),'账号');assert.deepEqual(errors,[]);
  console.log('PASS: header login, email/password switching, remembered-device preservation, OTP error/recovery, authenticated state and responsive dialog');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
