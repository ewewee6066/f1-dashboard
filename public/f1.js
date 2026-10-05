(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const currentYear = new Date().getUTCFullYear();
  const fmt = (date, time) => {
    if (!date) return '时间待定';
    const d = new Date(time ? `${date}T${time}` : `${date}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return '时间待定';
    return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', ...(time ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }) + (time ? '' : ' · 时间待定');
  };
  const updated = date => date ? new Date(date).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const driver = row => row?.Driver ? `${row.Driver.givenName} ${row.Driver.familyName}` : '待公布';
  const racesCN = { Australian:'澳大利亚', Chinese:'中国', Japanese:'日本', Bahrain:'巴林', 'Saudi Arabian':'沙特阿拉伯', Miami:'迈阿密', Canadian:'加拿大', Monaco:'摩纳哥', Barcelona:'巴塞罗那', Spanish:'西班牙', Austrian:'奥地利', British:'英国', Belgian:'比利时', Hungarian:'匈牙利', Dutch:'荷兰', Italian:'意大利', Azerbaijan:'阿塞拜疆', Singapore:'新加坡', 'United States':'美国', 'Mexico City':'墨西哥城', Brazilian:'巴西', 'São Paulo':'圣保罗', 'Las Vegas':'拉斯维加斯', Qatar:'卡塔尔', 'Abu Dhabi':'阿布扎比', 'Emilia Romagna':'艾米利亚-罗马涅', Portuguese:'葡萄牙', Turkish:'土耳其', French:'法国' };
  const raceName = race => { const name = race?.raceName || ''; const key = name.replace(/ Grand Prix$/, ''); return racesCN[key] ? `${racesCN[key]}大奖赛` : name; };
  const raceTime = race => new Date(`${race.date}T${race.time || '23:59:59Z'}`).getTime();
  let data = null, view = 'schedule', filter = 'all', scheduleExpanded = false, loadId = 0, resultId = 0, weekendId = 0, chosenRound = null, chosenSession = 'race';
  const sessionRows = { race: 'Results', qualifying: 'QualifyingResults', sprint: 'SprintResults', sprintQualifying: 'QualifyingResults', practice1: 'PracticeResults', practice2: 'PracticeResults', practice3: 'PracticeResults' };
  const weekendSessions = race => [
    ...(race?.Sprint ? [['sprintQualifying', '冲刺排位', race.SprintQualifying || race.SprintShootout], ['sprint', '冲刺赛', race.Sprint]] : []),
    ['qualifying', '排位赛', race?.Qualifying], ['race', '正赛', race]
  ];
  const resultSessions = race => [
    ...[['practice1','一练','FirstPractice'],['practice2','二练','SecondPractice'],['practice3','三练','ThirdPractice']]
      .filter(([, , key]) => race?.[key]).map(([key, label, timing]) => [key, label, race[timing]]),
    ...weekendSessions(race).filter(([key]) => key !== 'race')
  ].sort((a, b) => (a[2]?.date ? raceTime(a[2]) : Infinity) - (b[2]?.date ? raceTime(b[2]) : Infinity)).concat([['race', '正赛', race]]);
  let theme = 'system';
  try { theme = localStorage.getItem('paddock-theme') || 'system'; } catch {}
  if (!['system', 'light', 'dark'].includes(theme)) theme = 'system';
  const media = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    $('#theme-toggle').setAttribute('aria-label', `当前主题：${{system:'跟随系统',light:'浅色',dark:'深色'}[theme]}，点击切换`);
  }
  applyTheme(); media.addEventListener('change', applyTheme);
  $('#theme-toggle').onclick = () => { theme = {system:'light',light:'dark',dark:'system'}[theme]; try {localStorage.setItem('paddock-theme', theme);} catch {} applyTheme(); };
  $('#year').textContent = currentYear;
  for (let y = currentYear; y >= 2024; y--) $('#f1-season').add(new Option(`${y} 赛季`, y));
  $('#f1-season').value = String(currentYear);
  const parts = () => data ? [data.schedule, data.winners, data.drivers, data.constructors] : [];
  const winners = () => new Map((data?.winners.data || []).map(r => [String(r.round), r.Results?.[0]]));
  const nextRace = () => (data?.schedule.data || []).find(r => raceTime(r) > Date.now());
  function stateOf(race) { return winners().has(String(race.round)) ? 'completed' : raceTime(race) > Date.now() ? 'upcoming' : 'pending'; }
  const meta = part => part?.unavailable ? '暂时无法获取，请稍后重试' : `${part?.source ? part.source + ' · ' : ''}${part?.provisional ? '暂定成绩 · ' : ''}${part?.stale ? '缓存数据 · ' : ''}${part?.updatedAt ? '更新于 ' + updated(part.updatedAt) : ''}`;
  const empty = message => `<div class="f1-empty"><p>${esc(message)}</p></div>`;
  async function request(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '数据暂时无法获取');
    return body;
  }
  function favouriteCard(type, part) {
    const isDriver = type === 'driver', rows = part.data?.[isDriver ? 'DriverStandings' : 'ConstructorStandings'] || [];
    const favouriteId = window.F1Account?.preferences?.[isDriver ? 'driverId' : 'constructorId'];
    const id = row => isDriver ? row?.Driver?.driverId : row?.Constructor?.constructorId;
    const leader = rows[0], favourite = favouriteId ? rows.find(row => id(row) === favouriteId) : null;
    const same = !!leader && !!favouriteId && id(leader) === favouriteId;
    const name = row => isDriver ? driver(row) : row?.Constructor?.name;
    const rank = row => row ? `<small class="f1-rank" aria-label="积分榜第 ${esc(row.position || rows.indexOf(row) + 1)} 名">P${esc(row.position || rows.indexOf(row) + 1)}</small>` : '';
    const extra = same ? `<div class="f1-favourite is-leading"><span><small>${isDriver ? '喜欢的车手' : '喜欢的车队'}</small><b>正在领跑积分榜</b></span></div>` : favouriteId ? `<div class="f1-favourite"><span><small>${isDriver ? '喜欢的车手' : '喜欢的车队'}</small><b>${esc(favourite ? name(favourite) : '本赛季暂无积分记录')}</b></span><strong>${favourite ? esc(favourite.points) + '<small>PTS</small>' + rank(favourite) : '<small>积分待公布</small>'}</strong></div>` : `<div class="f1-favourite is-unset"><span><small>${isDriver ? '喜欢的车手' : '喜欢的车队'}</small><b>未设置</b></span></div>`;
    const subtitle = isDriver ? leader?.Constructors?.map(c => c.name).join(' / ') : leader ? `${leader.wins} 场胜利` : '';
    return `<article class="f1-card${same ? ' f1-is-favourite' : ''}"><div class="f1-card-label">${isDriver ? 'WDC / 车手领跑者' : 'WCC / 车队领跑者'}</div><h2>${esc(leader ? name(leader) : '积分待公布')}</h2><p>${esc(subtitle || (part.unavailable ? '数据暂不可用' : '等待数据源更新'))}</p>${leader ? `<strong>${esc(leader.points)}<small>PTS</small>${rank(leader)}</strong><p>截至第 ${esc(part.data.round)} 站${part.stale ? ' · 缓存' : ''}</p>` : ''}${extra}</article>`;
  }
  function summary() {
    const next = nextRace(), done = data.winners.data?.length;
    const timings = next ? [['FirstPractice','一练'],['SecondPractice','二练'],['ThirdPractice','三练'],[next.SprintQualifying ? 'SprintQualifying' : 'SprintShootout','冲刺排位'],['Sprint','冲刺赛'],['Qualifying','排位赛']].filter(([key]) => next[key]?.date).sort((a,b) => raceTime(next[a[0]]) - raceTime(next[b[0]])) : [];
    const nextSessions = timings.length ? `<div class="f1-next-sessions" aria-label="下一站其他场次，北京时间">${timings.map(([key,label]) => `<div><span>${label}</span><time title="北京时间">${esc(fmt(next[key].date,next[key].time))}</time></div>`).join('')}</div>` : '';
    $('#f1-summary').innerHTML = `<article class="f1-card"><div class="f1-card-label">${next ? 'NEXT GRAND PRIX / 下一站' : 'SEASON / 赛季'}</div><h2>${next ? esc(raceName(next)) : data.schedule.unavailable ? '赛程暂不可用' : '等待后续赛程'}</h2><p>${next ? esc(next.Circuit?.circuitName) : '当前没有已公布的后续比赛'}</p><strong>${next ? esc(fmt(next.date, next.time)) : esc(data.season)}${next ? '<small>正赛</small>' : '<small>赛季</small>'}</strong><p>${next ? `第 ${esc(next.round)} 站 · 北京时间` : ''}${done != null ? ` · ${done} 站已公布成绩` : ''}</p>${nextSessions}</article>${favouriteCard('driver', data.drivers)}${favouriteCard('constructor', data.constructors)}`;
    window.F1Account?.setStandings(data);
  }
  window.addEventListener('f1-preferences-change', () => { if (data) summary(); });
  function circuitSVG(track, name) {
    const angle = (Number(track.rotation) || 0) * Math.PI / 180;
    const rotate = (x, y) => [x * Math.cos(angle) - y * Math.sin(angle), -(x * Math.sin(angle) + y * Math.cos(angle))];
    const points = track.x.map((x, i) => rotate(x, track.y[i]));
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const scale = Math.min(560 / Math.max(1, Math.max(...xs) - minX), 280 / Math.max(1, Math.max(...ys) - minY));
    const offsetX = (680 - (Math.max(...xs) - minX) * scale) / 2;
    const offsetY = (400 - (Math.max(...ys) - minY) * scale) / 2;
    const fit = ([x, y]) => [offsetX + (x - minX) * scale, offsetY + (y - minY) * scale];
    const line = points.map(fit);
    const labels = track.corners.filter(c => Number.isFinite(c.trackPosition?.x) && Number.isFinite(c.trackPosition?.y)).map(c => {
      const point = fit(rotate(c.trackPosition.x, c.trackPosition.y));
      const a = (Number(c.angle) || 0) * Math.PI / 180;
      const delta = rotate(Math.cos(a) * 26 / scale, Math.sin(a) * 26 / scale);
      return { point, x: point[0] + delta[0] * scale, y: point[1] + delta[1] * scale, number: String(c.number) + (c.letter || '') };
    });
    for (let pass = 0; pass < 30; pass++) for (let i = 0; i < labels.length; i++) {
      const a = labels[i];
      for (let j = i + 1; j < labels.length; j++) {
        const b = labels[j], dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy);
        if (distance < 31) { const push = (31 - distance) / 2; const ux = distance ? dx / distance : 1, uy = distance ? dy / distance : 0; a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push; }
      }
      a.x = Math.max(18, Math.min(662, a.x)); a.y = Math.max(18, Math.min(382, a.y));
    }
    return `<svg viewBox="0 0 680 400" role="img" aria-label="${esc(name)}赛道图，标注 ${labels.length} 个弯角"><title>${esc(name)} · 弯角编号</title><path class="f1-track-edge" d="M${line.map(p => p.map(n => n.toFixed(1)).join(',')).join(' L')} Z"/><path class="f1-track-line" d="M${line.map(p => p.map(n => n.toFixed(1)).join(',')).join(' L')} Z"/>${labels.map(l => `<g><title>第 ${esc(l.number)} 号弯</title><line class="f1-turn-leader" x1="${l.point[0]}" y1="${l.point[1]}" x2="${l.x}" y2="${l.y}"/><circle class="f1-turn-marker" cx="${l.x}" cy="${l.y}" r="13"/><text class="f1-turn-number" x="${l.x}" y="${l.y}" dy=".35em" text-anchor="middle">${esc(l.number)}</text></g>`).join('')}<circle class="f1-start-marker" cx="${line[0][0]}" cy="${line[0][1]}" r="6"><title>计时线</title></circle></svg>`;
  }
  const tyreNames = { HARD: ['H','硬胎'], MEDIUM: ['M','中性胎'], SOFT: ['S','软胎'] };
  const sourceLink = source => source?.url && /^https:\/\/(press\.pirelli\.com|www\.formula1\.com|www\.fia\.com|open-meteo\.com)\//.test(source.url) ? `<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.label)} ↗</a>` : '';
  // SVG path geometry from Formula 1 results UI: 990a3170-f6b3b654811a8397.js, Tyres*New.
  const tyreVectors = {"HARD": "<path fill=\"#15151E\" d=\"M8.188 15.8V8.3h2v2.84h3.55V8.3h2v7.5h-2v-2.91h-3.55v2.91z\"/><path fill=\"#F0F0EC\" fill-rule=\"evenodd\" d=\"m13.475 19.554.554 2.444a10.256 10.256 0 0 0 0-20l-.555 2.443a7.752 7.752 0 0 1 0 15.113m-2.95-15.108-.554-2.444a10.256 10.256 0 0 0 0 20l.555-2.443a7.752 7.752 0 0 1 0-15.113\" clip-rule=\"evenodd\"/>", "MEDIUM": "<path fill=\"#15151E\" d=\"m6.767 15.634.456-5.194c.135-1.56.891-2.19 1.996-2.19 1.182 0 1.87.756 2.064 2.006l.572 3.614c.029.155.077.233.203.233s.184-.097.204-.252l.552-3.605c.184-1.23.872-1.996 2.044-1.996 1.231 0 1.783.65 1.919 2.19l.456 5.194h-1.87l-.388-5.475c-.01-.126-.02-.233-.155-.233-.107 0-.165.097-.184.213l-.65 3.886c-.174 1.037-.843 1.725-1.938 1.725-1.133 0-1.802-.717-1.976-1.735l-.679-3.866c-.029-.145-.087-.223-.194-.223-.135 0-.164.097-.174.243l-.388 5.465z\"/><path fill=\"#FFD100\" fill-rule=\"evenodd\" d=\"M10.549 4.443 9.994 2a10.256 10.256 0 0 0 0 20l.555-2.443a7.752 7.752 0 0 1 0-15.113m2.949 15.114L14.052 22a10.256 10.256 0 0 0 0-20l-.554 2.443a7.752 7.752 0 0 1 0 15.113\" clip-rule=\"evenodd\"/>", "SOFT": "<path fill=\"#15151E\" d=\"m12.53 12.96-1.8-.53c-1.39-.41-2.04-1.14-2.04-2.14 0-1.26.91-2.04 2.52-2.04h3.85V9.9H11.2c-.43 0-.58.18-.58.37 0 .24.16.38.53.49l1.83.53c1.56.45 2.33 1.03 2.33 2.22 0 1.23-.92 2.24-2.88 2.24H8.89V14.1h3.84c.51 0 .68-.23.68-.5 0-.32-.19-.44-.88-.64\"/><path fill=\"#DA291C\" fill-rule=\"evenodd\" d=\"M10.549 4.443 9.994 2a10.256 10.256 0 0 0 0 20l.555-2.443a7.752 7.752 0 0 1 0-15.113m2.949 15.114L14.052 22a10.256 10.256 0 0 0 0-20l-.554 2.443a7.752 7.752 0 0 1 0 15.113\" clip-rule=\"evenodd\"/>"};
  const tyreIcon = type => `<svg class="f1-tyre tyre-${type.toLowerCase()}" viewBox="0 0 24 24" role="img" aria-label="${esc(tyreNames[type]?.[1] || type)}">${tyreVectors[type] || ""}</svg>`;
  const briefEmpty = text => `<p class="f1-brief-empty">${esc(text)}</p>`;
  function weatherDescription(code) {
    if (!Number.isFinite(code)) return '天气待更新';
    if (code >= 95) return '雷阵雨';
    if (code === 85 || code === 86) return '阵雪';
    if (code >= 80) return '阵雨';
    if (code >= 71) return '降雪';
    if (code >= 61) return '雨';
    if (code >= 51) return '毛毛雨';
    if (code >= 45) return '雾';
    return {0:'晴',1:'大致晴朗',2:'多云',3:'阴'}[code] || '天气变化';
  }
  async function showBriefing(race, season, valid) {
    const query = `season=${season}&round=${race.round}`;
    async function notes() {
      try {
        const result = await request(`/api/f1/notes?${query}`);
        if (!valid()) return;
        const notes = result.data, tyres = notes?.tyres, strategy = notes?.strategy, penalties = notes?.penalties, upgrades = notes?.upgrades;
        $('#f1-tyres-body').innerHTML = tyres ? `<div class="f1-compounds">${['SOFT','MEDIUM','HARD'].map(type => `<div>${tyreIcon(type)}<b>${esc(tyres[type.toLowerCase()])}</b><small>${tyreNames[type][1]}</small></div>`).join('')}</div>${tyres.note ? `<p class="f1-brief-text">${esc(tyres.note)}</p>` : ''}<p class="f1-brief-source">${sourceLink(tyres.source)} · <a href="https://www.formula1.com/en/results/2026/races/1308/bahrain/race-result" target="_blank" rel="noopener noreferrer">F1 官方轮胎图标 ↗</a></p>` : briefEmpty(result.unavailable ? '轮胎资料暂时无法获取。' : '官方配方发布后自动更新。');
        $('#f1-strategy-body').innerHTML = strategy ? `<div class="f1-strategies">${(strategy.options || []).map(option => `<div><span>${esc(option.label)}</span><span class="f1-strategy-chain">${option.sequence.filter(type => tyreNames[type]).map(tyreIcon).join('<i aria-hidden="true">→</i>')}</span></div>`).join('')}</div><p class="f1-brief-text">${esc(strategy.note)}</p><p class="f1-brief-source">${sourceLink(strategy.source)} · 赛前参考</p>` : briefEmpty(result.unavailable ? '策略资料暂时无法获取。' : '官方策略指南发布后自动更新。');
        $('#f1-penalties-body').innerHTML = penalties ? (penalties.items?.length ? `<ul class="f1-penalties">${penalties.items.map(item => `<li><div><b>${esc(item.driver)}</b><span>${esc(item.penalty)}</span></div><p>${esc(item.reason)}</p>${item.source ? `<p class="f1-brief-source">${sourceLink(item.source)}</p>` : ''}</li>`).join('')}</ul>` : briefEmpty('已核对资料中没有发车罚退。')) + `<p class="f1-brief-source">${sourceLink(penalties.source)}${penalties.grid && penalties.grid.url !== penalties.source?.url ? ' · ' + sourceLink(penalties.grid) : ''}</p>` : briefEmpty(result.unavailable ? '罚退资料暂时无法获取。' : '等待本场官方裁决或发车顺序；暂不能判断为无罚退。');
        const upgradeDetails = () => `<p class="f1-note">${esc(raceName(race))} · ${season} 赛季 · 第 ${esc(race.round)} 站</p><div class="f1-upgrades">${(upgrades.items || []).map(item => `<article class="f1-upgrade"><div class="f1-upgrade-heading"><h4>${esc(item.team)}</h4><span>${esc(item.category)}</span></div><p class="f1-upgrade-parts">${esc(item.parts)}</p>${item.summary ? `<p>${esc(item.summary)}</p>` : ''}</article>`).join('')}</div>${upgrades.noUpdates?.length ? `<p class="f1-brief-text">未申报更新：${esc(upgrades.noUpdates.join('、'))}。</p>` : ''}<p class="f1-brief-text">${esc(upgrades.note || '按官方申报整理；效果以实际比赛表现为准。')}</p><p class="f1-brief-source">${sourceLink(upgrades.source)}</p>`;
        $('#f1-upgrades-body').innerHTML = upgrades ? `<p class="f1-upgrade-count">${upgrades.items?.length || 0} 支车队申报更新</p><div class="f1-upgrade-teams">${(upgrades.items || []).map(item => `<span>${esc(item.team)}</span>`).join('')}</div><button id="f1-upgrades-open" class="btn btn-small" aria-haspopup="dialog" aria-controls="f1-upgrades-dialog">查看升级详情 ↗</button><p class="f1-brief-source">${sourceLink(upgrades.source)}</p>` : briefEmpty(result.unavailable ? '升级资料暂时无法获取。' : 'FIA 本场升级申报发布后自动更新。');
        if (upgrades) {
          const dialog = $('#f1-upgrades-dialog');
          if (dialog.open && dialog.dataset.event === `${season}:${race.round}`) $('#f1-upgrades-detail').innerHTML = upgradeDetails();
          $('#f1-upgrades-open').onclick = () => {
            dialog.dataset.event = `${season}:${race.round}`;
            $('#f1-upgrades-detail').innerHTML = upgradeDetails();
            dialog.showModal(); document.documentElement.classList.add('f1-modal-open');
          };
        }
        for (const id of ['tyres','strategy','penalties','upgrades']) {
          if (notes?.status?.[id] === 'stale' || notes?.status?.[id] === 'unavailable') $(`#f1-${id}-body`).insertAdjacentHTML('beforeend', briefEmpty(notes.status[id] === 'stale' ? '来源暂不可用，当前显示缓存资料。' : '来源暂不可用，将自动重试。'));
        }
        $('#f1-briefing-meta').textContent = notes?.checkedAt ? `自动更新 · ${updated(notes.checkedAt)}（北京时间）${result.stale ? ' · 部分来源待恢复' : ''}` : '官方资料发布后自动更新；天气独立刷新。';
      } catch {
        if (!valid()) return;
        for (const id of ['tyres','strategy','penalties','upgrades']) $(`#f1-${id}-body`).innerHTML = briefEmpty('资料暂时无法获取，请稍后刷新。');
      }
    }
    async function weather() {
      try {
        const result = await request(`/api/f1/weather?${query}`);
        if (!valid()) return;
        const report = result.data;
        const number = value => Number.isFinite(value) ? Math.round(value) : '—';
        if (!report?.days?.some(day=>day.available)) {
          $('#f1-weather-body').innerHTML = briefEmpty(({forecast_pending:'本场尚未进入可用预报范围，临近比赛时更新。',past_weekend:'本场比赛已结束，当前不提供这三天的历史预报。',coordinates_missing:'赛道位置尚未公布，暂时无法查询天气。'}[result.reason]) || '天气数据暂时无法获取，请稍后刷新。');
          return;
        }
        $('#f1-weather-body').innerHTML = `<div class="f1-weather-days">${report.days.map(day => `<article class="f1-weather-day ${day.kind === 'past' ? 'is-past' : ''}"><div class="f1-weather-head"><span><b>${esc(day.date.slice(5).replace('-','/'))}</b> ${esc(day.sessionLabel)}</span><small>${day.kind === 'past' ? '已过日期' : '预报'}</small></div>${day.available ? `<div class="f1-weather-main"><span>${esc(weatherDescription(day.code))}</span><b title="气温">${number(day.temperatureMin)}–${number(day.temperatureMax)}°C</b><span class="f1-rain">降雨 ${number(day.rainChance)}%</span></div><details class="f1-inline-details f1-weather-extra"><summary>时段、雨量与阵风</summary><p class="f1-weather-detail">${day.scope === 'session' ? '场次时段 ' + esc(day.period) : '全天数据'}${Number.isFinite(day.rainMm) ? ' · 雨量 ' + day.rainMm.toFixed(1) + ' mm' : ''} · 阵风 ${number(day.gust)} km/h</p></details>${day.impact?.length ? `<p class="f1-weather-impact">${esc(day.impact.join('；'))}</p>` : ''}` : briefEmpty('这一天的天气数据尚未提供。')}</article>`).join('')}</div><p class="f1-brief-source"><a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo ↗</a> · ${report.days.some(day=>day.scope==='session') ? '场次时段最高降雨概率' : '全天最高降雨概率'} · 时段为赛道当地时间（${esc(report.timezone)}）${result.updatedAt ? ' · ' + (result.stale ? '缓存 · ' : '') + '获取于 ' + updated(result.updatedAt) + '（北京时间）' : ''} · 已过日期为近期模型数据；预报可能变化。</p>`;
      } catch { if (valid()) $('#f1-weather-body').innerHTML = briefEmpty('天气数据暂时无法获取，请稍后刷新。'); }
    }
    async function news() {
      try {
        const result=await request('/api/f1/news');if(!valid())return;
        $('#f1-news-body').innerHTML=(result.data||[]).slice(0,3).map(item=>`<article class="f1-news-item"><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)} ↗</a><p class="f1-brief-source">Sky Sports · ${esc(updated(item.publishedAt))}（北京时间）</p></article>`).join('')||briefEmpty('天空体育新闻暂时无法获取，请稍后刷新。');
        $('#f1-news-body').insertAdjacentHTML('beforeend', `<p class="f1-brief-source"><a href="https://www.skysports.com/f1/news" target="_blank" rel="noopener noreferrer">天空体育 F1 ↗</a> · 每小时更新${result.updatedAt ? ' · 更新于 ' + esc(updated(result.updatedAt)) + '（北京时间）' : ''}</p>`);
        if(result.stale)$('#f1-news-body').insertAdjacentHTML('beforeend',briefEmpty('来源暂不可用，显示缓存资讯。'));
      }catch{if(valid())$('#f1-news-body').innerHTML=briefEmpty('天空体育新闻暂时无法获取，请稍后刷新。');}
    }
    await Promise.all([notes(),weather(),news()]);
  }
  async function showWeekendDetail(race, token, season) {
    const panel = $('#f1-weekend-detail');
    const upgradesDialog = $('#f1-upgrades-dialog');
    if (upgradesDialog.open && upgradesDialog.dataset.event !== `${season}:${race.round}`) upgradesDialog.close();
    panel.hidden = false;
    const infoBlock = (id, title, label, card = false) => `<section class="f1-info-block${card ? ' f1-detail-card f1-' + (id === 'news' ? 'headlines' : id) + '-card' : ''}" aria-labelledby="f1-${id}-title"><div class="f1-info-title"><h3 id="f1-${id}-title">${title}</h3><span>${label}</span></div><div id="f1-${id}-body">${briefEmpty('正在获取…')}</div></section>`;
    panel.innerHTML = `<article class="f1-track-card"><div class="f1-detail-heading"><div><p class="f1-kicker">CIRCUIT / 本场赛道</p><h2>${esc(race.Circuit?.circuitName)}</h2></div><button id="f1-map-enlarge" class="btn btn-small" disabled aria-haspopup="dialog" aria-controls="f1-map-dialog">放大地图 ↗</button></div><div id="f1-circuit-map" class="f1-circuit-map">${empty('正在获取赛道地图…')}</div><p id="f1-circuit-meta" class="f1-note"></p></article><aside class="f1-news-card" aria-label="本场轮胎配方与策略"><p class="f1-kicker">WEEKEND BRIEF / 比赛手册</p><h2>本场看点</h2><p class="f1-note">${esc(raceName(race))}</p>${infoBlock('tyres','轮胎配方','TYRES')}${infoBlock('strategy','轮胎策略','STRATEGY')}<p id="f1-briefing-meta" class="f1-brief-source"></p></aside>${infoBlock('weather','三天天气','WEATHER',true)}${infoBlock('penalties','发车罚退','GRID',true)}${infoBlock('upgrades','本场升级','CAR UPDATES',true)}${infoBlock('news','围场资讯','SKY SPORTS',true)}`;
    const valid = () => token === weekendId && data?.season === season;
    showBriefing(race, season, valid);
    try {
      const result = await request(`/api/f1/circuit?season=${season}&round=${race.round}`);
      if (!valid()) return;
      const track = result.data;
      const map = $('#f1-circuit-map');
      const official = track?.imageUrl && /^https:\/\/media\.formula1\.com\/image\/upload\//.test(track.imageUrl);
      map.innerHTML = official ? `<img src="/api/f1/circuit-map?season=${season}&amp;round=${race.round}" alt="${esc(race.Circuit?.circuitName)}官方赛道地图，标有弯号及 S1、S2、S3 计时分段" decoding="async">` : track?.x?.length ? circuitSVG(track, race.Circuit?.circuitName || raceName(race)) : empty(result.unavailable ? '赛道地图暂时无法获取，请稍后刷新。' : '本场赛道地图尚未发布。');
      if (official) {
        $('#f1-circuit-meta').innerHTML = `<a href="${esc(track.sourceUrl)}" target="_blank" rel="noopener noreferrer">Formula 1 官方赛道图 ↗</a> · 粉色 S1 / 黄色 S2 / 蓝色 S3${result.stale ? ' · 缓存数据' : ''}`;
        const img = map.querySelector('img');
        img.onerror = () => { if (valid() && !img.dataset.fallback) { img.dataset.fallback = 'true'; img.src = track.imageUrl; return; } if (valid()) { map.innerHTML = empty('地图图片暂时无法加载，请稍后刷新。'); $('#f1-map-enlarge').disabled = true; } };
      } else {
        $('#f1-circuit-meta').textContent = track?.x?.length ? 'MultiViewer · 弯角编号 · 计时分段图暂不可用' : '';
      }
      if (official || track?.x?.length) {
        $('#f1-map-enlarge').disabled = false;
        $('#f1-map-enlarge').onclick = () => {
          const dialog = $('#f1-map-dialog');
          $('#f1-map-title').textContent = race.Circuit?.circuitName || raceName(race);
          $('#f1-map-large').innerHTML = map.innerHTML;
          dialog.showModal(); document.documentElement.classList.add('f1-modal-open');
        };
      }
    } catch { if (valid()) $('#f1-circuit-map').innerHTML = empty('赛道地图暂时无法获取，请稍后刷新。'); }
  }
  async function showWeekend() {
    const token = ++weekendId, season = data.season, panel = $('#f1-weekend');
    const start = race => Math.min(...['FirstPractice', 'SprintQualifying', 'SprintShootout', 'Sprint', 'Qualifying'].map(key => race[key]).concat(race).filter(s => s?.date).map(raceTime));
    const race = (data.schedule.data || []).filter(r => start(r) <= Date.now()).sort((a, b) => start(b) - start(a))[0];
    if (!race) {
      $('#f1-weekend-detail').hidden = true;
      panel.innerHTML = empty(data.schedule.unavailable ? '最近比赛结果暂时无法获取，请稍后刷新。' : '本赛季比赛周末尚未开始，开赛后将在这里展示前三名。');
      return;
    }
    showWeekendDetail(race, token, season);
    const sessions = weekendSessions(race);
    const ongoing = raceTime(race) > Date.now() || !winners().has(String(race.round));
    panel.innerHTML = `<div class="f1-weekend-head"><div><p class="f1-kicker">${ongoing ? 'CURRENT WEEKEND / 当前比赛周末' : 'LATEST RESULTS / 最近比赛结果'}</p><h2>${esc(raceName(race))}</h2><p class="f1-note">${season} 赛季 · 第 ${esc(race.round)} 站 · ${esc(race.Circuit?.circuitName)}${race.Sprint ? ' · 冲刺周末' : ''}</p></div><span class="f1-badge">${ongoing ? '周末进行中 / 等待赛果' : '比赛已结束'}</span></div><div class="f1-podium-grid">${sessions.map(([key, label, timing]) => `<article class="f1-session-card"><div class="f1-session-heading"><h3>${label}<small>${key.includes('Qualifying') || key === 'qualifying' ? '前三名' : '领奖台'}</small></h3><p class="f1-note" title="北京时间">${esc(fmt(timing?.date, timing?.time))}</p></div><div id="f1-podium-${key}">${timing?.date && raceTime(timing) > Date.now() ? '<p class="f1-session-empty">尚未开赛</p>' : '<p class="f1-session-empty">正在获取成绩…</p>'}</div><div class="f1-session-footer"><p id="f1-session-meta-${key}" class="f1-note">等待更新</p><button class="btn btn-small" data-weekend-session="${key}" aria-haspopup="dialog" aria-controls="f1-results-dialog">完整成绩</button></div></article>`).join('')}</div><p class="f1-weekend-note">各场次成绩公布后更新；排位展示前三名，正赛与冲刺赛展示领奖台。</p>`;
    for (const button of panel.querySelectorAll('[data-weekend-session]')) button.onclick = () => {
      chosenRound = race.round; chosenSession = button.dataset.weekendSession; showResults(true);
    };
    await Promise.all(sessions.map(async ([key, , timing]) => {
      if (timing?.date && raceTime(timing) > Date.now()) return;
      try {
        const result = await request(`/api/f1/race?season=${season}&round=${race.round}&session=${key}`);
        if (token !== weekendId || data?.season !== season) return;
        const stamp = $(`#f1-session-meta-${key}`);
        stamp.textContent = meta(result); stamp.classList.toggle('f1-warning', result.stale || result.unavailable);
        const rows = result.data?.[0]?.[sessionRows[key]] || [];
        if (key === 'race' && rows.length) {
          const winner = rows.find(row => Number(row.position) === 1);
          if (winner && !winners().has(String(race.round))) {
            data.winners.data = [...(data.winners.data || []), {round: String(race.round), Results: [winner]}];
            summary(); render();
          }
          panel.querySelector('.f1-weekend-head .f1-kicker').textContent = 'LATEST RESULTS / 最近比赛结果';
          panel.querySelector('.f1-weekend-head .f1-badge').textContent = result.provisional ? '比赛已结束 · 暂定成绩' : '比赛已结束';
        }
        const isQ = key === 'qualifying' || key === 'sprintQualifying';
        const podium = [1, 2, 3].map(position => rows.find(row => Number(row.position) === position));
        $(`#f1-podium-${key}`).innerHTML = rows.length ? `<ol class="f1-podium">${podium.map((row, i) => `<li class="f1-podium-place place-${i + 1}"><span class="f1-medal" aria-label="第 ${i + 1} 名">${['01','02','03'][i]}</span><div class="f1-team" data-team="${esc(row?.Constructor?.constructorId)}"><b>${esc(driver(row))}</b><small>${esc(row?.Constructor?.name || '等待公布')}</small></div><span class="f1-podium-time">${esc(row ? isQ ? row.Q3 || row.Q2 || row.Q1 || '—' : row.Time?.time || row.status || '—' : '—')}</span></li>`).join('')}</ol>` : `<p class="f1-session-empty ${result.unavailable ? 'f1-warning' : ''}">${result.unavailable ? '成绩暂时无法获取，请稍后刷新' : '等待成绩公布'}</p>`;
      } catch {
        if (token === weekendId && data?.season === season) $(`#f1-podium-${key}`).innerHTML = '<p class="f1-session-empty f1-warning">成绩获取失败，请稍后刷新</p>';
      }
    }));
  }
  function renderSchedule() {
    const races = data.schedule.data || [], next = nextRace(), wins = winners();
    const filtered = races.filter(r => filter === 'all' || (filter === 'upcoming' ? stateOf(r) === 'upcoming' : stateOf(r) !== 'upcoming'));
    const nextIndex = filtered.findIndex(r => raceTime(r) > Date.now());
    const start = filter === 'upcoming' ? 0 : filter === 'completed' || nextIndex < 0 ? Math.max(0, filtered.length - 6) : Math.max(0, nextIndex - 1);
    const visible = scheduleExpanded ? filtered : filtered.slice(start, start + 6);
    const filters = [['all','全部'],['upcoming','待开赛'],['completed','已开赛']];
    return `<div class="f1-section-head"><div><h2>${data.season} 赛季赛历</h2><p>${races.length} 站 · ${esc(meta(data.schedule))}</p></div><div class="f1-filters" aria-label="筛选赛程">${filters.map(([key,label]) => `<button data-filter="${key}" aria-pressed="${filter === key}">${label}</button>`).join('')}</div></div>${data.winners.unavailable ? '<p class="f1-note f1-warning">赛果摘要暂不可用，可点开分站尝试获取详细成绩。</p>' : ''}${filtered.length ? `<div class="f1-races">${visible.map(r => {
      const status = stateOf(r), win = wins.get(String(r.round));
      const sessions = [['FirstPractice','一练'],['SecondPractice','二练'],['ThirdPractice','三练'],
        [r.SprintQualifying ? 'SprintQualifying' : 'SprintShootout','冲刺排位'],['Sprint','冲刺赛'],['Qualifying','排位赛']]
        .filter(([key]) => r[key]).sort(([a], [b]) => raceTime(r[a]) - raceTime(r[b]));
      const sessionRow = (key, label, timing) => `<div class="f1-schedule-session ${key === 'race' ? 'is-race' : ['Qualifying','SprintQualifying','SprintShootout','Sprint'].includes(key) ? 'is-featured' : 'is-practice'}"><span>${label}</span><time${timing.date ? ` datetime="${esc(timing.date + (timing.time ? 'T' + timing.time : ''))}"` : ''} title="北京时间">${esc(fmt(timing.date,timing.time))}</time></div>`;
      return `<article class="f1-race ${next?.round === r.round ? 'is-next' : ''}"><div class="f1-race-top"><span>ROUND ${esc(String(r.round).padStart(2,'0'))}</span><span class="f1-badge">${next?.round === r.round ? '下一站' : {completed:'已公布',upcoming:'待开赛',pending:'等待赛果'}[status]}${r.Sprint ? ' · 冲刺周末' : ''}</span></div><h3>${esc(raceName(r))}</h3><p class="circuit">${esc(r.Circuit?.circuitName)}</p><div class="sessions">${sessions.map(([key,label]) => sessionRow(key,label,r[key])).join('')}${sessionRow('race','正赛',r)}</div><div class="f1-race-bottom"><p>${win ? `冠军 · ${esc(driver(win))}` : status === 'upcoming' ? '周末日程，以最新公布为准' : '比赛结果待数据源公布'}</p><button class="btn btn-small" data-round="${esc(r.round)}">${status === 'upcoming' ? '查看分站' : '查看成绩'} ↗</button></div></article>`;
    }).join('')}</div>${filtered.length > 6 ? `<div class="f1-schedule-more"><button class="btn" id="f1-schedule-toggle" aria-expanded="${scheduleExpanded}">${scheduleExpanded ? '收起赛历 ↑' : `展开完整赛历 · ${filtered.length} 站 ↓`}</button></div>` : ''}` : empty(data.schedule.unavailable ? '赛程暂时无法获取，请点击上方刷新数据重试。' : races.length ? '这个分类暂无比赛。' : '该赛季赛程尚未公布。')}`;
  }
  function standings(kind) {
    const isDriver = kind === 'drivers', part = data[kind], list = part.data?.[isDriver ? 'DriverStandings' : 'ConstructorStandings'] || [];
    const first = Number(list[0]?.points);
    return `<div class="f1-section-head"><div><h2>${isDriver ? '世界车手冠军积分榜' : '世界车队冠军积分榜'}</h2><p>${data.season} 赛季${part.data?.round ? ` · 截至第 ${esc(part.data.round)} 站` : ''} · ${esc(meta(part))}</p></div><span class="f1-kicker">${isDriver ? 'WDC' : 'WCC'} STANDINGS</span></div>${list.length ? `<div class="f1-table-wrap" tabindex="0" aria-label="${isDriver ? '车手' : '车队'}积分榜，可横向滚动"><table class="f1-table"><thead><tr><th scope="col">排名</th><th scope="col">${isDriver ? '车手 / 车队' : '车队'}</th><th scope="col">积分</th><th scope="col">距榜首</th><th scope="col">胜场</th></tr></thead><tbody>${list.map(r => `<tr><td>${esc(r.positionText || r.position)}</td><td><span class="f1-team" data-team="${esc(isDriver ? r.Constructors?.at(-1)?.constructorId : r.Constructor?.constructorId)}"><b>${esc(isDriver ? driver(r) : r.Constructor?.name)}</b>${isDriver ? `<small>${esc(r.Constructors?.map(c=>c.name).join(' / '))}</small>` : ''}</span></td><td class="points">${esc(r.points)}</td><td>${Number(r.points) === first ? '—' : '−' + Number((first - Number(r.points)).toFixed(1))}</td><td>${esc(r.wins)}</td></tr>`).join('')}</tbody></table></div>` : empty(part.unavailable ? '积分榜暂时无法获取，请点击上方刷新数据重试。' : '该赛季积分尚未公布。')}`;
  }
  function render() {
    if (!data) return;
    summary();
    $('#f1-content').innerHTML = view === 'schedule' ? renderSchedule() : standings(view);
    $('#f1-content').setAttribute('aria-labelledby', 'tab-' + view);
    for (const button of document.querySelectorAll('[data-view]')) { button.setAttribute('aria-selected', String(button.dataset.view === view)); button.tabIndex = button.dataset.view === view ? 0 : -1; }
    for (const button of document.querySelectorAll('[data-filter]')) button.onclick = () => { filter = button.dataset.filter; scheduleExpanded = false; render(); };
    if ($('#f1-schedule-toggle')) $('#f1-schedule-toggle').onclick = () => { scheduleExpanded = !scheduleExpanded; render(); };
    for (const button of document.querySelectorAll('[data-round]')) button.onclick = () => { chosenRound = button.dataset.round; chosenSession = 'race'; showResults(true); };
  }
  async function load() {
    const token = ++loadId, year = $('#f1-season').value;
    $('#f1-refresh').disabled = true; $('#f1-status').textContent = '正在获取赛程与积分榜…';
    try {
      const response = await request(`/api/f1/season?season=${year}`);
      if (token !== loadId) return;
      data = response;
      const warning = parts().some(p => p.stale || p.unavailable);
      const stamps = parts().filter(p=>p.updatedAt).map(p=>p.updatedAt).sort();
      $('#f1-status').classList.toggle('warning', warning);
      $('#f1-status').textContent = warning ? '部分数据暂未更新，已保留可用数据。各视图注明更新时间，可稍后刷新。' : `已同步 · 最近获取 ${updated(stamps.at(-1))} · 北京时间`;
      render();
      showWeekend();
      if (chosenRound && $('#f1-results-dialog').open) showResults(false);
    } catch (e) {
      if (token !== loadId) return;
      $('#f1-status').classList.add('warning');
      $('#f1-status').textContent = '暂时无法连接，点击“刷新数据”重试。' + (data ? ' 当前保留上次显示的数据。' : '');
      if (!data) { $('#f1-content').innerHTML = empty('F1 数据暂时无法加载，请稍后重试。'); $('#f1-weekend').innerHTML = empty('最近比赛结果暂时无法加载，请稍后刷新。'); }
    } finally { if (token === loadId) $('#f1-refresh').disabled = false; }
  }
  const upgradesDialog = $('#f1-upgrades-dialog');
  $('#f1-upgrades-close').onclick = () => upgradesDialog.close();
  upgradesDialog.addEventListener('close', () => {
    document.documentElement.classList.remove('f1-modal-open');
    $('#f1-upgrades-detail').innerHTML = '';
    $('#f1-upgrades-open')?.focus({ preventScroll: true });
  });
  upgradesDialog.addEventListener('click', event => {
    if (event.target !== upgradesDialog) return;
    const rect = upgradesDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) upgradesDialog.close();
  });
  const mapDialog = $('#f1-map-dialog');
  $('#f1-map-close').onclick = () => mapDialog.close();
  mapDialog.addEventListener('close', () => document.documentElement.classList.remove('f1-modal-open'));
  mapDialog.addEventListener('click', event => { if (event.target === mapDialog) { const r = mapDialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) mapDialog.close(); } });
  const resultsDialog = $('#f1-results-dialog');
  $('#f1-results-close').onclick = () => resultsDialog.close();
  resultsDialog.addEventListener('close', () => { resultId++; chosenRound = null; document.documentElement.classList.remove('f1-modal-open'); });
  resultsDialog.addEventListener('click', event => {
    const rect = resultsDialog.getBoundingClientRect();
    if (event.target === resultsDialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) resultsDialog.close();
  });
  async function showResults(open) {
    const token = ++resultId, round = chosenRound, season = data.season, session = chosenSession;
    const race = data.schedule.data?.find(r=>String(r.round) === String(round));
    const panel = $('#f1-results');
    if (open && !resultsDialog.open) { resultsDialog.showModal(); document.documentElement.classList.add('f1-modal-open'); }
    panel.innerHTML = `<h2 id="f1-results-title">${esc(raceName(race) || `第 ${round} 站`)} <small>· 分站成绩</small></h2><p class="f1-note">${season} 赛季 · 第 ${esc(round)} 站${race ? ' · 正赛 ' + esc(fmt(race.date,race.time)) : ''}</p><div class="f1-result-tabs" aria-label="成绩类型">${resultSessions(race).map(([key,label])=>`<button class="btn btn-small" aria-pressed="${session === key}" data-session="${key}">${label}</button>`).join('')}</div><div id="f1-result-body" aria-live="polite">正在获取分站成绩…</div>`;
    for (const button of panel.querySelectorAll('[data-session]')) button.onclick = () => { chosenSession = button.dataset.session; showResults(false); };
    if (open) $('#f1-results-close').focus();
    try {
      const result = await request(`/api/f1/race?season=${season}&round=${round}&session=${session}`);
      if (token !== resultId || data?.season !== season) return;
      const rows = result.data?.[0]?.[sessionRows[session]] || [];
      const isQ = session === 'qualifying' || session === 'sprintQualifying';
      const isPractice = session.startsWith('practice');
      $('#f1-result-body').innerHTML = `<p class="f1-note ${result.stale ? 'f1-warning' : ''}">${esc(meta(result))}</p>${rows.length ? `<div class="f1-table-wrap" tabindex="0" aria-label="分站成绩，可横向滚动"><table class="f1-table"><thead><tr><th scope="col">名次</th><th scope="col">车手 / 车队</th>${isQ ? '<th scope="col">Q1</th><th scope="col">Q2</th><th scope="col">Q3</th>' : isPractice ? '<th scope="col">最快圈速</th><th scope="col">圈数</th>' : '<th scope="col">用时 / 状态</th><th scope="col">圈数</th><th scope="col">积分</th>'}</tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.positionText || r.position)}</td><td><span class="f1-team" data-team="${esc(r.Constructor?.constructorId)}"><b>${esc(driver(r))}</b><small>${esc(r.Constructor?.name)}</small></span></td>${isQ ? ['Q1','Q2','Q3'].map(key=>`<td>${esc(r[key] || '—')}</td>`).join('') : `<td>${esc(r.Time?.time || ({Finished:'完赛','Disqualified':'取消资格','Not classified':'未获名次','Retired':'退赛','Did not start':'未起步'}[r.status] || r.status || '—'))}</td><td>${esc(r.laps ?? '—')}</td>${isPractice ? '' : `<td class="points">${esc(r.points ?? '—')}</td>`}`}</tr>`).join('')}</tbody></table></div>` : empty(result.unavailable ? '本场成绩暂时无法获取，请稍后重试。' : '本场成绩尚未公布，或该分站没有此项比赛。')}`;
    } catch {
      if (token === resultId) $('#f1-result-body').innerHTML = empty('分站成绩获取失败，点击比赛类型可重试。');
    }
  }
  for (const button of document.querySelectorAll('[data-view]')) {
    button.onclick = () => { view = button.dataset.view; render(); };
    button.onkeydown = event => {
      const buttons = [...document.querySelectorAll('[data-view]')], at = buttons.indexOf(button);
      const next = event.key === 'ArrowRight' ? (at + 1) % 3 : event.key === 'ArrowLeft' ? (at + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
      if (next != null) { event.preventDefault(); buttons[next].click(); buttons[next].focus(); }
    };
  }
  $('#f1-season').onchange = () => { if (upgradesDialog.open) upgradesDialog.close(); data = null; $('#f1-weekend-detail').hidden = true; if (mapDialog.open) mapDialog.close(); chosenRound = null; scheduleExpanded = false; resultId++; weekendId++; $('#f1-summary').innerHTML = ''; $('#f1-weekend').innerHTML = empty('正在获取最近比赛结果…'); if (resultsDialog.open) resultsDialog.close(); $('#f1-content').innerHTML = empty('正在获取该赛季数据…'); load(); };
  $('#f1-refresh').onclick = load;
  setInterval(() => { if (!document.hidden && !$('#f1-refresh').disabled) load(); }, 15 * 60_000);
  load();
})();
