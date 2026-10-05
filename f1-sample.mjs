import {collectF1Email} from './f1-email.mjs';
import {sessionTime,sessionsFor} from './f1-sessions.mjs';
// Only activation samples fill absent sections. Scheduled reports retain source availability.
export function completeF1Sample(input) {
  const content=structuredClone(input),sampleBlocks=[];
  const mark=(key)=>sampleBlocks.push(key);
  content.notes||={};content.notes.data||={};const n=content.notes.data;
  if(!n.tyres?.soft||!n.tyres?.medium||!n.tyres?.hard){n.tyres={soft:'C4',medium:'C3',hard:'C2'};mark('tyres');}
  if(!n.strategy?.options?.length){n.strategy={options:[{label:'两停组合示例',sequence:['MEDIUM','HARD','HARD']},{label:'两停备选示例',sequence:['SOFT','HARD','HARD']}],note:'用于展示轮胎策略排版；不作为本场策略建议。'};mark('strategy');}
  if(!n.penalties?.items?.length){n.penalties={items:[{driver:'示例车手 A',penalty:'罚退 5 位',reason:'超额动力单元组件（排版示例）'},{driver:'示例车手 B',penalty:'维修区起步',reason:'封闭车检区内调整赛车设置（排版示例）'}]};mark('penalties');}
  if(!n.upgrades?.items?.length){n.upgrades={items:[{team:'示例车队 A',parts:'前翼、底板前缘',summary:'用于展示升级部件和说明。'},{team:'示例车队 B',parts:'引擎盖、后轮区域',summary:'用于展示散热与赛道适配说明。'}]};mark('upgrades');}
  const existingDays=content.weather?.data?.days||[];
  if(existingDays.length<3||existingDays.some(d=>!d.available||!Number.isFinite(d.temperatureMin)||!Number.isFinite(d.temperatureMax)||!Number.isFinite(d.rainChance))){
    const date=Date.parse(content.race.date+'T12:00:00Z');
    content.weather={data:{timezone:'示例时区',days:[-2,-1,0].map((offset,i)=>({date:new Date(date+offset*86400_000).toISOString().slice(0,10),available:true,kind:'sample',sessionLabel:['练习赛','排位赛','正赛'][i],temperatureMin:24+i,temperatureMax:30+i,rainChance:[20,45,65][i],impact:['天气示例，用于检查邮件排版']}))}};mark('weather');
  }
  if(!content.currentResults?.length){
    content.currentResults=sessionsFor(content.race).map(s=>({...s,rows:[1,2,3].map(position=>({position:String(position),Driver:{givenName:'示例',familyName:'车手 '+position},Constructor:{name:'示例车队 '+position},Time:{time:'1:30.000'}}))}));mark('results');
  }
  if(!content.season.drivers?.data?.DriverStandings?.length){content.season.drivers={data:{DriverStandings:[{Driver:{givenName:'示例',familyName:'车手'},points:'100'}]}};mark('drivers');}
  if(!content.season.constructors?.data?.ConstructorStandings?.length){content.season.constructors={data:{ConstructorStandings:[{Constructor:{name:'示例车队'},points:'200'}]}};mark('constructors');}
  if((content.news?.data||[]).length<3){
    content.news||={};content.news.data||=[];
    while(content.news.data.length<3){content.news.data.push({title:['赛前新闻标题示例 · 车队备战比赛周','赛前新闻标题示例 · 轮胎与天气','赛前新闻标题示例 · 围场动态'][content.news.data.length],url:'https://www.skysports.com/f1/news',publishedAt:content.race.date+'T12:00:00Z'});}mark('news');
  }
  content.sampleBlocks=sampleBlocks;return content;
}
export async function collectF1Sample({service,now=Date.now()}) {
  const year=new Date(now+8*3600_000).getUTCFullYear();let season,race;
  for(const value of [year,year-1]){
    const candidate=await service.season(value);
    const completed=(candidate.schedule?.data||[]).filter(r=>sessionTime(r)+3*3600_000<=now).sort((a,b)=>sessionTime(b)-sessionTime(a));
    if(completed.length){season=candidate;race=completed[0];break;}
  }
  if(!race)throw Error('最近比赛周末暂时无法获取');
  return completeF1Sample(await collectF1Email({service,season,race,now}));
}
