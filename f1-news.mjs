import {load} from 'cheerio';
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
export const F1_NEWS_TTL = 60 * 60_000;
const SOURCE='https://www.skysports.com/rss/12433',TTL=F1_NEWS_TTL;
export function parseF1News(xml) {
  const $=load(xml,{xmlMode:true}),seen=new Set();
  return $('item').toArray().map(item=>{
    const node=$(item),title=node.find('title').text().replace(/\s+/g,' ').trim(),raw=node.find('link').text().trim();
    let url;try{url=new URL(raw);}catch{return null;}
    const publishedAt=Date.parse(node.find('pubDate').text().trim().replace(/\sBST$/, ' +0100'));
    if(url.protocol!=='https:'||url.hostname!=='www.skysports.com'||!/^\/f1\/news\//.test(url.pathname)||!title||!Number.isFinite(publishedAt)||seen.has(url.href))return null;
    seen.add(url.href);return {title:title.slice(0,400),url:url.href,publishedAt:new Date(publishedAt).toISOString()};
  }).filter(Boolean).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)).slice(0,3);
}
export function createF1News({dataDir,fetcher=fetch,clock=Date.now}={}) {
  const file=dataDir&&join(dataDir,'f1-news-cache.json');let cached=null,pending=null,retryAt=0;
  if(file)try{const entry=JSON.parse(readFileSync(file,'utf8'));if(Number.isFinite(entry.at)&&Array.isArray(entry.data))cached=entry;}catch{}
  const wrap=(stale=false)=>({data:cached?.data||[],updatedAt:cached?new Date(cached.at).toISOString():null,source:'Sky Sports',sourceUrl:'https://www.skysports.com/f1/news',stale,unavailable:!cached});
  return {async latest({refresh=false}={}){
    if(!refresh&&cached&&clock()-cached.at<TTL)return wrap();if(clock()<retryAt)return wrap(true);if(pending)return pending;
    pending=(async()=>{try{
      const r=await fetcher(SOURCE,{signal:AbortSignal.timeout(8000),redirect:'error'});if(!r.ok)throw Error('News unavailable');
      const xml=await r.text();if(xml.length>2_000_000)throw Error('Feed too large');const data=parseF1News(xml);if(!data.length)throw Error('No F1 news');cached={at:clock(),data};
      if(file)try{mkdirSync(dataDir,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(cached),{mode:0o600});renameSync(file+'.tmp',file);}catch{}
      return wrap();
    }catch{retryAt=clock()+60_000;return wrap(true);}finally{pending=null;}})();return pending;
  }};
}
