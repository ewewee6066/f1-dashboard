import {load} from 'cheerio';
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
const TTL=15*60_000, DAY=86_400_000;
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const keyOf=(race,season)=>`${season}:${race.Circuit?.circuitId}:${race.date}`;
const epoch=date=>Date.parse(date+'T12:00:00Z');
const teams=[['McLaren',/McLaren/i],['Mercedes',/Mercedes/i],['Red Bull',/Oracle Red Bull|Red Bull Racing/i],['Ferrari',/Ferrari/i],['Williams',/Williams/i],['Racing Bulls',/Racing Bulls|AlphaTauri|Toro Rosso/i],['Aston Martin',/Aston Martin/i],['Haas',/Haas/i],['Audi',/Audi|Sauber/i],['Alpine',/Alpine|Renault/i],['Cadillac',/Cadillac/i]];
const parts={'Coke/Engine Cover':'引擎盖','Floor Board':'底板导流板','Floor Leading Edge':'底板前缘','Floor Corner':'底板边角','Floor Body':'底板主体','Rear Suspension':'后悬架','Rear Corner':'后轮区域','Rear Bodywork':'后部车身','Diffuser':'扩散器','Front Wing':'前翼','Rear Wing':'后翼','Rear Impact Structure':'后部碰撞结构','Front Corner':'前轮区域','Sidepod Inlet':'侧箱进气口','Front Suspension':'前悬架','Beam Wing':'梁翼','Engine Cover':'引擎盖'};
const dateInWindow=(date,race)=>Number.isFinite(date)&&date>=epoch(race.date)-10*DAY&&date<=epoch(race.date)+3*DAY;
function eventMatch(text,race,slug){
  const name=clean(race.raceName).replace(/Grand Prix.*$/i,'').toLowerCase();
  const aliases=[slug?.replace(/-/g,' '),name,race.Circuit?.circuitId?.replace(/_/g,' ')].filter(x=>x&&x.length>3);
  const target=clean(text).replace(/[-_]/g,' ').toLowerCase();
  return aliases.some(alias=>target.includes(alias.toLowerCase())||target.replace(/\s/g,'').includes(alias.toLowerCase().replace(/\s/g,'')));
}
export function articleLinks(html){const $=load(html);return [...new Set($('a[href*="/en/latest/article/"]').map((i,e)=>$(e).attr('href')).get())].filter(x=>/^\/en\/latest\/article\/[^?<>]+$/.test(x)).map(x=>'https://www.formula1.com'+x);}
export function readArticle(html,race,season,slug){
  const $=load(html);let meta;
  $('script[type="application/ld+json"]').each((i,e)=>{try{const json=JSON.parse($(e).text());const list=Array.isArray(json)?json:json['@graph']||[json];meta ||= list.find(x=>x['@type']==='NewsArticle');}catch{}});
  if(!meta||!dateInWindow(Date.parse(meta.datePublished),race)||!eventMatch(meta.headline,race,slug))return null;
  if(/\b20\d{2}\b/.test(meta.headline)&&!meta.headline.includes(String(season)))return null;
  const paragraphs=$('main p').map((i,e)=>clean($(e).text())).get();
  // Only read text already in the public HTML. Locked analysis is represented by a source link.
  return {title:clean(meta.headline),date:meta.dateModified||meta.datePublished,text:paragraphs.join('\n'),locked:meta.isAccessibleForFree==='false'};
}
export function parseCompounds(text){
  const values={};
  for(const [kind,patterns] of Object.entries({hard:[/\b(C[0-6])\s*(?:\(\s*)?(?:as\s+the\s+|as\s+|the\s+)?hard\b/i,/\bhard\b(?:\s+compound|\s+tyre)?\s*[:(–-]?\s*(C[0-6])/i],medium:[/\b(C[0-6])\s*(?:\(\s*)?(?:as\s+the\s+|as\s+|the\s+)?medium\b/i,/\bmedium\b(?:\s+compound|\s+tyre)?\s*[:(–-]?\s*(C[0-6])/i],soft:[/\b(C[0-6])\s*(?:\(\s*)?(?:as\s+the\s+|as\s+|the\s+)?soft\b/i,/\bsoft\b(?:\s+compound|\s+tyre)?\s*[:(–-]?\s*(C[0-6])/i]})){
    for(const pattern of patterns){const hit=text.match(pattern);if(hit){values[kind]=hit[1].toUpperCase();break;}}
  }
  const list=text.match(/\b(C[0-6]),?\s+(C[0-6])\s+and\s+(C[0-6])\b[^.\n]{0,160}\bhard,?\s+medium\s+and\s+soft\b[^.\n]{0,40}\brespectively\b/i);
  if(list){values.hard=list[1];values.medium=list[2];values.soft=list[3];}
  return ['hard','medium','soft'].every(x=>values[x])&&new Set(Object.values(values)).size===3?values:null;
}
export function pirelliLinks(xml,race,season,slug){
  const $=load(xml,{xmlMode:true});
  return $('item').map((i,item)=>{
    const title=clean($(item).find('title').text()),url=clean($(item).find('link').text()),category=clean($(item).find('category').text()),date=Date.parse($(item).find('pubDate').text());
    if(!/^https:\/\/press\.pirelli\.com\/[^?#]+$/.test(url)||!dateInWindow(date,race)||!category.includes(String(season))||!eventMatch(category,race,slug)||!/pole|qualif|strategy|preview|sunday/i.test(title))return null;
    return {url,date};
  }).get().filter(Boolean).sort((a,b)=>b.date-a.date).slice(0,4);
}
export function parsePirelliStrategy(html,race,season,slug){
  const $=load(html);let meta;
  $('script[type="application/ld+json"]').each((i,e)=>{try{const json=JSON.parse($(e).text());if(['Article','NewsArticle'].includes(json['@type']))meta=json;}catch{}});
  if(!meta||!dateInWindow(Date.parse(meta.datePublished),race)||!(meta.keywords||[]).join(' ').includes(String(season))||!eventMatch((meta.keywords||[]).join(' '),race,slug))return null;
  const sequencePattern=/\b(?:Soft|Medium|Hard)(?:\s*[-–→]\s*(?:Soft|Medium|Hard)){1,3}\b/gi;
  const paragraphs=$('p').map((i,e)=>clean($(e).text())).get().filter(p=>/strategy|strategic|stop|competitive|combinations|options/i.test(p));
  const sequences=[...new Set(paragraphs.flatMap(p=>p.match(sequencePattern)||[]).map(x=>x.toUpperCase().split(/\s*[-–→]\s*/).join('-')))];
  if(!sequences.length)return null;
  const notes=paragraphs.join(' '),options=sequences.slice(0,3).map(x=>{const sequence=x.split('-');return {label:({1:'一停',2:'两停',3:'三停'}[sequence.length-1]||'换胎')+'参考',sequence};});
  let note='Pirelli 官方赛前参考，实际选择取决于轮胎库存与比赛情况。';
  if(/unlikely to see one.stop|one.stop[^.]{0,100}no advantage/i.test(notes))note='官方分析认为一停优势有限；以下为赛前换胎组合参考。';
  if(/rain|weather/i.test(notes))note+='天气可能改变策略。';
  return {options,note,source:{label:'Pirelli 官方策略分析',url:String(meta['@id']||meta.mainEntityOfPage?.['@id']||'').replace(/#.*$/,'')}};
}
export function fiaDocuments(html,race,season,slug){
  const $=load(html),documents=[];
  $('.event-title').each((i,e)=>{
    if(!eventMatch($(e).text(),race,slug))return;
    $(e).parent().find('.document-row').each((j,row)=>{
      const title=clean($(row).find('.title').text()),path=$(row).find('a').attr('href'),published=clean($(row).find('.date-display-single').text());
      const date=published.match(/(\d{2})\.(\d{2})\.(\d{2})/);
      const at=date?epoch(`20${date[3]}-${date[2]}-${date[1]}`):NaN;
      if(!path?.startsWith(`/system/files/decision-document/${season}_`)||!dateInWindow(at,race))return;
      documents.push({title,url:'https://www.fia.com'+path,number:Number(title.match(/Doc\s+(\d+)/i)?.[1])||0});
    });
  });
  return documents.sort((a,b)=>b.number-a.number);
}
const pageText=page=>page.map(i=>i.text+(i.eol?'\n':' ')).join('');
export async function pdfPages(bytes){
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,verbosity:0});
  try{const document=await task.promise;if(document.numPages>45)throw Error('PDF too large');const pages=[];for(let n=1;n<=document.numPages;n++){const text=await(await document.getPage(n)).getTextContent();pages.push(text.items.filter(x=>typeof x.str==='string').map(x=>({text:x.str,x:x.transform[4],y:x.transform[5],eol:x.hasEOL})));}return pages;}finally{await task.destroy();}
}
export function validatePdfEvent(pages,race,season,slug){
  const cover=clean(pageText(pages[0]||[]));
  const date=cover.match(/Date\s+(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})/i);
  if(!cover.includes(String(season))||!eventMatch(cover,race,slug)||!date||!dateInWindow(Date.parse(date[1]+' '+date[2]+' '+date[3]+' 12:00:00 UTC'),race))throw Error('PDF belongs to a different event');
  return pages;
}
export function parseUpgrades(pages,source){
  const entries=new Map(),noUpdates=new Set();
  for(const page of pages){
    const text=pageText(page);if(!/Car Presentation/i.test(text))continue;
    const header=text.split(/Updated\s*\n?component|Updated\s+component/i)[0];
    const team=teams.find(([name,re])=>re.test(header)||header.replace(/\s/g,'').toLowerCase().includes(name.replace(/\s/g,'').toLowerCase()))?.[0];if(!team)continue;
    if(/No updates(?: submitted)?(?: for this event)?/i.test(text)){noUpdates.add(team);continue;}
    const component=page.find(i=>/^(?:component|Updated component)$/i.test(clean(i.text))),reason=page.find(i=>/^Primary reason/i.test(clean(i.text)));
    if(!component||!reason||reason.x<=component.x)continue;
    const rowNumbers=page.filter(i=>/^\d{1,2}$/.test(i.text)&&i.x<component.x&&i.y<component.y);
    const left=rowNumbers.length?Math.max(...rowNumbers.map(i=>i.x))+8:component.x-20;
    const found=page.filter(i=>i.x>=left&&i.x<reason.x-6&&i.y<component.y-6&&i.y>30).map(i=>i.text);
    const names=clean(found.join(' ')).replace(/\b\d+\b/g,'').trim();if(!names)continue;
    const translated=Object.entries(parts).reduce((value,[en,zh])=>value.replaceAll(en,zh),names);
    const categories=[];if(/Performance/i.test(text))categories.push('性能');if(/Cooling|Brake Cooling/i.test(text))categories.push('散热');if(/Circuit specific/i.test(text))categories.push('赛道适配');
    const previous=entries.get(team);entries.set(team,{team,parts:previous?previous.parts+'、'+translated:translated,category:[...new Set([...(previous?.categories||[]),...categories])].join(' / ')||'官方申报',categories:[...new Set([...(previous?.categories||[]),...categories])],summary:'更新目的以官方申报为准；实际圈速收益需由比赛验证。'});
  }
  if(!entries.size&&!noUpdates.size)throw Error('Unrecognized FIA upgrade document');
  return {items:[...entries.values()].map(({categories,...item})=>item),noUpdates:[...noUpdates],source,note:'自动读取 FIA 申报部件；不将申报目的视为已验证的圈速收益。'};
}
const reasonText=text=>/power unit|PU elements/i.test(text)?'更换超额动力单元组件':/causing a collision/i.test(text)?'碰撞处罚':/impeding/i.test(text)?'阻挡处罚':clean(text).slice(0,160);
export function parseGrid(pages,source){
  const text=pages.map(pageText).join('\n');if(!/Starting Grid/i.test(text))throw Error('Not a grid document');
  const drivers=new Map();for(const line of text.split('\n')){const hit=clean(line).match(/^\d{1,2}\s+(\d{1,2})\s+([A-Za-zÀ-ž][A-Za-zÀ-ž .'-]+?)(?:\s*\*)?$/);if(hit)drivers.set(hit[1],hit[2]);}
  if(drivers.size<10)throw Error('Unrecognized starting grid');
  const items=new Map();
  for(const line of text.split('\n')){const hit=line.match(/Car\s+(\d+)\s*[-–]\s*(\d+)\s*place grid penalty\s*[-–]\s*(.*?)(?:\s*[-–]\s*Stewards|$)/i);if(!hit)continue;const previous=items.get(hit[1]);items.set(hit[1],{driver:drivers.get(hit[1])||`赛车 ${hit[1]}`,places:(previous?.places||0)+Number(hit[2]),reasons:[...(previous?.reasons||[]),reasonText(hit[3])]});}
  if(/\*\s*PENALTIES/i.test(text)&&!items.size)throw Error('Unknown penalty format');
  return {items:[...items.values()].map(i=>({driver:i.driver,penalty:`罚退 ${i.places} 位`,reason:[...new Set(i.reasons)].join('；')})),source,grid:source,provisional:/provisional/i.test(source.label)};
}
export function parseDecision(pages,source){
  const text=clean(pages.map(pageText).join(' '));const driver=text.match(/No\s*\/\s*Driver\s+\d+\s*[-–]\s*(.*?)\s+Competitor/i)?.[1];const decision=text.match(/Decision\s+(.*?)(?:\s+Reason\s|\s+Reasons\s)/i)?.[1];
  if(!driver||!decision)return null;
  const count=decision.match(/(?:Drop of|penalty of|drop of)\s+(\d+)\s+(?:grid positions|places|place)/i)||decision.match(/(\d+)\s*[- ]place grid/i);
  const pit=/start.*pit lane/i.test(decision);if(!count&&!pit)return null;
  return {driver,penalty:pit?'维修区发车':`罚退 ${count[1]} 位`,reason:reasonText(text.match(/Fact\s+(.*?)\s+Infringement/i)?.[1]||source.label),source};
}
export function createF1Briefing({dataDir,fetcher=fetch,clock=Date.now,pdfReader=pdfPages}={}){
  const cache=new Map(),pending=new Map(),resources=new Map(),resourceJobs=new Map(),retry=new Map();
  let active=0;const waiters=[];
  const acquire=async()=>{if(active>=3)await new Promise(resolve=>waiters.push(resolve));else active++;};
  const release=()=>{const next=waiters.shift();if(next)next();else active--;};
  const file=dataDir&&join(dataDir,'f1-briefing-cache.json');
  if(file){try{for(const [key,entry] of JSON.parse(readFileSync(file,'utf8'))){if(cache.size<60&&entry?.data&&Number.isFinite(entry.at))cache.set(key,entry);}}catch{}}
  const save=()=>{if(!file)return;try{mkdirSync(dataDir,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify([...cache]),{mode:0o600});renameSync(file+'.tmp',file);}catch{}};
  async function resource(url,binary=false){
    const parsed=new URL(url);if(!['www.formula1.com','www.fia.com','press.pirelli.com'].includes(parsed.hostname)||parsed.protocol!=='https:')throw Error('Unexpected source');
    const cached=resources.get(url);if(cached&&clock()-cached.at<TTL)return cached.data;
    if(clock()<(retry.get(url)||0))throw Error('Source retry pending');
    if(!resourceJobs.has(url)){const job=(async()=>{await acquire();try{const response=await fetcher(url,{signal:AbortSignal.timeout(12_000),redirect:'error',headers:{'User-Agent':'f1-dashboard/1.0','Accept':binary?'application/pdf':'text/html'}});if(!response.ok){retry.set(url,clock()+(response.status===429?Math.max(60,Math.min(3600,Number(response.headers.get('retry-after'))||60))*1000:60_000));throw Error('Official source unavailable');}if(Number(response.headers.get('content-length'))>12_000_000)throw Error('Source too large');const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>12_000_000)throw Error('Source too large');const data=binary?bytes:new TextDecoder().decode(bytes);if(resources.size>=80)resources.delete(resources.keys().next().value);resources.set(url,{data,at:clock()});return data;}catch(e){if(!retry.has(url))retry.set(url,clock()+60_000);throw e;}finally{release();resourceJobs.delete(url);}})();resourceJobs.set(url,job);}return resourceJobs.get(url);
  }
  return {async weekend(race,season,slug){
    const key='strategy-v2:'+keyOf(race,season),previous=cache.get(key);
    const wrap=(entry,stale=false)=>({data:entry?.data||null,updatedAt:entry?new Date(entry.at).toISOString():null,stale,unavailable:!entry,automatic:true});
    if(previous&&clock()-previous.at<TTL)return wrap(previous,previous.stale);
    if(pending.has(key))return pending.get(key);
    if(pending.size>=3)return wrap(previous,true);
    const job=(async()=>{
      const data={tyres:null,strategy:null,penalties:null,upgrades:null,automatic:true,checkedAt:new Date(clock()).toISOString(),status:{}};let failed=false;
      const section=async(id,fn)=>{try{data[id]=await fn();data.status[id]=data[id]?'available':'pending';if(data[id])data[id].fetchedAt=new Date(clock()).toISOString();}catch{failed=true;data[id]=previous?.data?.[id]||null;data.status[id]=data[id]?'stale':'unavailable';}};
      const readPdf=async url=>validatePdfEvent(await pdfReader(await resource(url,true)),race,season,slug);
      const news=async()=>{
        const hub=slug?await resource(`https://www.formula1.com/en/racing/${season}/${slug}`).catch(()=>null):null;
        const links=new Set(hub?articleLinks(hub):[]);
        // Recent official archive pages cover the build-up as the race hub replaces older headlines.
        if(Math.abs(clock()-epoch(race.date))<14*DAY){for(let base=0;base<9;base+=3){const pages=await Promise.allSettled([base,base+1,base+2].map(n=>resource('https://www.formula1.com/en/latest'+(n?'?page='+n:''))));for(const page of pages)if(page.status==='fulfilled')for(const link of articleLinks(page.value))links.add(link);if([...links].some(link=>/what-tyres/i.test(link)&&eventMatch(decodeURIComponent(link),race,slug)))break;}}
        const candidates=[...links].filter(link=>eventMatch(decodeURIComponent(link),race,slug)&&/(what-tyres|strategy-guide)/i.test(link)).slice(0,8);
        const articles=await Promise.allSettled(candidates.map(async url=>{const article=readArticle(await resource(url),race,season,slug);return article?{...article,url}:null;}));
        const valid=articles.filter(x=>x.status==='fulfilled'&&x.value).map(x=>x.value).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
        if(!valid.length&&articles.some(x=>x.status==='rejected'))throw Error('News fetch failed');
        const compound=valid.find(x=>/what.tyres/i.test(x.title)&&parseCompounds(x.text));
        data.tyres=compound?{...parseCompounds(compound.text),source:{label:'F1 官方配方公告',url:compound.url},note:'按本场官方公告自动更新。'}:null;
        const strategy=valid.find(x=>/STRATEGY GUIDE/i.test(x.title));
        data.strategy=strategy?{options:[],note:strategy.locked?'官方策略指南已发布，部分内容需在 F1 官网登录后查看。':'官方策略指南已发布，点击来源查看本场分析。',source:{label:'F1 官方策略指南',url:strategy.url}}:null;
        try {
          const reports=pirelliLinks(await resource('https://press.pirelli.com/tagfeed/en/tags/news'),race,season,slug);
          for(const report of reports){const parsed=parsePirelliStrategy(await resource(report.url),race,season,slug);if(parsed){parsed.source.url=report.url;data.strategy=parsed;break;}}
        }catch{if(previous?.data?.strategy?.options?.length){data.strategy=previous.data.strategy;data.status.strategy='stale';failed=true;}}

        if(!hub&& !links.size)throw Error('News unavailable');
      };
      await Promise.all([
        (async()=>{try{await news();for(const id of ['tyres','strategy']){data.status[id] ||= data[id]?'available':'pending';}}catch{failed=true;for(const id of ['tyres','strategy']){data[id]=previous?.data?.[id]||null;data.status[id]=data[id]?'stale':'unavailable';}}})(),
        (async()=>{let documents;try{documents=fiaDocuments(await resource('https://www.fia.com/documents/formula-1'),race,season,slug);if(!documents.length){const event=clean(race.raceName).replace(/ in .*$/,'');documents=fiaDocuments(await resource('https://www.fia.com/documents/formula-1/event/'+encodeURIComponent(event)),race,season,slug);}}catch{failed=true;for(const id of ['penalties','upgrades']){data[id]=previous?.data?.[id]||null;data.status[id]=data[id]?'stale':'unavailable';}return;}
          await Promise.all([
            section('upgrades',async()=>{const doc=documents.find(x=>/Car Presentation Submissions/i.test(x.title));return doc?parseUpgrades(await readPdf(doc.url),{label:'FIA 升级申报 · '+doc.title,url:doc.url}):null;}),
            section('penalties',async()=>{const grid=documents.find(x=>/Final Starting Grid/i.test(x.title))||documents.find(x=>/Provisional Starting Grid/i.test(x.title));if(grid)return parseGrid(await readPdf(grid.url),{label:/Final/i.test(grid.title)?'FIA 正式发车顺序':'FIA 暂定发车顺序',url:grid.url});const selected=documents.filter(x=>/Infringement/i.test(x.title)&&!/Deleted Lap|Pit Lane Speeding/i.test(x.title)).slice(0,8);const outcomes=await Promise.all(selected.map(async doc=>parseDecision(await readPdf(doc.url),{label:doc.title,url:doc.url})));const items=outcomes.filter(Boolean);return items.length?{items,source:{label:'FIA 本场裁决',url:'https://www.fia.com/documents/formula-1'}}:null;})
          ]);
        })()
      ]);
      const entry={data,at:clock(),stale:failed};if(cache.size>=60)cache.delete(cache.keys().next().value);cache.set(key,entry);save();return wrap(entry,failed);
    })().finally(()=>pending.delete(key));pending.set(key,job);return job;
  }};
}
