import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import{tmpdir}from'node:os';import{join}from'node:path';
import{parseOfficialResult,findOfficialResult,createOfficialResults}from'../f1-results.mjs';
import{createF1Service}from'../f1.mjs';
const html=readFileSync(new URL('./fixtures/f1-briefing/official-results.html',import.meta.url),'utf8');
const race={round:'16',date:'2026-10-04',time:'07:00:00Z',Circuit:{circuitId:'sepang',circuitName:'Sepang International Circuit'}};
const link='/en/results/2026/races/9988/bahrain/race-result',hub=`<a href="${link}">Results</a>`;
const parsed=parseOfficialResult(html,race,2026);
assert.equal(parsed.rows.length,22);assert.equal(parsed.provisional,true);
assert.deepEqual(parsed.rows.slice(0,3).map(r=>r.Driver.familyName),['Verstappen','Antonelli','Hamilton']);
assert.equal(parsed.rows.at(-1).positionText,'NC');
assert.throws(()=>parseOfficialResult(html,{...race,date:'2026-10-11'},2026));
assert.throws(()=>parseOfficialResult(html,{...race,Circuit:{circuitName:'Other Circuit'}},2026));
assert.throws(()=>parseOfficialResult(html,race,2025));
assert.equal(findOfficialResult(hub,2026,'bahrain'),'https://www.formula1.com'+link);
assert.equal(findOfficialResult(hub,2027,'bahrain'),null);
assert.equal(findOfficialResult(hub,2026,'singapore'),null);
let now=Date.parse('2026-10-04T12:00:00Z'),offline=false,calls=0;
const fetcher=async url=>{calls++;if(offline)throw Error('offline');return new Response(url.includes('/en/racing/')?hub:html);};
const dir=mkdtempSync(join(tmpdir(),'f1-results-'));
try{
 const source=createOfficialResults({dataDir:dir,fetcher,clock:()=>now});
 const [a,b]=await Promise.all([source.race(race,2026,'bahrain'),source.race(race,2026,'bahrain')]);
 assert.equal(calls,2);assert.equal(a.data[0].Results.length,22);assert.deepEqual(a,b);
 await source.race(race,2026,'bahrain');assert.equal(calls,2);
 now+=121000;offline=true;
 const stale=await createOfficialResults({dataDir:dir,fetcher,clock:()=>now}).race(race,2026,'bahrain');
 assert.equal(stale.stale,true);assert.equal(stale.unavailable,false);assert.equal(stale.data[0].Results.length,22);
 offline=false;
 // A primary-source rate limit must not block the independently fetched official classification.
 const service=createF1Service({clock:()=>now,spacing:0,fetcher:async url=>{
  if(url.includes('jolpi.ca'))return url.includes('/results/')?new Response('',{status:429}):Response.json({MRData:{total:'1',RaceTable:{Races:[race]}}});
  return fetcher(url);
 }});
 await service.season(2026);
 const result=await service.race(2026,'16');
 assert.equal(result.source,'Formula 1 官网');assert.equal(result.provisional,true);assert.equal(result.data[0].Results.length,22);
 const nextRace={...race,round:'17',date:'2026-10-11',Circuit:{circuitId:'marina_bay',circuitName:'Marina Bay Street Circuit'}};
 now=Date.parse('2026-10-11T12:00:00Z');
 const next=createOfficialResults({clock:()=>now,fetcher:async url=>new Response(url.includes('/en/racing/')?'<a href="/en/results/2026/races/9999/singapore/race-result">Results</a>':html.replaceAll('Sepang International Circuit','Marina Bay Street Circuit').replace('04 Oct','11 Oct').replace('BAHRAIN','SINGAPORE'))});
 assert.equal((await next.race(nextRace,2026,'singapore')).data[0].round,'17');
 const future=await next.race({...nextRace,date:'2026-10-18'},2026,'singapore');assert.equal(future.data,null);
 console.log('PASS: official classification parsing, event/date validation, dynamic next-round discovery, shared requests, persistence, offline recovery and independent fallback during primary rate limits');
}finally{rmSync(dir,{recursive:true,force:true});}
