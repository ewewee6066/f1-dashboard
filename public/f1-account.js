(() => {
  const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dialog=$('#f1-settings-dialog'),body=$('#f1-settings-body');
  let session=null,preferences=null,subscription=null,standings=null,identityVersion=0,waiting=false;
  const title=value=>{$('#f1-settings-title').textContent=value;};
  const notify=()=>{const button=$('#f1-login');if(button){button.textContent=session?.authenticated?'账号':'登录';button.setAttribute('aria-label',session?.authenticated?'管理当前账号':'登录账号');}window.dispatchEvent(new Event('f1-preferences-change'));};
  const choiceOptions=(rows,key,label,current)=>'<option value="">未设置</option>'+rows.map(r=>`<option value="${esc(key(r))}" ${key(r)===current?'selected':''}>${esc(label(r))}</option>`).join('')+(current&&!rows.some(r=>key(r)===current)?`<option value="${esc(current)}" selected>${esc(current)}（本赛季暂无积分记录）</option>`:'');
  async function api(url,options={}) {
    const headers={};if(options.body){headers['Content-Type']='application/json';headers['X-CSRF-Token']=session?.csrf||'';options={...options,body:JSON.stringify(options.body)};}
    const response=await fetch(url,{...options,headers,cache:'no-store',signal:AbortSignal.timeout(15000)}),result=await response.json();
    if(!response.ok)throw Object.assign(new Error(result.error||'暂时无法获取，请重试'),{status:response.status});return result;
  }
  async function sync() {
    const token=++identityVersion;
    try {
      const next=await api('/api/session'),prefs=next.authenticated?await api('/api/account/f1-preferences'):null,sub=next.authenticated?await api('/api/account/f1-subscription'):null;
      if(token!==identityVersion)return;session=next;preferences=prefs;subscription=sub;notify();
    }catch(e){if(token===identityVersion){session=null;preferences=null;subscription=null;notify();}throw e;}
  }
  function error(e){const target=$('#f1-settings-error');if(target)target.textContent=e.message;}
  function form() {
    title('看板设置');
    waiting=false;
    const drivers=standings?.drivers?.data?.DriverStandings||[],teams=standings?.constructors?.data?.ConstructorStandings||[];
    waiting=!drivers.length||!teams.length;
    const options=choiceOptions;
    body.innerHTML=`<p class="f1-note">${esc(session.user.name)} · 偏好保存到你的账号</p><form id="f1-preferences-form"><label>喜欢的车手<span class="f1-setting-select"><select name="driverId">${options(drivers,r=>r.Driver.driverId,r=>`${r.Driver.givenName} ${r.Driver.familyName}`,preferences?.driverId)}</select></span></label><label>主队<span class="f1-setting-select"><select name="constructorId">${options(teams,r=>r.Constructor.constructorId,r=>r.Constructor.name,preferences?.constructorId)}</select></span></label><p class="f1-note">与领跑者相同时以绿色标记；其他选择会在领跑者下方显示名称和积分。</p><p id="f1-settings-error" class="f1-warning" role="alert"></p><div class="f1-settings-actions"><button class="btn btn-primary" type="submit">保存设置</button><button class="btn" type="button" id="f1-settings-cancel">取消</button></div></form>`;
    subscriptionForm();
    $('#f1-settings-cancel').onclick=()=>dialog.close();
    $('#f1-preferences-form').onsubmit=async ev=>{
      ev.preventDefault();const f=ev.currentTarget,button=f.querySelector('[type=submit]');button.disabled=true;
      try{const owner=session?.user?.id;await sync();if(!session?.authenticated){login();return;}if(owner!==session.user.id){form();throw Error('登录账号已改变，请重新选择');}preferences=await api('/api/account/f1-preferences',{method:'PUT',body:{driverId:f.elements.driverId.value||null,constructorId:f.elements.constructorId.value||null}});notify();dialog.close();}
      catch(e){if(e.status===401)login();else error(e);}finally{button.disabled=false;}
    };
  }
  function subscriptionForm() {
    const sub=subscription||{},addresses=sub.emails||[],ready=sub.available&&addresses.length>0;
    body.insertAdjacentHTML('beforeend',`<form id="f1-subscription-form"><h3>订阅比赛</h3><p class="f1-note">比赛周周四 09:00 发送“欢迎来到比赛周”；所选场次开赛前 30 分钟发送赛前资讯。时间均为北京时间。</p><label class="f1-check"><input type="checkbox" name="enabled" ${sub.enabled?'checked':''} ${ready?'':'disabled'}>开启比赛邮件订阅</label>${addresses.length?`<label>收件邮箱<select name="emailId">${addresses.map(e=>`<option value="${esc(e.id)}" ${e.id===sub.emailId?'selected':''}>${esc(e.email)}</option>`).join('')}</select></label>`:'<p class="f1-note">请先绑定并验证邮箱，才能开启订阅。</p>'}${!sub.available?'<p class="f1-note">比赛邮件暂时不可用。</p>':''}<fieldset><legend>订阅内容</legend>${Object.entries({practice:'练习赛（一练、二练、三练）',qualifying:'排位赛',sprint:'冲刺赛',sprintQualifying:'冲刺赛排位赛',race:'正赛'}).map(([key,label])=>`<label class="f1-check"><input type="checkbox" name="kinds" value="${key}" ${sub.kinds?.includes(key)?'checked':''}>${label}</label>`).join('')}</fieldset><p class="f1-note">开启时发送一封上一比赛周末的完整测试邮件；缺少的板块会明确标注为排版示例。邮件包含赛程、比赛手册、最新新闻和赛果。解绑收件邮箱会自动关闭订阅。</p><p id="f1-subscription-status" role="status" class="f1-note">${sub.enabled&&sub.testEmailStatus==='sent'?'开启后的测试邮件已发送。':sub.enabled&&sub.testEmailStatus==='failed'?'测试邮件未发送成功；关闭后重新开启可重试。':''}</p><button class="btn btn-primary" type="submit">保存订阅</button> ${session?.methods?.email?'<button class="btn" id="f1-bind-email" type="button">绑定邮箱</button>':''} <button class="btn" id="f1-account-open" type="button">管理账号</button></form>`);
    $('#f1-subscription-form').onsubmit=async ev=>{
      ev.preventDefault();const f=ev.currentTarget,button=f.querySelector('[type=submit]'),status=$('#f1-subscription-status'),owner=session?.user?.id;
      const choice={enabled:f.elements.enabled.checked,emailId:f.elements.emailId?.value||null,kinds:[...f.querySelectorAll('[name=kinds]:checked')].map(e=>e.value)};
      button.disabled=true;status.textContent='';
      try{await sync();if(owner!==session?.user?.id){login();return;}subscription=await api('/api/account/f1-subscription',{method:'PUT',body:choice});status.textContent=subscription.enabled?(subscription.testEmailStatus==='queued'||subscription.testEmailStatus==='sending'?'订阅已开启，测试邮件正在发送。':subscription.testEmailStatus==='sent'?'订阅已开启，测试邮件已发送。':subscription.testEmailStatus==='retry'?'订阅已开启，测试邮件发送失败，将自动重试。':subscription.testEmailStatus==='failed'?'订阅已开启，测试邮件未发送成功；关闭后重新开启可重试。':'订阅已开启。'):'订阅已关闭。';}
      catch(e){status.textContent=e.message;}finally{button.disabled=false;}
    };
    if($('#f1-bind-email'))$('#f1-bind-email').onclick=bindEmail;
    $('#f1-account-open').onclick=accountSettings;
  }
  function bindEmail() {
    title('绑定邮箱');
    waiting=false;
    body.innerHTML=`<h3>绑定收件邮箱</h3><p class="f1-note">验证后可用于登录和接收比赛邮件。</p><form id="f1-bind-request"><label>邮箱地址<input name="email" type="email" required maxlength="254" autocomplete="email"></label><button class="btn" type="submit">发送验证码</button></form><form id="f1-bind-verify" hidden><label>六位验证码<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button class="btn btn-primary" type="submit">验证并绑定</button></form><p id="f1-settings-error" class="f1-warning" role="alert"></p><button class="btn" id="f1-bind-back">返回设置</button>`;
    let requestId='',retryAt=0;const run=async(button,action)=>{button.disabled=true;try{$('#f1-settings-error').textContent='';await action();}catch(e){error(e);}finally{button.disabled=false;}};
    $('#f1-bind-back').onclick=open;
    $('#f1-bind-request').onsubmit=ev=>{ev.preventDefault();const f=ev.currentTarget;run(f.querySelector('button'),async()=>{
      if(Date.now()<retryAt)throw Error(`请在 ${Math.ceil((retryAt-Date.now())/1000)} 秒后重试`);
      const r=await api('/api/auth/email/request',{method:'POST',body:{intent:'link',email:f.elements.email.value,returnTo:'/f1?settings=1'}});requestId=r.requestId;retryAt=Date.now()+r.retryAfter*1000;$('#f1-bind-verify').hidden=false;$('#f1-bind-verify').elements.code.focus();
    });};
    $('#f1-bind-verify').onsubmit=ev=>{ev.preventDefault();const f=ev.currentTarget;run(f.querySelector('button'),async()=>{await api('/api/auth/email/verify',{method:'POST',body:{requestId,code:f.elements.code.value}});await open();});};
  }

  async function accountSettings() {
    title('账号设置');
    waiting=false;
    try {
      const account=await api('/api/account');
      body.innerHTML=`<h3>你的账号</h3><form id="f1-account-name"><label>昵称<input name="name" required maxlength="40" value="${esc(account.user.name)}" autocomplete="nickname"></label><button class="btn" type="submit">保存昵称</button></form><h3>登录方式</h3><p class="f1-note">邮箱与登录标识只对当前账号显示。管理登录方式需要最近五分钟内验证身份。</p>${account.identities.map(i=>`<p>${esc(i.provider)} · ${esc(i.subject)} <button class="btn btn-small" data-unlink="${esc(i.id)}">移除</button></p>`).join('')}<div class="f1-settings-actions">${session.methods.email?'<button class="btn" id="f1-account-email">绑定邮箱</button>':''}${['github','google'].filter(k=>session.methods[k]).map(k=>`<button class="btn" data-link="${k}">绑定 ${k}</button>`).join('')}<button class="btn" id="f1-account-reauth">重新验证身份</button></div><form id="f1-account-password"><h3>设置或修改密码</h3><p class="f1-note">先绑定邮箱。密码为 15–128 个字符。</p>${account.passwordSet&&account.passwordNeedsCurrent?'<label>当前密码<input type="password" name="currentPassword" autocomplete="current-password" required></label>':''}<label>新密码<input type="password" name="password" minlength="15" maxlength="128" autocomplete="new-password" required></label><button class="btn" type="submit">保存密码</button></form><h3>通行密钥</h3>${account.passkeys.map(k=>`<p>${esc(k.name)} <button class="btn btn-small" data-key-remove="${esc(k.id)}">移除</button></p>`).join('')}${session.methods.passkey?'<button class="btn" id="f1-account-passkey">添加通行密钥</button>':''}<div class="f1-settings-actions"><button class="btn" id="f1-account-logout">退出当前设备</button><button class="btn" id="f1-account-logout-all">退出所有设备</button></div>${account.user.role!=='admin'?'<form id="f1-account-delete"><label>注销账号（删除账号与订阅）<input name="confirmation" placeholder="输入：注销账号" required></label><button class="btn" type="submit">注销账号</button></form>':''}<p id="f1-settings-error" class="f1-warning" role="alert"></p><button class="btn" id="f1-account-back">返回看板设置</button>`;
      const run=async(button,action)=>{button.disabled=true;try{await action();}catch(e){if(e.status===428){login('reauth');return;}error(e);}finally{button.disabled=false;}};
      $('#f1-account-back').onclick=open;
      $('#f1-account-reauth').onclick=()=>login('reauth');
      if($('#f1-account-email'))$('#f1-account-email').onclick=bindEmail;
      $('#f1-account-name').onsubmit=ev=>{ev.preventDefault();const f=ev.currentTarget;run(f.querySelector('button'),async()=>{await api('/api/account',{method:'PATCH',body:{name:f.elements.name.value}});await sync();await accountSettings();});};
      $('#f1-account-password').onsubmit=ev=>{ev.preventDefault();const f=ev.currentTarget;run(f.querySelector('button'),async()=>{await api('/api/account/password',{method:'PUT',body:{password:f.elements.password.value,currentPassword:f.elements.currentPassword?.value}});f.reset();await sync();await accountSettings();});};
      for(const b of body.querySelectorAll('[data-unlink]'))b.onclick=()=>run(b,async()=>{await api('/api/account/identities/'+encodeURIComponent(b.dataset.unlink),{method:'DELETE',body:{}});await sync();await accountSettings();});
      for(const b of body.querySelectorAll('[data-key-remove]'))b.onclick=()=>run(b,async()=>{await api('/api/account/passkeys/'+encodeURIComponent(b.dataset.keyRemove),{method:'DELETE',body:{}});await accountSettings();});
      for(const b of body.querySelectorAll('[data-link]'))b.onclick=()=>run(b,async()=>{const r=await api('/api/auth/'+b.dataset.link+'/start',{method:'POST',body:{intent:'link',returnTo:'/f1?settings=1'}});location.assign(r.url);});
      for(const kind of ['logout','logout-all'])$('#f1-account-'+kind).onclick=ev=>run(ev.currentTarget,async()=>{await api('/api/'+kind,{method:'POST',body:{}});await sync();login();});
      if($('#f1-account-delete'))$('#f1-account-delete').onsubmit=ev=>{ev.preventDefault();const f=ev.currentTarget;run(f.querySelector('button'),async()=>{await api('/api/account',{method:'DELETE',body:{confirmation:f.elements.confirmation.value}});await sync();login();});};
      if($('#f1-account-passkey'))$('#f1-account-passkey').onclick=ev=>run(ev.currentTarget,async()=>{
        if(!window.PublicKeyCredential||!window.isSecureContext)throw Error('当前浏览器不支持通行密钥');
        if(!window.SimpleWebAuthnBrowser)await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/vendor/simplewebauthn.js';s.onload=resolve;s.onerror=()=>{s.remove();reject(Error('登录组件加载失败'));};document.head.append(s);});
        const r=await api('/api/auth/passkey/register/options',{method:'POST',body:{name:'我的通行密钥'}});
        const response=await window.SimpleWebAuthnBrowser.startRegistration({optionsJSON:r.options});
        await api('/api/auth/passkey/register/verify',{method:'POST',body:{requestId:r.requestId,response}});await accountSettings();
      });
    }catch(e){error(e);}
  }

  function login(intent='login') {
    title(intent==='reauth'?'重新验证身份':'登录账号');
    waiting=false;const methods=session?.methods||{};
    body.innerHTML=`<p class="f1-note">请先登录，才能设置主队、喜欢的车手和比赛订阅。</p><label class="f1-remember"><input type="checkbox" id="f1-remember"><span>记住这台设备</span></label><div class="f1-settings-actions">${methods.github?'<button class="btn" data-f1-login="github">GitHub 登录 ↗</button>':''}${methods.google?'<button class="btn" data-f1-login="google">Google 登录 ↗</button>':''}${methods.passkey?'<button class="btn" id="f1-passkey-login">通行密钥登录</button>':''}</div>${methods.email&&methods.password?'<div class="f1-login-switch" aria-label="选择登录方式"><button class="btn" type="button" data-login-panel="email">邮箱验证码</button><button class="btn" type="button" data-login-panel="password">邮箱密码</button></div>':''}${methods.password?'<div id="f1-password-panel"><form id="f1-password-login"><label>邮箱地址<input name="email" type="email" autocomplete="username" required maxlength="254"></label><label>密码<input name="password" type="password" autocomplete="current-password" required maxlength="512"></label><button class="btn btn-primary" type="submit">密码登录</button></form><p class="f1-note">适用于已绑定邮箱并设置密码的账号。</p></div>':''}${methods.email?'<div id="f1-email-panel"><p class="f1-note">首次使用也可通过邮箱验证码创建账号。</p><form id="f1-email-request"><label>邮箱地址<input name="email" type="email" autocomplete="email" required maxlength="254"></label><button class="btn" type="submit">发送登录验证码</button></form><form id="f1-email-verify" hidden><label>六位验证码<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button class="btn btn-primary" type="submit">验证并登录</button></form></div>':''}${!methods.email&&!methods.github&&!methods.google?'<p class="f1-note">本站暂未开放新账号注册，已有账号可使用已绑定的登录方式。</p>':''}<p id="f1-settings-error" class="f1-warning" role="alert"></p>`;
    const panels=body.querySelectorAll('[data-login-panel]');
    const showPanel=mode=>{for(const b of panels)b.setAttribute('aria-pressed',String(b.dataset.loginPanel===mode));if($('#f1-password-panel'))$('#f1-password-panel').hidden=mode!=='password';if($('#f1-email-panel'))$('#f1-email-panel').hidden=mode!=='email';};
    if(panels.length){for(const b of panels)b.onclick=()=>showPanel(b.dataset.loginPanel);showPanel('email');}
    const options=()=>({intent,remember:!!$('#f1-remember')?.checked,returnTo:'/f1?settings=1'});
    const run=async(button,action)=>{button.disabled=true;$('#f1-settings-error').textContent='';try{await action();}catch(e){error(e);}finally{button.disabled=false;}};
    const complete=async()=>{await sync();if(session?.authenticated&&dialog.open){if(intent==='reauth')await accountSettings();else form();}};
    for(const button of body.querySelectorAll('[data-f1-login]'))button.onclick=()=>run(button,async()=>{const r=await api(`/api/auth/${button.dataset.f1Login}/start`,{method:'POST',body:options()});location.assign(r.url);});
    if($('#f1-password-login'))$('#f1-password-login').onsubmit=ev=>{ev.preventDefault();const f=ev.currentTarget;run(f.querySelector('button'),async()=>{await api('/api/auth/password/login',{method:'POST',body:{...options(),email:f.elements.email.value,password:f.elements.password.value}});f.elements.password.value='';await complete();});};
    let requestId;
    if($('#f1-email-request'))$('#f1-email-request').onsubmit=ev=>{ev.preventDefault();const f=ev.currentTarget;run(f.querySelector('button'),async()=>{const r=await api('/api/auth/email/request',{method:'POST',body:{...options(),email:f.elements.email.value}});requestId=r.requestId;$('#f1-email-verify').hidden=false;$('#f1-email-verify').elements.code.focus();});};
    if($('#f1-email-verify'))$('#f1-email-verify').onsubmit=ev=>{ev.preventDefault();const f=ev.currentTarget;run(f.querySelector('button'),async()=>{await api('/api/auth/email/verify',{method:'POST',body:{requestId,code:f.elements.code.value}});await complete();});};
    if($('#f1-passkey-login'))$('#f1-passkey-login').onclick=ev=>run(ev.currentTarget,async()=>{
      if(!window.PublicKeyCredential||!window.isSecureContext)throw Error('当前浏览器不支持通行密钥，请选择其他登录方式');
      const r=await api('/api/auth/passkey/login/options',{method:'POST',body:options()});
      if(!window.SimpleWebAuthnBrowser)await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/vendor/simplewebauthn.js';s.onload=resolve;s.onerror=()=>{s.remove();reject(Error('登录组件加载失败，请重试'));};document.head.append(s);});
      const response=await window.SimpleWebAuthnBrowser.startAuthentication({optionsJSON:r.options});await api('/api/auth/passkey/login/verify',{method:'POST',body:{requestId:r.requestId,response}});await complete();
    });
  }
  async function open(target='settings') {
    title(target==='account'?'账号设置':'看板设置');body.innerHTML='<p class="f1-note">正在读取账号设置…</p>';if(!dialog.open){dialog.showModal();document.documentElement.classList.add('f1-modal-open');}
    try{await sync();if(dialog.open)session?.authenticated?(target==='account'?await accountSettings():form()):login();}
    catch(e){if(dialog.open){body.innerHTML='<p id="f1-settings-error" class="f1-warning" role="alert"></p><button class="btn" id="f1-settings-retry">重试</button>';error(e);$('#f1-settings-retry').onclick=()=>open(target);}}
  }
  window.F1Account={get preferences(){return preferences;},setStandings(value){
    standings=value;
    if(waiting&&dialog.open&&session?.authenticated&&$('#f1-preferences-form')){
      const drivers=value?.drivers?.data?.DriverStandings||[],teams=value?.constructors?.data?.ConstructorStandings||[];
      const driver=body.querySelector('[name=driverId]'),team=body.querySelector('[name=constructorId]');
      if(drivers.length)driver.innerHTML=choiceOptions(drivers,r=>r.Driver.driverId,r=>`${r.Driver.givenName} ${r.Driver.familyName}`,driver.value);
      if(teams.length)team.innerHTML=choiceOptions(teams,r=>r.Constructor.constructorId,r=>r.Constructor.name,team.value);
      waiting=!drivers.length||!teams.length;
    }
  }};
  $('#f1-settings').onclick=()=>open();if($('#f1-login'))$('#f1-login').onclick=()=>open('account');$('#f1-settings-close').onclick=()=>dialog.close();
  dialog.addEventListener('click',e=>{const r=dialog.getBoundingClientRect();if(e.target===dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))dialog.close();});
  dialog.addEventListener('close',()=>{waiting=false;body.replaceChildren();if(!document.querySelector('dialog[open]'))document.documentElement.classList.remove('f1-modal-open');});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){const owner=session?.user?.id;sync().then(()=>{if(dialog.open&&owner!==session?.user?.id)session?.authenticated?form():login();}).catch(()=>{});}});
  if(new URLSearchParams(location.search).get('settings')==='1'){history.replaceState(null,'','/f1');open();}else sync().catch(()=>{});
})();
