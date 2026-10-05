import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createF1Weather } from './f1-weather.mjs';
import { createF1Briefing } from './f1-briefing.mjs';
import { createOfficialResults } from './f1-results.mjs';
import { createF1News, F1_NEWS_TTL } from './f1-news.mjs';

const BASE = 'https://api.jolpi.ca/ergast/f1/';
const CIRCUIT_PAGES = { albert_park: 'australia', shanghai: 'china', suzuka: 'japan', bahrain: 'bahrain', sepang: 'bahrain', jeddah: 'saudi-arabia', miami: 'miami', villeneuve: 'canada', monaco: 'monaco', catalunya: 'spain', madring: 'spain', red_bull_ring: 'austria', silverstone: 'great-britain', spa: 'belgium', hungaroring: 'hungary', zandvoort: 'netherlands', monza: 'italy', baku: 'azerbaijan', marina_bay: 'singapore', americas: 'united-states', rodriguez: 'mexico', interlagos: 'brazil', vegas: 'las-vegas', las_vegas: 'las-vegas', losail: 'qatar', yas_marina: 'united-arab-emirates', imola: 'emilia-romagna' };
// Corner coverage verified against the official Formula 1 detailed maps.
const SECTOR_TURNS = { sepang: [[1, 3], [4, 9], [10, 15]], marina_bay: [[1, 6], [7, 13], [14, 19]] };
const TTL = 15 * 60_000;
const error = (status, message) => Object.assign(new Error(message), { status });

// One shared queue, persistent cache and single-flight requests protect the upstream.
export function createF1Service({ dataDir, fetcher = fetch, clock = Date.now, spacing = 350 } = {}) {
  const newsService = createF1News({ dataDir, fetcher, clock });
  const weatherService = createF1Weather({ dataDir, fetcher, clock });
  const briefingService = createF1Briefing({ dataDir, fetcher, clock });
  const officialResults = createOfficialResults({ dataDir, fetcher, clock });
  const images = new Map(), imageJobs = new Map();
  const cache = new Map(), pending = new Map(), retryAt = new Map();
  let queue = Promise.resolve(), lastRequest = 0, blockedUntil = 0;
  const cacheFile = dataDir && join(dataDir, 'f1-cache.json');
  if (cacheFile) {
    mkdirSync(dataDir, { recursive: true });
    try {
      for (const [key, entry] of JSON.parse(readFileSync(cacheFile, 'utf8'))) {
        if (entry?.data && Number.isFinite(entry.at) && cache.size < 200) cache.set(key, entry);
      }
    } catch { /* A missing or damaged cache never prevents the site starting. */ }
  }
  function save() {
    if (!cacheFile) return;
    try {
      writeFileSync(cacheFile + '.tmp', JSON.stringify([...cache]), { mode: 0o600 });
      renameSync(cacheFile + '.tmp', cacheFile);
    } catch { console.warn('F1 cache could not be saved'); }
  }
  function year(value) {
    const current = new Date(clock()).getUTCFullYear();
    const result = value == null || value === 'current' ? current : Number(value);
    if (!/^\d{4}$/.test(String(result)) || result < 1950 || result > current + 1) throw error(400, '赛季无效');
    return result;
  }
  async function request(path) {
    const alpha = path.startsWith('alpha/');
    const official = path.startsWith('official/');
    const open = path.startsWith('open/'), circuit = path.startsWith('circuit/');
    const job = queue.then(async () => {
      if (clock() < blockedUntil) throw error(503, '数据源暂时限流');
      const wait = spacing - (clock() - lastRequest);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      lastRequest = clock();
      const upstream = official ? 'https://www.formula1.com/en/racing/' + path.slice(9) + '/circuit' : open ? 'https://api.openf1.org/v1/' + path.slice(5) : circuit ? 'https://api.multiviewer.app/api/v1/circuits/' + path.slice(8) : (alpha ? 'https://api.jolpi.ca/f1/' : BASE) + path + (alpha ? '' : '?limit=100');
      const response = await fetcher(upstream, {
        headers: { Accept: 'application/json', 'User-Agent': 'f1-paddock/1.0' },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) {
        if (response.status === 429) {
          const seconds = Number(response.headers.get('retry-after')) || 60;
          blockedUntil = clock() + Math.max(60, Math.min(3600, seconds)) * 1000;
        }
        throw error(503, 'F1 数据源暂时不可用');
      }
      if (official) {
        const html = await response.text();
        const match = html.match(/https:\/\/media\.formula1\.com\/image\/upload\/[^"\\<> ]*detailed\.webp/);
        if (!match) throw error(503, '官方赛道图尚未发布');
        return { imageUrl: match[0].replace('h_704', 'w_1600'), sourceUrl: upstream };
      }
      const payload = await response.json();
      if (open) {
        if (!Array.isArray(payload)) throw error(503, 'F1 数据格式异常');
        return payload;
      }
      if (circuit) {
        if (!Array.isArray(payload.x) || !Array.isArray(payload.y) || payload.x.length !== payload.y.length || payload.x.length < 3 || !payload.x.every(Number.isFinite) || !payload.y.every(Number.isFinite) || !Array.isArray(payload.corners)) throw error(503, '赛道数据格式异常');
        return { x: payload.x, y: payload.y, rotation: payload.rotation, corners: payload.corners, year: payload.year };
      }
      if (alpha) {
        const body = payload.data;
        if (!body || !(path.includes('schedules/') ? Array.isArray(body.events) : Array.isArray(body.results))) throw error(503, 'F1 数据格式异常');
        return body;
      }
      const body = payload.MRData;
      if (!body || !(path.includes('standings/') ? Array.isArray(body.StandingsTable?.StandingsLists) : Array.isArray(body.RaceTable?.Races))) throw error(503, 'F1 数据格式异常');
      if (Number(body.total) > 100) throw error(503, 'F1 数据超出单页范围');
      return body;
    });
    queue = job.catch(() => {});
    return job;
  }
  async function get(path) {
    const previous = cache.get(path);
    const wrap = (entry, stale = false) => ({ data: entry?.data || null, updatedAt: entry ? new Date(entry.at).toISOString() : null, stale, unavailable: !entry });
    if (previous && clock() - previous.at < TTL) return wrap(previous);
    if (clock() < (retryAt.get(path) || 0) || clock() < blockedUntil) return wrap(previous, true);
    if (!pending.has(path)) {
      if (pending.size >= 24) return wrap(previous, true);
      const job = (async () => {
        try {
          const data = await request(path);
          const entry = { at: clock(), data };
          if (cache.size >= 200) cache.delete(cache.keys().next().value);
          cache.set(path, entry); retryAt.delete(path); save();
          return wrap(entry);
        } catch {
          if (retryAt.size >= 200) retryAt.delete(retryAt.keys().next().value);
          retryAt.set(path, clock() + 60_000);
          return wrap(previous, true);
        } finally { pending.delete(path); }
      })();
      pending.set(path, job);
    }
    return pending.get(path);
  }
  const simplify = (result, kind) => ({ ...result, data: kind === 'races' ? result.data?.RaceTable?.Races ?? null : result.data?.StandingsTable?.StandingsLists?.[0] ?? (result.data ? {} : null) });
  async function raceFor(value, roundValue) {
    const season = year(value), round = Number(roundValue);
    if (!/^\d{1,2}$/.test(String(roundValue)) || round < 1 || round > 30) throw error(400, '分站无效');
    const schedule = await get(`${season}/`);
    return { season, round, race: schedule.data?.RaceTable?.Races.find(r => Number(r.round) === round), unavailable: schedule.unavailable, stale: schedule.stale };
  }
  async function meetingFor(value, roundValue) {
    const season = year(value), round = Number(roundValue);
    if (!/^\d{1,2}$/.test(String(roundValue)) || round < 1 || round > 30) throw error(400, '分站无效');
    const schedule = await get(`${season}/`);
    const race = schedule.data?.RaceTable?.Races.find(r => Number(r.round) === round);
    if (!race) return { season, round, data: null, unavailable: schedule.unavailable, stale: schedule.stale };
    const meetings = await get(`open/meetings?year=${season}`);
    const when = Date.parse(`${race.date}T${race.time || '12:00:00Z'}`);
    const meeting = meetings.data?.find(m => !m.is_cancelled && !/Testing/i.test(m.meeting_name) && when >= Date.parse(m.date_start) - 86400_000 && when <= Date.parse(m.date_end) + 86400_000);
    return { season, round, race, meeting, data: null, unavailable: meetings.unavailable, stale: meetings.stale || schedule.stale };
  }
  return {
    async news(refresh = false) { return newsService.latest({ refresh }); },
    async season(value) {
      const season = year(value);
      const values = await Promise.all([get(`${season}/`), get(`${season}/results/1/`), get(`${season}/driverstandings/`), get(`${season}/constructorstandings/`)]);
      return { season, source: 'Jolpica-F1', refreshMinutes: 15,
        schedule: simplify(values[0], 'races'), winners: simplify(values[1], 'races'), drivers: simplify(values[2], 'standings'), constructors: simplify(values[3], 'standings') };
    },
    async notes(value, roundValue) {
      const context = await raceFor(value, roundValue);
      if (!context.race) return { season: context.season, round: context.round, data: null, unavailable: context.unavailable, automatic: true };
      return { season: context.season, round: context.round, ...await briefingService.weekend(context.race, context.season, CIRCUIT_PAGES[context.race.Circuit?.circuitId]) };
    },
    async weather(value, roundValue) {
      const context = await raceFor(value, roundValue);
      if (!context.race) return { season: context.season, round: context.round, data: null, unavailable: context.unavailable, reason: 'schedule_missing' };
      return { season: context.season, round: context.round, ...await weatherService.weekend(context.race) };
    },
    async circuit(value, roundValue) {
      const season = year(value), round = Number(roundValue);
      if (!/^\d{1,2}$/.test(String(roundValue)) || round < 1 || round > 30) throw error(400, '分站无效');
      const schedule = await get(`${season}/`);
      const race = schedule.data?.RaceTable?.Races.find(r => Number(r.round) === round);
      if (!race) return { season, round, data: null, unavailable: schedule.unavailable, stale: schedule.stale };
      const id = race.Circuit?.circuitId;
      let slug = CIRCUIT_PAGES[id];
      if (id === 'catalunya' && season >= 2026) slug = 'barcelona-catalunya';
      if (slug) {
        const official = await get(`official/${season}/${slug}`);
        if (official.data) return { season, round, ...official, stale: official.stale || schedule.stale,
          data: { ...official.data, sectors: SECTOR_TURNS[id] || null, source: 'Formula 1' } };
      }
      const context = await meetingFor(value, roundValue);
      if (!context.meeting) return context;
      const key = Number(context.meeting.circuit_key);
      if (!Number.isInteger(key) || key < 1) throw error(503, '赛道编号无效');
      const result = await get(`circuit/${key}/${context.season}`);
      return { season, round, ...result, stale: result.stale || context.stale };
    },
    async circuitImage(value, roundValue) {
      const result = await this.circuit(value, roundValue);
      const url = result.data?.imageUrl;
      if (!url || !/^https:\/\/media\.formula1\.com\/image\/upload\//.test(url)) throw error(404, '地图图片尚未发布');
      const key = createHash('sha256').update(url).digest('hex');
      if (images.has(key)) return images.get(key);
      const folder = dataDir && join(dataDir, 'f1-maps');
      const file = folder && join(folder, `${key}.webp`);
      if (file && existsSync(file)) {
        const bytes = readFileSync(file);
        if (images.size >= 32) images.delete(images.keys().next().value);
        images.set(key, bytes); return bytes;
      }
      if (!imageJobs.has(key)) {
        if (imageJobs.size >= 8) throw error(503, '地图正在加载，请稍后重试');
        const job = (async () => {
          try {
            const response = await fetcher(url, { headers: { 'User-Agent': 'f1-paddock/1.0' }, signal: AbortSignal.timeout(8000) });
            if (!response.ok || Number(response.headers.get('content-length')) > 8_000_000) throw error(503, '地图图片暂时不可用');
            const input = Buffer.from(await response.arrayBuffer());
            if (input.length > 8_000_000) throw error(503, '地图图片过大');
            // Remove transparent margins so the circuit fills the available width.
            const bytes = await sharp(input, { limitInputPixels: 20_000_000 }).trim().resize({ width: 1600, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
            if (images.size >= 32) images.delete(images.keys().next().value);
            images.set(key, bytes);
            if (file) { try { mkdirSync(folder, { recursive: true }); writeFileSync(file + '.tmp', bytes); renameSync(file + '.tmp', file); } catch { /* In-memory map remains available. */ } }
            return bytes;
          } finally { imageJobs.delete(key); }
        })();
        imageJobs.set(key, job);
      }
      return imageJobs.get(key);
    },
    async emailCircuitImage(value, roundValue) {
      // Email proxies do not consistently preserve transparent WebP backgrounds.
      return sharp(await this.circuitImage(value, roundValue)).flatten({background:'#fafbfc'}).png().toBuffer();
    },
    async race(value, roundValue, session = 'race') {
      const season = year(value), round = Number(roundValue);
      if (!/^\d{1,2}$/.test(String(roundValue)) || round < 1 || round > 30) throw error(400, '分站无效');
      const alphaCode = { sprintQualifying: 'SQ', practice1: 'FP1', practice2: 'FP2', practice3: 'FP3' }[session];
      if (alphaCode) {
        const schedule = await get(`alpha/schedules/${season}/`);
        const event = schedule.data?.events.find(e => e.round?.number === round && !e.round.is_cancelled);
        if (schedule.unavailable) return { season, round, session, ...schedule };
        if (!event?.schedule?.some(s => s.code === alphaCode)) return { season, round, session, ...schedule, data: [] };
        if (!/^round_[A-Za-z0-9]+$/.test(event.round.id)) throw error(503, 'F1 数据格式异常');
        const result = await get(`alpha/results/${event.round.id}/${alphaCode}/`);
        const rows = result.data?.results.map(row => ({
          position: String(row.position), positionText: row.position_text,
          Driver: { givenName: row.driver?.given_name, familyName: row.driver?.family_name },
          Constructor: { name: row.team?.name },
          Q1: row.components?.SQ1?.time, Q2: row.components?.SQ2?.time, Q3: row.components?.SQ3?.time,
          Time: { time: row.time }, laps: row.laps
        }));
        return { season, round, session, ...result, stale: result.stale || schedule.stale,
          data: rows ? [{ round: String(round), [alphaCode === 'SQ' ? 'QualifyingResults' : 'PracticeResults']: rows }] : null };
      }
      const endpoint = { race: 'results', qualifying: 'qualifying', sprint: 'sprint' }[session];
      if (!endpoint) throw error(400, '比赛类型无效');
      const primary = simplify(await get(`${season}/${round}/${endpoint}/`), 'races');
      if (session === 'race' && !primary.data?.some(race => race.Results?.length)) {
        const context = await raceFor(season, String(round));
        if (context.race) {
          const fallback = await officialResults.race(context.race, season, CIRCUIT_PAGES[context.race.Circuit?.circuitId]);
          if (fallback.data?.length) return { season, round, session, ...fallback };
        }
      }
      return { season, round, session, ...primary };
    }
  };
}

export function createF1Handler({ dataDir, publicDir, service = createF1Service({ dataDir }) }) {
  // Update the current season even when nobody has the page open.
  const refresh = async () => {
    const season = await service.season('current');
    const races = (season.schedule.data || []).filter(race => { const date = Date.parse(race.date + 'T12:00:00Z'); return date >= Date.now() - 3 * 86400_000 && date <= Date.now() + 14 * 86400_000; }).slice(0, 2);
    await Promise.allSettled(races.flatMap(race => [service.notes(season.season, race.round), service.weather(season.season, race.round), service.circuit(season.season, race.round), service.race(season.season, race.round)]));
  };
  const timer = setInterval(() => refresh().catch(() => {}), TTL);
  timer.unref();
  const refreshNews = () => service.news(true).catch(() => {});
  service.news().catch(() => {});
  const newsTimer = setInterval(refreshNews, F1_NEWS_TTL);
  newsTimer.unref();
  const assets = { '/f1': ['f1.html', 'text/html'], '/f1/': ['f1.html', 'text/html'], '/f1.js': ['f1.js', 'application/javascript'], '/f1-account.js': ['f1-account.js', 'application/javascript'], '/f1.css': ['f1.css', 'text/css'] };
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const asset = assets[url.pathname], isApi = url.pathname.startsWith('/api/f1/');
    if (!asset && !isApi) return false;
    if (!['GET', 'HEAD'].includes(req.method)) throw error(405, '不支持的操作');
    if (asset) {
      const path = join(publicDir, asset[0]);
      if (!existsSync(path)) throw error(404, '页面不存在');
      res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(path));
    } else {
      if (url.pathname === '/api/f1/circuit-map' || url.pathname === '/api/f1/email-circuit-map') {
        const emailMap = url.pathname === '/api/f1/email-circuit-map';
        const bytes = await service[emailMap ? 'emailCircuitImage' : 'circuitImage'](url.searchParams.get('season'), url.searchParams.get('round'));
        res.writeHead(200, { 'Content-Type': emailMap ? 'image/png' : 'image/webp', 'Cache-Control': 'public, max-age=86400' });
        res.end(req.method === 'HEAD' ? undefined : bytes); return true;
      }
      let result;
      if (url.pathname === '/api/f1/news') result = await service.news();
      else if (url.pathname === '/api/f1/season') result = await service.season(url.searchParams.get('season'));
      else if (url.pathname === '/api/f1/race') result = await service.race(url.searchParams.get('season'), url.searchParams.get('round'), url.searchParams.get('session') || 'race');
      else if (url.pathname === '/api/f1/circuit') result = await service.circuit(url.searchParams.get('season'), url.searchParams.get('round'));
      else if (url.pathname === '/api/f1/notes') result = await service.notes(url.searchParams.get('season'), url.searchParams.get('round'));
      else if (url.pathname === '/api/f1/weather') result = await service.weather(url.searchParams.get('season'), url.searchParams.get('round'));
      else throw error(404, '接口不存在');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(result));
    }
    return true;
  };
}
