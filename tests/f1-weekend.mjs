import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
const server = http.createServer((req,res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const path = pathname === '/f1' ? '/f1.html' : pathname;
  if (!['/f1.html','/f1-account.js','/f1.js','/f1.css','/style.css','/favicon.svg'].includes(path)) {res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html');
  res.end(readFileSync(new URL('../public'+path,import.meta.url)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
const upgradeFixture=JSON.parse(readFileSync(new URL('./fixtures/f1-briefing/legacy-notes.json',import.meta.url),'utf8'))['2026:sepang:2026-10-04'].upgrades;
const wrap=data=>({data,updatedAt:'2026-10-03T10:00:00Z',stale:false,unavailable:false});
const race = (round, date, sprint=false) => ({round:String(round),raceName:'Chinese Grand Prix',date,time:'07:00:00Z',Circuit:{circuitName:'Shanghai International Circuit'},FirstPractice:{date:date.replace(/\d\d$/,String(Number(date.slice(-2))-2).padStart(2,'0')),time:'03:00:00Z'},Qualifying:{date:date.replace(/\d\d$/,String(Number(date.slice(-2))-1).padStart(2,'0')),time:'07:00:00Z'},...(sprint?{SprintQualifying:{date:'2026-10-02',time:'07:00:00Z'},Sprint:{date:'2026-10-03',time:'03:00:00Z'}}:{})});
const rows=[3,1,2].map(position=>({position:String(position),Driver:{givenName:['Lewis','Max','Oscar'][position-1],familyName:['Hamilton','Verstappen','Piastri'][position-1]},Constructor:{constructorId:'ferrari',name:'Ferrari'},Q1:'1:31.212',Q2:'1:31.384',Q3:'1:30.849',Time:{time:'1:30:20.000'},points:'25',laps:'56'}));
let scenario='ordinary', requests=[];
try {
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:1000}});
  await page.clock.install({time:new Date('2026-10-04T04:00:00Z')});
  await page.route('https://media.formula1.com/**', route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><path d="M100 250 L300 80 L700 250 L500 400 Z" fill="none" stroke="#e51b83" stroke-width="10"/><text x="250" y="200">SECTOR 1</text></svg>'}));
  await page.route('**/api/session', route=>route.fulfill({json:{authenticated:false,methods:{password:true}}}));
  await page.route('**/api/f1/**',async route=>{
    const url=new URL(route.request().url());requests.push(url);
    if(url.pathname.endsWith('/circuit-map')) { await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><path d="M100 250 L300 80 L700 250 L500 400 Z" fill="none" stroke="#e51b83" stroke-width="10"/></svg>'});return; }
    if(url.pathname.endsWith('/season')) {
      const current=race(2,scenario==='fallback'?'2026-10-03':'2026-10-04',scenario==='sprint');
      const races=scenario==='upcoming'?[race(1,'2026-10-11')]:scenario==='completed'?[race(1,'2026-09-20')]:[race(1,'2026-09-20'),current,race(3,'2026-10-11')];
      await route.fulfill({json:{season:2026,schedule:wrap(races),winners:wrap([{round:'1',Results:[rows[1]]}]),drivers:wrap({}),constructors:wrap({})}});
    } else if(url.pathname.endsWith('/notes')) {
      await route.fulfill({json:wrap({checkedAt:'2026-10-04T02:00:00Z',upgrades:scenario==='offline'?null:upgradeFixture,tyres:{hard:'C2',medium:'C3',soft:'C4',source:{label:'Pirelli',url:'https://press.pirelli.com/test/'}},strategy:{options:[{label:'两停参考',sequence:['MEDIUM','HARD','HARD']}],note:'赛前参考',source:{label:'Pirelli',url:'https://press.pirelli.com/test/'}},penalties:{items:[{driver:'Isack Hadjar',penalty:'罚退 5 位',reason:'超额内燃机'}],source:{label:'F1',url:'https://www.formula1.com/test/'}}})});
    } else if(url.pathname.endsWith('/news')) {
      await route.fulfill({json:wrap([1,2,3].map(i=>({title:'Sky F1 news '+i,url:'https://www.skysports.com/f1/news/12433/'+i+'/test',publishedAt:'2026-10-04T02:00:00Z'})))});
    } else if(url.pathname.endsWith('/weather')) {
      await route.fulfill({json:scenario==='offline'?{...wrap(null),unavailable:true}:wrap({timezone:'Asia/Shanghai',days:[2,3,4].map(day=>({date:`2026-10-0${day}`,kind:day<4?'past':'forecast',available:true,sessionLabel:day===4?'正赛':'练习',period:'15:00–18:00',scope:'session',temperatureMin:26,temperatureMax:31,rainChance:80,rainMm:1.5,gust:25,code:95,impact:['雷暴风险，留意赛程调整']}))})});
    } else if(url.pathname.endsWith('/circuit')) {
      if(scenario==='sprint') { await route.fulfill({json:wrap({imageUrl:'https://media.formula1.com/image/upload/testdetailed.webp',sourceUrl:'https://www.formula1.com/en/racing/2026/bahrain/circuit',sectors:[[1,3],[4,9],[10,15]]})}); return; }
      await route.fulfill({json:wrap({x:[0,150,300,200,0],y:[0,100,0,-160,0],rotation:0,corners:[{number:1,angle:90,trackPosition:{x:150,y:100}},{number:2,angle:0,trackPosition:{x:300,y:0}},{number:3,angle:270,trackPosition:{x:200,y:-160}}]})});
    } else {
      const session=url.searchParams.get('session');
      const key={race:'Results',qualifying:'QualifyingResults',sprint:'SprintResults',sprintQualifying:'QualifyingResults',practice1:'PracticeResults',practice2:'PracticeResults',practice3:'PracticeResults'}[session];
      const fullRows=rows.concat(Array.from({length:19},(_,i)=>({...rows[0],position:String(i+4)})));
      await route.fulfill({json:scenario==='offline'?{...wrap(null),unavailable:true,stale:true}:{...wrap([{[key]:fullRows}]),...(scenario==='fallback'&&session==='race'?{source:'Formula 1 官网',provisional:true}:{})}});
    }
  });
  await page.goto(origin+'/f1');
  await page.waitForSelector('#f1-podium-qualifying .f1-podium');
  await page.waitForSelector('#f1-circuit-map svg');
  assert.equal(await page.locator('.f1-next-sessions>div').count(),2);
  assert.match(await page.locator('.f1-next-sessions').innerText(),/一练.*10\/02.*排位赛.*10\/03/s);
  assert.equal(await page.locator('.f1-turn-number').count(),3);
  assert((await page.locator('#f1-circuit-map svg').boundingBox()).height>150,'map overrides shared icon dimensions');
  await page.waitForSelector('.f1-weather-day');
  assert.equal(await page.locator('.f1-info-block').count(),6);
  assert.equal(await page.locator('.f1-penalties details').count(),0,'one-line reasons stay directly visible');
  const upperCards=await page.locator('.f1-track-card,.f1-news-card').evaluateAll(cards=>cards.map(e=>e.getBoundingClientRect().bottom));
  assert(Math.abs(upperCards[0]-upperCards[1])<1,'upper cards align at bottom');
  const lowerCards=await page.locator('.f1-penalties-card,.f1-upgrades-card').evaluateAll(cards=>cards.map(e=>e.getBoundingClientRect().bottom));
  assert(Math.abs(lowerCards[0]-lowerCards[1])<1,'lower cards align at bottom');
  assert.equal(await page.locator('.f1-weather-day').count(),3);
  assert.equal(await page.locator('.f1-upgrade-teams span').count(),7);
  assert.equal(await page.locator('#f1-tyres-body svg path').count(),6);
  assert.match(await page.locator('#f1-upgrades-body').innerText(),/7 支车队.*Mercedes/s);
  assert.equal(await page.locator('.f1-upgrade-details').count(),0);
  const beforeUpgradeOpen=await page.locator('.f1-upgrades-card').boundingBox();
  await page.locator('#f1-upgrades-open').click();
  assert.equal(await page.locator('#f1-upgrades-dialog').evaluate(e=>e.open),true);
  assert.equal(await page.locator('#f1-upgrades-detail .f1-upgrade').count(),7);
  assert.match(await page.locator('#f1-upgrades-detail').innerText(),/底板.*扩散器/s);
  assert.equal((await page.locator('.f1-upgrades-card').boundingBox()).height,beforeUpgradeOpen.height,'opening detail keeps summary layout unchanged');
  await page.locator('#f1-upgrades-dialog').screenshot({path:'/tmp/f1-upgrades-modal-desktop.png'});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#f1-upgrades-dialog').isVisible(),false);
  assert.equal(await page.locator('#f1-upgrades-open').evaluate(e=>e===document.activeElement),true);
  const mapBox=await page.locator('.f1-track-card').boundingBox(), weatherBox=await page.locator('.f1-weather-card').boundingBox(), penaltyBox=await page.locator('.f1-penalties-card').boundingBox();
  assert(weatherBox.y>=mapBox.y+mapBox.height && penaltyBox.y>=weatherBox.y+weatherBox.height,'weather and penalties continue below map');
  const dayBoxes=await page.locator('.f1-weather-day').evaluateAll(days=>days.map(day=>({x:day.getBoundingClientRect().x,y:day.getBoundingClientRect().y})));
  assert(dayBoxes.every(day=>day.y===dayBoxes[0].y)&&dayBoxes[2].x>dayBoxes[1].x,'desktop weather uses three columns');

  assert.equal(await page.locator('#f1-sectors').count(),0);
  assert.match(await page.locator('#f1-tyres-body').innerText(),/C4.*C3.*C2/s);
  assert.equal(await page.locator('#f1-news-body .f1-news-item').count(),3);
  assert.match(await page.locator('#f1-news-body').innerText(),/每小时更新.*更新于/s);
  const newsBox=await page.locator('.f1-headlines-card').boundingBox();
  const upgradeBox=await page.locator('.f1-upgrades-card').boundingBox();
  assert(newsBox.y>=Math.max(penaltyBox.y+penaltyBox.height,upgradeBox.y+upgradeBox.height),'news sits below penalties and upgrades');
  assert.match(await page.locator('#f1-penalties-body').innerText(),/Hadjar.*罚退 5 位/s);
  assert.equal(await page.locator('.f1-session-card').count(),2);
  assert.match(await page.locator('.f1-weekend-head').innerText(),/第 2 站/,'select ongoing weekend before race begins');
  assert.match(await page.locator('#f1-podium-race').innerText(),/尚未开赛/);
  assert.match(await page.locator('#f1-podium-qualifying .f1-podium-place').first().innerText(),/Hamilton/,'podium sorted by classified position');
  const summary=await page.locator('#f1-summary').boundingBox(),weekend=await page.locator('#f1-weekend').boundingBox(),tabs=await page.locator('.f1-tabs').boundingBox();
  assert(weekend.y>=summary.y+summary.height && tabs.y>=weekend.y+weekend.height,'result block below summary above tabs');
  await page.locator('[data-view="drivers"]').click(); assert(await page.locator('#f1-weekend').isVisible());
  await page.locator('[data-weekend-session="qualifying"]').click();
  await page.waitForSelector('#f1-result-body table');
  assert.equal(await page.locator('[data-session="qualifying"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#f1-results-dialog').evaluate(e=>e.open),true);
  assert(await page.locator('#f1-result-body').evaluate(e=>e.scrollHeight>e.clientHeight),'full result list scrolls inside dialog');
  await page.locator('#f1-result-body').evaluate(e=>e.scrollTop=200);
  assert(await page.locator('#f1-result-body').evaluate(e=>e.scrollTop>0));
  await page.locator('#f1-results-dialog').screenshot({path:'/tmp/f1-modal-desktop.png'});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#f1-results-dialog').isVisible(),false);
  assert.equal(await page.locator('[data-weekend-session="qualifying"]').evaluate(e=>e===document.activeElement),true,'closing returns focus to opener');
  scenario='sprint'; await page.locator('#f1-refresh').click();
  await page.waitForSelector('#f1-podium-sprintQualifying .f1-podium');
  assert.equal(await page.locator('.f1-session-card').count(),4);
  await page.waitForFunction(()=>document.querySelector('#f1-circuit-map img')?.naturalWidth>0);
  assert.equal(await page.locator('.f1-sector').count(),0,'sector cards removed while map retains annotations');
  assert.equal(await page.locator('#f1-stints').count(),0,'tyre stint UI removed');
  await page.locator('#f1-map-enlarge').click();
  assert.equal(await page.locator('#f1-map-dialog').evaluate(e=>e.open),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#f1-map-dialog').isVisible(),false);
  await page.locator('#f1-weekend-detail').screenshot({path:'/tmp/f1-track-desktop.png'});
  assert(requests.some(url=>url.searchParams.get('session')==='sprintQualifying'));
  await page.locator('[data-weekend-session="sprintQualifying"]').click();await page.waitForSelector('#f1-result-body table');
  assert.equal(await page.locator('[data-session]').count(),5);
  await page.locator('[data-session="practice1"]').click();await page.waitForSelector('#f1-result-body table');
  assert.match(await page.locator('#f1-result-body thead').innerText(),/最快圈速/);
  assert(!(await page.locator('#f1-result-body thead').innerText()).includes('积分'));
  await page.locator('#f1-results-close').click();
  await page.locator('#f1-weekend').screenshot({path:'/tmp/f1-weekend-desktop.png'});
  for(const width of [320,768,900]) {
    await page.setViewportSize({width,height:900});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`no horizontal overflow at ${width}px`);
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('#f1-upgrades-open').click();
  assert(await page.locator('#f1-upgrades-dialog').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}),'upgrade modal stays in mobile viewport');
  assert(await page.locator('#f1-upgrades-detail').evaluate(e=>e.scrollHeight>e.clientHeight),'mobile upgrade content scrolls inside modal');
  await page.locator('#f1-upgrades-dialog').screenshot({path:'/tmp/f1-upgrades-modal-mobile.png'});
  await page.locator('#f1-upgrades-close').click();
  await page.locator('#f1-upgrades-open').click();
  await page.mouse.click(2,2);
  assert.equal(await page.locator('#f1-upgrades-dialog').isVisible(),false,'backdrop closes upgrade dialog');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile has no horizontal page overflow');
  if(process.env.CAPTURE_PREVIEW==='true'){
    mkdirSync('artifacts',{recursive:true});
    await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});
    await page.setViewportSize({width:1280,height:1000});await page.screenshot({path:'artifacts/preview-desktop.png',fullPage:false});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/preview-mobile.png',fullPage:false});
    await page.locator('#theme-toggle').click();await page.screenshot({path:'artifacts/preview-dark.png',fullPage:false});
  }
  await page.locator('#f1-weekend').screenshot({path:'/tmp/f1-weekend-mobile.png'});
  await page.locator('#f1-weekend-detail').screenshot({path:'/tmp/f1-track-mobile.png'});
  await page.locator('[data-weekend-session="qualifying"]').click();await page.waitForSelector('#f1-result-body table');
  assert(await page.locator('#f1-results-dialog').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}),'mobile dialog stays in viewport');
  await page.locator('#f1-results-dialog').screenshot({path:'/tmp/f1-modal-mobile.png'});
  await page.mouse.click(2,2);
  assert.equal(await page.locator('#f1-results-dialog').isVisible(),false,'backdrop closes dialog');
  scenario='completed'; await page.locator('#f1-refresh').click();await page.waitForSelector('#f1-podium-race .f1-podium');
  assert.match(await page.locator('.f1-weekend-head').innerText(),/最近比赛结果/);
  scenario='fallback';await page.locator('#f1-refresh').click();
  await page.waitForFunction(()=>document.querySelector('.f1-weekend-head .f1-badge')?.textContent.includes('暂定成绩'));
  assert.match(await page.locator('#f1-session-meta-race').innerText(),/Formula 1 官网.*暂定成绩/);
  assert.match(await page.locator('#f1-summary').innerText(),/2 站已公布成绩/,'official fallback updates completed-round count');
  await page.locator('[data-weekend-session="race"]').click();await page.waitForSelector('#f1-result-body table');
  assert.equal(await page.locator('#f1-result-body tbody tr').count(),22);
  assert.match(await page.locator('#f1-results').innerText(),/暂定成绩/);
  await page.locator('#f1-results-close').click();
  scenario='offline';await page.locator('#f1-refresh').click();await page.waitForFunction(()=>document.querySelector('#f1-podium-qualifying').textContent.includes('暂时无法获取'));
  await page.waitForFunction(()=>document.querySelector('#f1-weather-body').textContent.includes('暂时无法获取'));
  assert(await page.locator('#f1-circuit-map').isVisible(),'weather failure leaves map available');
  assert.match(await page.locator('#f1-upgrades-body').innerText(),/发布后自动更新/);
  scenario='upcoming';await page.locator('#f1-refresh').click();await page.waitForFunction(()=>document.querySelector('#f1-weekend').textContent.includes('尚未开始'));
  assert.equal(await page.locator('#f1-weekend-detail').isVisible(),false,'no stale map after switching to an unstarted season');
  console.log('PASS: ordinary / sprint weekends, current / completed / future selection, sorted podium, details, offline state, mobile layout');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
