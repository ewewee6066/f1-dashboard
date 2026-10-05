import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {chromium} from '@playwright/test';
const server=http.createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;const asset=path==='/f1'?'f1.html':path.slice(1);if(!['f1.html','f1.js','f1-account.js','f1.css','style.css','favicon.svg'].includes(asset)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',asset.endsWith('.js')?'application/javascript':asset.endsWith('.css')?'text/css':'text/html');res.end(readFileSync(new URL('../public/'+asset,import.meta.url)));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const wrap=data=>({data,stale:false,unavailable:false}),season={season:2026,schedule:wrap([]),winners:wrap([]),drivers:wrap({}),constructors:wrap({})};let subscription={enabled:false,kinds:['race'],emailId:null,emails:[],available:true},prefs={driverId:null,constructorId:null},bound=false;
 await page.route('**/api/session',r=>r.fulfill({json:{authenticated:true,csrf:'csrf',user:{id:'a',name:'测试账号'},methods:{email:true}}}));
 await page.route('**/api/f1/season?*',r=>r.fulfill({json:season}));
 await page.route('**/api/account/f1-preferences',r=>{if(r.request().method()==='PUT')prefs=r.request().postDataJSON();return r.fulfill({json:prefs});});
 await page.route('**/api/account/f1-subscription',r=>{if(r.request().method()==='PUT'){const next=r.request().postDataJSON();assert.equal(r.request().headers()['x-csrf-token'],'csrf');subscription={...subscription,...next,testEmailStatus:next.enabled?'queued':null};}return r.fulfill({json:subscription});});
 await page.route('**/api/auth/email/request',r=>{assert.equal(r.request().postDataJSON().intent,'link');return r.fulfill({json:{requestId:'binding',retryAfter:60}});});
 await page.route('**/api/auth/email/verify',r=>{assert.equal(r.request().postDataJSON().code,'123456');bound=true;subscription={...subscription,emailId:'mail-a',emails:[{id:'mail-a',email:'a@example.test'}]};return r.fulfill({json:{linked:true}});});
 await page.goto(`http://127.0.0.1:${server.address().port}/f1`);await page.locator('#f1-settings').click();await page.waitForSelector('#f1-subscription-form');
 assert(await page.locator('[name=enabled]').isDisabled(),'requires binding even without standings');
 await page.locator('#f1-bind-email').click();await page.locator('#f1-bind-request input').fill('a@example.test');await page.locator('#f1-bind-request button').click();await page.locator('#f1-bind-verify input').fill('123456');await page.locator('#f1-bind-verify button').click();await page.waitForSelector('#f1-subscription-form');assert(bound);assert(await page.locator('[name=enabled]').isEnabled());
 await page.locator('[name=enabled]').check();for(const kind of ['practice','qualifying','sprint','sprintQualifying'])await page.locator(`[name=kinds][value=${kind}]`).check();
 await page.evaluate(()=>window.F1Account.setStandings({drivers:{data:{DriverStandings:[{Driver:{driverId:'test-driver',givenName:'Test',familyName:'Driver'}}]}},constructors:{data:{ConstructorStandings:[{Constructor:{constructorId:'test-team',name:'Test Team'}}]}}}));
 assert(await page.locator('[name=enabled]').isChecked(),'late standings preserve unsaved subscription switch');assert.equal(await page.locator('[name=kinds]:checked').count(),5,'late standings preserve unsaved categories');
 await page.locator('[name=driverId]').selectOption('test-driver');await page.evaluate(()=>window.F1Account.setStandings({drivers:{data:{DriverStandings:[{Driver:{driverId:'other',givenName:'Other',familyName:'Driver'}}]}},constructors:{data:{ConstructorStandings:[{Constructor:{constructorId:'other-team',name:'Other Team'}}]}}}));assert.equal(await page.locator('[name=driverId]').inputValue(),'test-driver','background update preserves selected preference');
 await page.locator('#f1-subscription-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#f1-subscription-status').textContent==='订阅已开启，测试邮件正在发送。');assert.equal(subscription.kinds.length,5);
 await page.locator('#f1-settings-close').click();await page.locator('#f1-settings').click();await page.waitForSelector('#f1-subscription-form');assert(await page.locator('[name=enabled]').isChecked());
 await page.locator('#f1-settings-dialog').screenshot({path:'/tmp/f1-subscription-mobile.png'});
 for(const width of[320,390,768,1280]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert(await page.locator('#f1-settings-body').evaluate(e=>e.scrollWidth<=e.clientWidth));}
 await page.locator('[name=enabled]').uncheck();await page.locator('#f1-subscription-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#f1-subscription-status').textContent==='订阅已关闭。');assert.equal(subscription.enabled,false);assert.deepEqual(errors,[]);
 await page.goto('file:///tmp/f1-email-preview.html');await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'/tmp/f1-email-mobile.png',fullPage:true});
 console.log('PASS: settings without standings, email binding, five subscription categories, persistence, unsubscribe and 320–1280px layouts; email mobile preview');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
