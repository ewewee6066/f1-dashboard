import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const DAY = 86_400_000, TTL = 15 * 60_000;
const finite = value => Number.isFinite(value) ? value : null;
const max = values => values.some(Number.isFinite) ? Math.max(...values.filter(Number.isFinite)) : null;
const min = values => values.some(Number.isFinite) ? Math.min(...values.filter(Number.isFinite)) : null;
const local = (date, zone) => new Date(date).toLocaleString('sv-SE', { timeZone: zone }).replace(' ', 'T');
const sessionSpecs = [['FirstPractice','一练',1.5],['SecondPractice','二练',1.5],['ThirdPractice','三练',1.5],['SprintQualifying','冲刺排位',1.5],['SprintShootout','冲刺排位',1.5],['Sprint','冲刺赛',1.5],['Qualifying','排位赛',1.5],['race','正赛',3]];
export function summarizeWeather(race, payload, now = Date.now()) {
  const zone = payload.timezone;
  // Validate the upstream timezone before using it to match UTC session times.
  const today = local(now, zone).slice(0,10);
  const sessions = sessionSpecs.flatMap(([key,label,hours]) => {
    const s = key === 'race' ? race : race[key];
    if (!s?.date || !s.time) return [];
    const start = Date.parse(`${s.date}T${s.time}`);
    if (!Number.isFinite(start)) return [];
    return [{ label, start: local(start,zone), end: local(start + hours*3_600_000,zone) }];
  });
  const end = sessions.find(s => s.label === '正赛')?.start.slice(0,10) || race.date;
  const first = new Date(Date.parse(end + 'T12:00:00Z') - 2*DAY).toISOString().slice(0,10);
  const days = Array.from({length:3},(_,i) => {
    const date = new Date(Date.parse(first + 'T12:00:00Z') + i*DAY).toISOString().slice(0,10);
    const index = payload.daily.time.indexOf(date), daySessions = sessions.filter(s=>s.start.slice(0,10)===date);
    const hourly = payload.hourly || {}, indexes = (hourly.time || []).flatMap((t,n)=> daySessions.some(s=>t>=s.start.slice(0,13)+':00' && t<s.end.slice(0,16)) ? [n] : []);
    const h = key => indexes.map(i=>hourly[key]?.[i]);
    const d = key => index >= 0 ? finite(payload.daily[key]?.[index]) : null;
    const sessionData = indexes.length > 0;
    const rainChance = sessionData ? max(h('precipitation_probability')) : d('precipitation_probability_max');
    const temperatureMax = sessionData ? max(h('temperature_2m')) : d('temperature_2m_max');
    const gust = sessionData ? max(h('wind_gusts_10m')) : d('wind_gusts_10m_max');
    const code = sessionData ? max(h('weather_code')) : d('weather_code');
    const impact = [];
    if (code >= 95) impact.push('雷暴风险，留意赛程调整');
    else if (rainChance >= 40) impact.push('降雨风险，可能影响雨胎与换胎时机');
    if (gust >= 40) impact.push('阵风较强，可能影响制动与车辆平衡');
    if (temperatureMax >= 32) impact.push('高温，留意轮胎衰减与冷却');
    return { date, kind: date < today ? 'past' : 'forecast', available: index >= 0,
      sessionLabel: daySessions.map(s=>s.label).join(' / ') || '周末日程',
      period: sessionData ? daySessions.map(s=>`${s.start.slice(11,16)}–${s.end.slice(11,16)}`).join(' / ') : null,
      scope: sessionData ? 'session' : 'day', temperatureMin: sessionData ? min(h('temperature_2m')) : d('temperature_2m_min'),
      temperatureMax, rainChance, rainMm: sessionData ? (h('precipitation').some(Number.isFinite) ? h('precipitation').filter(Number.isFinite).reduce((a,b)=>a+b,0) : null) : d('precipitation_sum'), gust, code, impact };
  });
  return { timezone: zone, days };
}
export function createF1Weather({ dataDir, fetcher=fetch, clock=Date.now }={}) {
  const cache=new Map(), pending=new Map(), retryAt=new Map();
  let blockedUntil=0;
  const file=dataDir && join(dataDir,'f1-weather-cache.json');
  if(file){try{for(const [key,entry] of JSON.parse(readFileSync(file,'utf8'))){if(cache.size<60 && entry?.data?.daily?.time && Number.isFinite(entry.at))cache.set(key,entry);}}catch{}}
  const save=()=>{if(!file)return;try{mkdirSync(dataDir,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify([...cache]),{mode:0o600});renameSync(file+'.tmp',file);}catch{}};
  return {
    async weekend(race) {
      const lat=Number(race.Circuit?.Location?.lat), lon=Number(race.Circuit?.Location?.long);
      if(race.Circuit?.Location?.lat == null || race.Circuit?.Location?.long == null || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat)>90 || Math.abs(lon)>180)return {data:null,unavailable:true,reason:'coordinates_missing'};
      const raceDay=Date.parse(`${race.date}T12:00:00Z`);
      if(!Number.isFinite(raceDay))return {data:null,unavailable:true,reason:'date_missing'};
      if(raceDay<clock()-6*DAY || raceDay>clock()+15*DAY)return {data:null,unavailable:false,reason:raceDay<clock()?'past_weekend':'forecast_pending'};
      const key=`${race.date}:${lat}:${lon}`, previous=cache.get(key);
      const wrap=(entry,stale=false)=>({data:entry?summarizeWeather(race,entry.data,clock()):null,updatedAt:entry?new Date(entry.at).toISOString():null,stale,unavailable:!entry});
      if(previous && clock()-previous.at<TTL)return wrap(previous);
      if(clock()<blockedUntil || clock()<(retryAt.get(key)||0))return wrap(previous,true);
      if(!pending.has(key)){
        if(pending.size>=8)return wrap(previous,true);
        const job=(async()=>{
          try{
            const url=new URL('https://api.open-meteo.com/v1/forecast');
            url.search=new URLSearchParams({latitude:String(lat),longitude:String(lon),timezone:'auto',past_days:'7',forecast_days:'16',daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_gusts_10m_max',hourly:'temperature_2m,precipitation_probability,precipitation,weather_code,wind_gusts_10m'}).toString();
            const response=await fetcher(url.toString(),{signal:AbortSignal.timeout(8000)});
            if(!response.ok){if(response.status===429)blockedUntil=clock()+Math.max(60,Math.min(3600,Number(response.headers.get('retry-after'))||60))*1000;throw new Error('weather unavailable');}
            const data=await response.json();
            if(!Array.isArray(data.daily?.time)||typeof data.timezone!=='string')throw new Error('invalid weather');
            summarizeWeather(race,data,clock());
            const entry={data,at:clock()};
            if(cache.size>=60)cache.delete(cache.keys().next().value);
            cache.set(key,entry);retryAt.delete(key);save();return wrap(entry);
          }catch{if(retryAt.size>=60)retryAt.delete(retryAt.keys().next().value);retryAt.set(key,clock()+60_000);return wrap(previous,true);}
          finally{pending.delete(key);}
        })();pending.set(key,job);
      }
      return pending.get(key);
    }
  };
}
