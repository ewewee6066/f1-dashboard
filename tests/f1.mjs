import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createF1Service } from '../f1.mjs';
const dir = mkdtempSync(join(tmpdir(), 'paddock-f1-test-'));
let now = Date.UTC(2026, 9, 2), calls = [], failure = false, throttle = false;
const fetcher = async (url, options) => {
  calls.push(url);
  assert.match(options.headers['User-Agent'], /f1-paddock/);
  if (failure) throw new Error('offline');
  if (throttle) return new Response('', {status:429,headers:{'retry-after':'90'}});
  const path = new URL(url).pathname;
  const table = path.includes('standings') ? {StandingsTable:{StandingsLists:[{season:'2026',round:'15',DriverStandings:[{points:'300'}],ConstructorStandings:[{points:'500'}]}]}} : {RaceTable:{Races:[{round:'15',date:'2026-09-20',Results:[{position:'1'}]}]}};
  return Response.json({MRData:{total:'1', ...table}});
};
try {
  const service = createF1Service({dataDir:dir,fetcher,clock:()=>now,spacing:0});
  const [a,b] = await Promise.all([service.season('current'),service.season('2026')]);
  assert.equal(calls.length,4,'concurrent requests share cache refresh');
  assert.equal(a.season,2026); assert.equal(b.drivers.data.round,'15');
  await service.season('2026'); assert.equal(calls.length,4,'fresh cache avoids upstream calls');
  for (const value of ['../2026','1949','2030','NaN']) await assert.rejects(()=>service.season(value),e=>e.status===400);
  for (const round of ['0','31','1/../2','1.1']) await assert.rejects(()=>service.race('2026',round),e=>e.status===400);
  await assert.rejects(()=>service.race('2026','1','../results'),e=>e.status===400);
  const race=await service.race('2026','15'); assert.equal(race.data[0].round,'15');
  now+=16*60_000; failure=true;
  const cached=await service.season('2026'); assert.equal(cached.schedule.stale,true); assert.equal(cached.schedule.unavailable,false); assert.equal(cached.drivers.data.DriverStandings[0].points,'300');
  const afterFailure=calls.length;await service.season('2026');assert.equal(calls.length,afterFailure,'failure backoff');
  const reloaded=createF1Service({dataDir:dir,fetcher,clock:()=>now,spacing:0});
  assert.equal((await reloaded.season('2026')).schedule.stale,true,'disk cache survives restart');
  const missing=await service.race('2026','1','sprint'); assert.equal(missing.unavailable,true); assert.equal(missing.data,null);
  failure=false;throttle=true;now+=61_000;
  const before=calls.length;await service.season('2025');assert.equal(calls.length,before+1,'429 prevents queued requests');
  now+=91_000;throttle=false;
  assert.equal((await service.season('2025')).schedule.stale,false,'rate limit recovery');
  const empty=createF1Service({fetcher:async()=>Response.json({MRData:{total:'0',RaceTable:{Races:[]}}}),spacing:0});
  assert.deepEqual((await empty.race('2026','1')).data,[],'unpublished results remain empty');
  const malformed=createF1Service({fetcher:async()=>Response.json({MRData:{total:'0'}}),spacing:0});
  assert.equal((await malformed.race('2026','1')).unavailable,true,'malformed response rejected');
  const alphaCalls = [];
  let alphaOffline = false;
  const alpha = createF1Service({clock:()=>now, spacing:0, fetcher:async url => {
    alphaCalls.push(url);
    if (alphaOffline) throw new Error('offline');
    return Response.json({data:url.includes('/schedules/') ? {events:[{round:{number:2,id:'round_test'},schedule:[{code:'SQ'},{code:'FP1'}]}]} : {results:[
      {position:1,position_text:'1',time:'1:31.504',laps:23,driver:{given_name:'Lewis',family_name:'Hamilton'},team:{name:'Ferrari'},components:{SQ1:{time:'1:31.212'},SQ2:{time:'1:31.384'},SQ3:{time:'1:30.849'}}}
    ]}});
  }});
  const sq = await alpha.race('2025','2','sprintQualifying');
  assert.equal(sq.data[0].QualifyingResults[0].Driver.familyName,'Hamilton');
  assert.equal(sq.data[0].QualifyingResults[0].Q3,'1:30.849');
  assert.equal(sq.data[0].QualifyingResults[0].Constructor.name,'Ferrari');
  await alpha.race('2025','2','sprintQualifying'); assert.equal(alphaCalls.length,2,'sprint qualifying shares persistent cache');
  const practice=await alpha.race('2025','2','practice1');
  assert.equal(practice.data[0].PracticeResults[0].Time.time,'1:31.504');
  assert.equal(practice.data[0].PracticeResults[0].laps,23);
  assert(alphaCalls.at(-1).endsWith('/FP1/'));
  for (const session of ['practice2','practice3']) assert.deepEqual((await alpha.race('2025','2',session)).data,[],'absent practice session stays empty');
  assert.deepEqual((await alpha.race('2025','1','sprintQualifying')).data,[],'non sprint weekend has no sprint qualifying');
  now+=16*60_000; alphaOffline=true;
  const staleSQ=await alpha.race('2025','2','sprintQualifying');
  assert.equal(staleSQ.stale,true); assert.equal(staleSQ.data[0].QualifyingResults[0].Q3,'1:30.849','offline keeps actual qualifying results');
  console.log('PASS: cache, concurrency, persistence, offline fallback, 429 recovery, validation, unpublished results');
} finally {rmSync(dir,{recursive:true,force:true});}
