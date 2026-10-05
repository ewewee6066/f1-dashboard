import {load} from 'cheerio';
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
const TTL=2*60_000;
const text=s=>String(s||'').replace(/\s+/g,' ').trim();
export function findOfficialResult(html,season,slug){
  const $=load(html),paths=$('a[href]').map((i,e)=>$(e).attr('href')).get();
  const path=paths.find(path=>new RegExp(`^/en/results/${season}/races/\\d+/${slug}/race-result$`).test(path));
  return path?'https://www.formula1.com'+path:null;
}
export function parseOfficialResult(html,race,season){
  const $=load(html),heading=text($('h1').text()),main=$('main').length?$('main'):$('body');
  const body=text(main.text());
  if(!heading.includes(String(season))||!/RACE RESULT/i.test(heading)||!body.toLowerCase().includes(text(race.Circuit?.circuitName).toLowerCase())||!race.Circuit?.circuitName)throw Error('Wrong result event');
  const date=new Date(race.date+'T12:00:00Z'),month=date.toLocaleString('en-US',{month:'short',timeZone:'UTC'});
  if(!new RegExp(`\\b0?${date.getUTCDate()}\\s+${month}\\s+${season}(?!\\d)`,'i').test(body))throw Error('Wrong result date');
  const table=main.find('table').filter((i,e)=>/Time.*Retired/i.test($(e).find('thead').text())&&/Pts/i.test($(e).find('thead').text())).first();
  if(!table.length)return {rows:[],provisional:false};
  const rows=[];table.find('tbody tr').each((index,tr)=>{
    const cells=$(tr).find('td');if(cells.length!==7)throw Error('Unknown result columns');
    const place=text(cells.eq(0).text()),number=text(cells.eq(1).text());
    const driverCell=cells.eq(2).clone();driverCell.find('img,[class~="md:hidden"]').remove();
    const name=text(driverCell.text()),words=name.split(' '),team=text(cells.eq(3).text()),laps=text(cells.eq(4).text()),time=text(cells.eq(5).text()),points=text(cells.eq(6).text());
    if(!/^(\d+|NC|DSQ|DQ)$/.test(place)||!/^\d+$/.test(number)||words.length<2||!team||!/^\d+$/.test(laps)||!/^\d+(\.\d+)?$/.test(points)||!time)throw Error('Invalid result row');
    const constructorId=Object.entries({red_bull:'Red Bull',mercedes:'Mercedes',ferrari:'Ferrari',mclaren:'McLaren',rb:'Racing Bulls',aston_martin:'Aston Martin',alpine:'Alpine',haas:'Haas',williams:'Williams',sauber:'Audi',cadillac:'Cadillac'}).find(([,alias])=>team.includes(alias))?.[0];
    rows.push({position:/^\d+$/.test(place)?place:String(index+1),positionText:place,number,Driver:{givenName:words[0],familyName:words.slice(1).join(' ')},Constructor:{name:team,...(constructorId?{constructorId}:{})},laps,points,Time:{time},status:/DNF|DSQ|DQ|DNS/.test(time)?time:'Finished'});
  });
  if(rows.length&& (rows.length<3||!rows.some(row=>row.positionText==='1')))throw Error('Incomplete result table');
  return {rows,provisional:/provisional results/i.test(body)};
}
export function createOfficialResults({dataDir,fetcher=fetch,clock=Date.now}={}){
  const cache=new Map(),pending=new Map(),retry=new Map();const file=dataDir&&join(dataDir,'f1-official-results-cache.json');
  if(file){try{for(const [key,entry] of JSON.parse(readFileSync(file,'utf8'))){if(cache.size<60&&entry?.data&&Number.isFinite(entry.at))cache.set(key,entry);}}catch{}}
  const save=()=>{if(!file)return;try{mkdirSync(dataDir,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify([...cache]),{mode:0o600});renameSync(file+'.tmp',file);}catch{}};
  async function fetchHtml(url){
    const u=new URL(url);if(u.hostname!=='www.formula1.com'||u.protocol!=='https:')throw Error('Unexpected result source');
    const response=await fetcher(url,{signal:AbortSignal.timeout(8000),redirect:'error',headers:{'User-Agent':'f1-paddock/1.0',Accept:'text/html'}});
    if(!response.ok){if(response.status===429)retry.set('global',clock()+Math.max(60,Math.min(3600,Number(response.headers.get('retry-after'))||60))*1000);throw Error('Official results unavailable');}
    const html=await response.text();if(html.length>3_000_000)throw Error('Result page too large');return html;
  }
  return {async race(race,season,slug){
    const key=`${season}:${race.Circuit?.circuitId}:${race.date}`,previous=cache.get(key);
    const wrap=(entry,stale=false)=>({data:entry?.data||null,source:'Formula 1 官网',sourceUrl:entry?.url||null,provisional:entry?.provisional||false,updatedAt:entry?new Date(entry.at).toISOString():null,stale,unavailable:!entry});
    if(!slug||Date.parse(`${race.date}T${race.time||'23:59:59Z'}`)>clock())return wrap(null);
    if(previous&&clock()-previous.at<TTL)return wrap(previous);
    if(clock()<(retry.get(key)||0)||clock()<(retry.get('global')||0))return wrap(previous,true);
    if(pending.has(key))return pending.get(key);if(pending.size>=3)return wrap(previous,true);
    const job=(async()=>{try{
      const url=findOfficialResult(await fetchHtml(`https://www.formula1.com/en/racing/${season}/${slug}`),season,slug);
      if(!url)return {data:[],source:'Formula 1 官网',unavailable:false,stale:false,updatedAt:null};
      const result=parseOfficialResult(await fetchHtml(url),race,season);
      const entry={data:result.rows.length?[{round:String(race.round),Results:result.rows}]:[],at:clock(),url,provisional:result.provisional};
      // A temporarily blank official page never erases a previously published classification.
      if(!result.rows.length&&previous?.data?.length)return wrap(previous,true);
      if(cache.size>=60)cache.delete(cache.keys().next().value);cache.set(key,entry);save();return wrap(entry);
    }catch{retry.set(key,clock()+60_000);return wrap(previous,true);}finally{pending.delete(key);}})();pending.set(key,job);return job;
  }};
}
