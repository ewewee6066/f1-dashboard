export const subscriptionKinds={practice:'练习赛',qualifying:'排位赛',sprint:'冲刺赛',sprintQualifying:'冲刺赛排位赛',race:'正赛'};
export const resultKeys={practice1:'PracticeResults',practice2:'PracticeResults',practice3:'PracticeResults',qualifying:'QualifyingResults',sprint:'SprintResults',sprintQualifying:'QualifyingResults',race:'Results'};
export const sessionTime=s=>s?.date&&s?.time?Date.parse(`${s.date}T${s.time}`):NaN;
export function sessionsFor(race) {
  return [['practice1','一练',race.FirstPractice],['practice2','二练',race.SecondPractice],['practice3','三练',race.ThirdPractice],['sprintQualifying','冲刺赛排位赛',race.SprintQualifying||race.SprintShootout],['sprint','冲刺赛',race.Sprint],['qualifying','排位赛',race.Qualifying],['race','正赛',race]].filter(([, ,s])=>s?.date).map(([key,label,timing])=>({key,label,timing,kind:key.startsWith('practice')?'practice':key,at:sessionTime(timing)})).sort((a,b)=>a.at-b.at);
}
// Anchor the race week to the first session (also handles Saturday races).
export function welcomeTime(race) {
  const first=sessionsFor(race).find(s=>Number.isFinite(s.at));if(!first)return NaN;
  const local=new Date(first.at+8*3600_000),day=local.getUTCDay();
  local.setUTCDate(local.getUTCDate()-((day+3)%7));local.setUTCHours(9,0,0,0);return local.getTime()-8*3600_000;
}
