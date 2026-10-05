import nodemailer from 'nodemailer';
import {randomUUID} from 'node:crypto';
import {collectF1Sample} from './f1-sample.mjs';
import {sessionsFor,welcomeTime,subscriptionKinds} from './f1-sessions.mjs';
import {collectF1Email,renderF1Email} from './f1-email.mjs';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export function createF1Subscriptions({db,requireUser,jsonBody,send,service,origin,clock=Date.now,mailer,autoStart=true}) {
  const available=mailer!==undefined?!!mailer:!!(process.env.SMTP_HOST&&process.env.MAIL_FROM);
  if(mailer===undefined)mailer=available?nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_SECURE==='true',requireTLS:process.env.NODE_ENV!=='test'&&process.env.SMTP_SECURE!=='true',auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined,connectionTimeout:10000,socketTimeout:15000}):null;
  db.exec(`CREATE TABLE IF NOT EXISTS f1_subscriptions (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,email_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,enabled INTEGER NOT NULL DEFAULT 0,kinds TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS f1_mail_deliveries (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,event_key TEXT NOT NULL,status TEXT NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,sent_at INTEGER,PRIMARY KEY(user_id,event_key));
    CREATE TABLE IF NOT EXISTS f1_test_mail_jobs (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,email_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,activation_id TEXT NOT NULL,status TEXT NOT NULL,queued_at INTEGER NOT NULL,next_attempt INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,sent_at INTEGER);`);
  const emails=uid=>db.prepare("SELECT id,subject AS email FROM identities WHERE user_id=? AND provider='email' ORDER BY id").all(uid);
  const read=uid=>{const row=db.prepare('SELECT * FROM f1_subscriptions WHERE user_id=?').get(uid);return {enabled:!!row?.enabled,kinds:row?JSON.parse(row.kinds):['race'],emailId:row?.email_id||emails(uid)[0]?.id||null,emails:emails(uid),available,testEmailStatus:db.prepare('SELECT status FROM f1_test_mail_jobs WHERE user_id=?').get(uid)?.status||null};};
  async function handle(req,res,url){
    if(url.pathname!=='/api/account/f1-subscription')return false;
    const s=requireUser(req);
    if(req.method==='GET')send(res,200,read(s.user_id));
    else if(req.method==='PUT'){
      const b=await jsonBody(req);
      if(!b||typeof b.enabled!=='boolean'||!Array.isArray(b.kinds)||b.kinds.length>5||b.kinds.some(k=>!Object.hasOwn(subscriptionKinds,k))||new Set(b.kinds).size!==b.kinds.length)fail(400,'请选择有效的订阅内容');
      if(b.enabled&&!b.kinds.length)fail(400,'请至少选择一种比赛');
      const email=emails(s.user_id).find(e=>e.id===b.emailId);
      if(b.enabled&&!email)fail(409,'请先绑定并验证收件邮箱');
      if(b.enabled&&!available)fail(503,'比赛邮件暂时无法启用');
      const previous=db.prepare('SELECT * FROM f1_subscriptions WHERE user_id=?').get(s.user_id);
      const activation=b.enabled&&(!previous?.enabled||previous.email_id!==email.id);
      db.exec('BEGIN IMMEDIATE');
      try {
        if(email)db.prepare(`INSERT INTO f1_subscriptions VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET email_id=excluded.email_id,enabled=excluded.enabled,kinds=excluded.kinds,created_at=excluded.created_at`).run(s.user_id,email.id,Number(b.enabled),JSON.stringify(b.kinds),activation?clock():previous?.created_at||clock());
        else db.prepare('UPDATE f1_subscriptions SET enabled=0 WHERE user_id=?').run(s.user_id);
        if(activation)db.prepare(`INSERT INTO f1_test_mail_jobs (user_id,email_id,activation_id,status,queued_at,next_attempt) VALUES (?,?,?,'queued',?,?) ON CONFLICT(user_id) DO UPDATE SET email_id=excluded.email_id,activation_id=excluded.activation_id,status='queued',queued_at=excluded.queued_at,next_attempt=excluded.next_attempt,attempts=0,sent_at=NULL`).run(s.user_id,email.id,randomUUID(),clock(),clock());
        else if(!b.enabled)db.prepare("DELETE FROM f1_test_mail_jobs WHERE user_id=? AND status!='sent'").run(s.user_id);
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
      send(res,200,read(s.user_id));
      if(activation&&autoStart)queueMicrotask(()=>tick().catch(()=>console.warn('F1 activation email unavailable')));
    }else send(res,405,{error:'不支持此操作'});return true;
  }
  const preferences=uid=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='f1_preferences'").get()?db.prepare('SELECT driver_id AS driverId,constructor_id AS constructorId FROM f1_preferences WHERE user_id=?').get(uid)||{}:{};
  async function processTestEmails(){
    const jobs=db.prepare(`SELECT j.*,i.subject AS email FROM f1_test_mail_jobs j JOIN f1_subscriptions s ON s.user_id=j.user_id AND s.email_id=j.email_id AND s.enabled=1 JOIN identities i ON i.id=j.email_id AND i.user_id=j.user_id AND i.provider='email' WHERE j.status IN ('queued','retry','sending') AND j.next_attempt<=? ORDER BY j.queued_at LIMIT 10`).all(clock());
    let content;
    for(const job of jobs){
      const claim=db.prepare("UPDATE f1_test_mail_jobs SET status='sending',next_attempt=?,attempts=attempts+1 WHERE user_id=? AND activation_id=? AND next_attempt<=? AND status IN ('queued','retry','sending')").run(clock()+10*60_000,job.user_id,job.activation_id,clock());
      if(!claim.changes)continue;
      try {
        content||=await collectF1Sample({service,now:clock()});
        const current=db.prepare(`SELECT i.subject AS email FROM f1_test_mail_jobs j JOIN f1_subscriptions s ON s.user_id=j.user_id AND s.email_id=j.email_id AND s.enabled=1 JOIN identities i ON i.id=j.email_id AND i.user_id=j.user_id AND i.provider='email' WHERE j.user_id=? AND j.activation_id=? AND j.status='sending'`).get(job.user_id,job.activation_id);
        if(!current||current.email!==job.email)continue;
        content.news=await service.news();
        await mailer.sendMail({from:process.env.MAIL_FROM,to:job.email,...renderF1Email(content,{type:'test',origin,preferences:preferences(job.user_id)})});
        db.prepare("UPDATE f1_test_mail_jobs SET status='sent',sent_at=?,next_attempt=0 WHERE user_id=? AND activation_id=?").run(clock(),job.user_id,job.activation_id);
      }catch{
        db.prepare("UPDATE f1_test_mail_jobs SET status=?,next_attempt=? WHERE user_id=? AND activation_id=?").run(job.attempts+1>=3?'failed':'retry',clock()+60_000,job.user_id,job.activation_id);
        console.warn('F1 activation test email failed');
      }
    }
  }
  let running=false;
  async function tick(){
    if(running||!available)return;running=true;
    try {
      await processTestEmails();
      const recipients=db.prepare(`SELECT s.*,i.subject AS email FROM f1_subscriptions s JOIN identities i ON i.id=s.email_id AND i.user_id=s.user_id AND i.provider='email' WHERE s.enabled=1`).all();if(!recipients.length)return;
      const now=clock(),year=new Date(now+8*3600_000).getUTCFullYear(),season=await service.season(year);
      // Never send reminders from an unavailable or stale schedule.
      if(season.schedule.stale||season.schedule.unavailable)return;
      for(const race of season.schedule.data||[]){
        const sessions=sessionsFor(race),welcome=welcomeTime(race),first=sessions.find(s=>Number.isFinite(s.at));
        const due=[];
        if(first&&now>=welcome&&now<welcome+15*3600_000&&now<first.at)due.push({type:'welcome',key:'welcome',due:welcome});
        for(const s of sessions)if(now>=s.at-30*60_000&&now<s.at-25*60_000)due.push({type:'preview',key:s.key,session:s,due:s.at-30*60_000});
        if(!due.length)continue;
        let content;
        for(const job of due)for(const recipient of recipients){
          const kinds=JSON.parse(recipient.kinds);
          if(job.type==='welcome'?!sessions.some(s=>kinds.includes(s.kind)):!kinds.includes(job.session.kind)||recipient.created_at>job.due)continue;
          const eventKey=`${year}:${race.round}:${race.date}:${job.key}`;
          const claim=db.prepare(`INSERT INTO f1_mail_deliveries (user_id,event_key,status,lease_until) VALUES (?,?,'sending',?) ON CONFLICT(user_id,event_key) DO UPDATE SET status='sending',lease_until=excluded.lease_until WHERE f1_mail_deliveries.status!='sent' AND f1_mail_deliveries.lease_until<=?`).run(recipient.user_id,eventKey,clock()+10*60_000,clock());
          if(!claim.changes)continue;
          try {
            content||=await collectF1Email({service,season,race,now:clock()});
            // Recheck consent and bound address after external data requests.
            const current=db.prepare(`SELECT s.* FROM f1_subscriptions s JOIN identities i ON i.id=s.email_id AND i.user_id=s.user_id AND i.provider='email' WHERE s.user_id=? AND s.enabled=1 AND s.email_id=? AND i.subject=?`).get(recipient.user_id,recipient.email_id,recipient.email);
            const stillSelected=current&&JSON.parse(current.kinds);
            if(!stillSelected||(job.type==='welcome'&&!sessions.some(s=>stillSelected.includes(s.kind)))||(job.type==='preview'&&!stillSelected.includes(job.session.kind))||job.type==='preview'&&clock()>=job.session.at){db.prepare('DELETE FROM f1_mail_deliveries WHERE user_id=? AND event_key=?').run(recipient.user_id,eventKey);continue;}
            content.news=await service.news();
            await mailer.sendMail({from:process.env.MAIL_FROM,to:recipient.email,...renderF1Email(content,{...job,origin,preferences:preferences(recipient.user_id)})});
            db.prepare("UPDATE f1_mail_deliveries SET status='sent',sent_at=?,lease_until=0 WHERE user_id=? AND event_key=?").run(clock(),recipient.user_id,eventKey);
          }catch{db.prepare("UPDATE f1_mail_deliveries SET status='retry',lease_until=? WHERE user_id=? AND event_key=?").run(clock()+60_000,recipient.user_id,eventKey);console.warn('F1 subscription email failed; retry scheduled');}
        }
      }
    }finally{running=false;}
  }
  let timer;if(autoStart){timer=setInterval(()=>tick().catch(()=>console.warn('F1 subscription scheduler unavailable')),30_000);timer.unref();tick().catch(()=>{});}
  return {handle,tick,stop(){clearInterval(timer);mailer?.close?.();}};
}
