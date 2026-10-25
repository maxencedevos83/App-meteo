// Vérification locale : on compare les prévisions passées de chaque modèle aux observations
// (stations Météo-France proches, à défaut METAR de l'aéroport) pour ajuster leurs poids et corriger leurs biais.
import { localKey, hoursBetween, sectorOf } from '../web/js/ensemble.js';

const ARCHIVE_EVERY_H = 3;   // une prévision archivée toutes les 3 h
const ARCHIVE_LEAD_H = 36;   // échéances conservées
const KEEP_DAYS = 10;
const MIN_PAIRS = 30;
const FULL_PAIRS = 150;
const MIN_SECTOR_PAIRS = 24;
const WET = 0.2;             // mm/h : seuil « il pleut »
export const BLEND_ID = '_blend';

// Valeurs archivées par heure : [température, vent, rafales, pluie, direction].
const T = 0, W = 1, G = 2, P = 3, D = 4;

export async function fetchMetar(station, timeZone) {
  const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${station}&format=json&hours=36`, { headers: { 'User-Agent': 'app-meteo (github.com/maxencedevos83/App-meteo)' } });
  if (!res.ok) throw new Error(`METAR ${res.status}`);
  const list = await res.json();
  const obs = {};
  for (const m of list) {
    const t = m.obsTime ? new Date(m.obsTime * 1000) : new Date(m.reportTime);
    const min = t.getUTCMinutes();
    if (min > 10 && min < 50) continue; // on ne garde que les observations proches de l'heure pile
    const rounded = new Date(Math.round(t.getTime() / 3600000) * 3600000);
    const key = localKey(rounded, timeZone);
    const o = {};
    if (typeof m.temp === 'number') o.t = m.temp;
    if (typeof m.wspd === 'number') o.w = m.wspd;
    if (typeof m.wgst === 'number') o.g = m.wgst;
    if (typeof m.wdir === 'number' && m.wspd > 2) o.d = m.wdir;
    if (Object.keys(o).length) obs[key] = o;
  }
  return obs;
}

// Fusionne de nouvelles observations ; `priority` (stations Météo-France) l'emporte sur l'aéroport.
export function mergeObs(state, obs, nowKey, { priority = false, source = 'metar' } = {}) {
  const all = state.obs || {};
  for (const [k, o] of Object.entries(obs)) {
    const prev = all[k] || {};
    if (prev.src === 'mf' && !priority) {
      // On complète seulement ce que les stations n'ont pas mesuré.
      all[k] = { ...o, ...prev };
    } else {
      all[k] = { ...prev, ...o, src: priority ? 'mf' : (prev.src || source) };
    }
  }
  for (const k of Object.keys(all)) if (hoursBetween(k, nowKey) > KEEP_DAYS * 24) delete all[k];
  state.obs = all;
}

const round1 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10);

// extra : séries supplémentaires à archiver (la prévision combinée), au format { id, times, data }.
export function archiveRun(state, sources, nowKey, extra = []) {
  state.runs = (state.runs || []).filter((r) => hoursBetween(r.issued, nowKey) <= KEEP_DAYS * 24);
  const last = state.runs[state.runs.length - 1];
  if (last && hoursBetween(last.issued, nowKey) < ARCHIVE_EVERY_H) return false;
  const start = nowKey.slice(0, 13) + ':00';
  const models = {};
  for (const s of [...sources, ...extra]) {
    const m = {};
    s.times.forEach((t, i) => {
      const lead = hoursBetween(start, t);
      if (lead < 1 || lead > ARCHIVE_LEAD_H) return;
      const v = [s.data.temp?.[i], s.data.wind?.[i], s.data.gust?.[i], s.data.precip?.[i], s.data.dir?.[i]].map(round1);
      if (v.some((x) => x != null)) m[t] = v;
    });
    if (Object.keys(m).length) models[s.id] = m;
  }
  state.runs.push({ issued: start, models });
  return true;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function windStats(pairs) {
  const sf = pairs.reduce((x, [f]) => x + f, 0), so = pairs.reduce((x, [, o]) => x + o, 0);
  return { n: pairs.length, mae: mean(pairs.map(([f, o]) => Math.abs(f - o))), ratio: sf > 0 ? so / sf : 1 };
}

// Scores par modèle : erreur moyenne, biais (température), rapport obs/prévision (vent, rafales),
// justesse pluie/pas pluie, et les mêmes corrections par secteur de vent.
export function computeSkill(state) {
  const acc = {};
  for (const run of state.runs || []) {
    for (const [id, series] of Object.entries(run.models)) {
      const a = (acc[id] ||= { t: [], w: [], g: [], p: [], sec: {} });
      for (const [time, v] of Object.entries(series)) {
        const o = state.obs?.[time];
        if (!o) continue;
        // Régime de vent (mistral d'ouest, vent d'est…) : secteur prévu par le modèle.
        const sec = sectorOf(v[D] ?? o.d);
        const s = sec ? (a.sec[sec] ||= { t: [], w: [] }) : null;
        if (v[T] != null && o.t != null) { a.t.push([v[T], o.t]); s?.t.push([v[T], o.t]); }
        if (v[W] != null && o.w != null) { a.w.push([v[W], o.w]); s?.w.push([v[W], o.w]); }
        if (v[G] != null && o.g != null) a.g.push([v[G], o.g]);
        if (v[P] != null && o.p != null) a.p.push([v[P], o.p]);
      }
    }
  }

  const scores = {};
  for (const [id, a] of Object.entries(acc)) {
    const s = {};
    if (a.t.length) s.temp = { n: a.t.length, mae: mean(a.t.map(([f, o]) => Math.abs(f - o))), bias: mean(a.t.map(([f, o]) => f - o)) };
    if (a.w.length) s.wind = windStats(a.w);
    if (a.g.length) s.gust = windStats(a.g);
    if (a.p.length) {
      const hits = a.p.filter(([f, o]) => (f >= WET) === (o >= WET)).length;
      const wetObs = a.p.filter(([, o]) => o >= WET).length;
      s.precip = { n: a.p.length, mae: mean(a.p.map(([f, o]) => Math.abs(f - o))), accuracy: hits / a.p.length, wetObs };
    }
    const sectors = {};
    for (const [sec, v] of Object.entries(a.sec)) {
      const e = {};
      if (v.t.length >= MIN_SECTOR_PAIRS) e.bias = mean(v.t.map(([f, o]) => f - o));
      if (v.w.length >= MIN_SECTOR_PAIRS) e.ratio = windStats(v.w).ratio;
      if (Object.keys(e).length) sectors[sec] = { ...e, n: Math.max(v.t.length, v.w.length) };
    }
    if (Object.keys(sectors).length) s.sectors = sectors;
    scores[id] = s;
  }

  // Poids : plus un modèle se trompe peu par rapport aux autres, plus il compte.
  // Les corrections montent en puissance avec le nombre de comparaisons et restent modérées,
  // car les stations ne sont pas exactement au point prévu.
  const skill = {};
  const models = Object.entries(scores).filter(([id]) => id !== BLEND_ID);
  const errorOf = { temp: (s) => s.temp?.mae, wind: (s) => s.wind?.mae, precip: (s) => (s.precip ? 1 - s.precip.accuracy + 0.05 : undefined) };
  for (const key of ['temp', 'wind', 'precip']) {
    const ok = models.filter(([, s]) => s[key]?.n >= MIN_PAIRS);
    if (ok.length < 2) continue;
    // Pluie : on n'ajuste qu'une fois quelques heures de pluie observées, sinon tout le monde a « raison ».
    if (key === 'precip' && Math.max(...ok.map(([, s]) => s.precip.wetObs)) < 6) continue;
    const ref = mean(ok.map(([, s]) => errorOf[key](s)));
    for (const [id, s] of ok) {
      const conf = Math.min(1, s[key].n / FULL_PAIRS);
      const raw = Math.min(3, Math.max(0.3, (ref / Math.max(0.05, errorOf[key](s))) ** 2));
      const entry = { factor: 1 + (raw - 1) * conf };
      if (key === 'temp') entry.bias = Math.max(-3, Math.min(3, s.temp.bias)) * 0.5 * conf;
      if (key === 'wind') {
        entry.ratio = 1 + (Math.max(0.6, Math.min(1.6, s.wind.ratio)) - 1) * 0.5 * conf;
        if (s.gust?.n >= MIN_PAIRS) entry.gustRatio = 1 + (Math.max(0.6, Math.min(1.6, s.gust.ratio)) - 1) * 0.5 * Math.min(1, s.gust.n / FULL_PAIRS);
      }
      (skill[id] ||= {})[key] = entry;
    }
  }
  // Corrections par régime de vent, quand on a assez d'exemples dans le secteur.
  for (const [id, s] of models) {
    if (!s.sectors) continue;
    const sectors = {};
    for (const [sec, v] of Object.entries(s.sectors)) {
      const conf = Math.min(1, v.n / FULL_PAIRS);
      const e = {};
      if (v.bias != null) e.bias = Math.max(-3, Math.min(3, v.bias)) * 0.5 * conf;
      if (v.ratio != null) e.ratio = 1 + (Math.max(0.6, Math.min(1.6, v.ratio)) - 1) * 0.5 * conf;
      sectors[sec] = e;
    }
    (skill[id] ||= {}).sectors = sectors;
  }
  return { scores, skill };
}

// Prévu (combinaison de l'appli, 3 à 12 h avant) contre observé, sur les dernières heures.
export function history(state, nowKey, hours = 48) {
  const out = [];
  const runs = state.runs || [];
  for (const [time, o] of Object.entries(state.obs || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const age = hoursBetween(time, nowKey);
    if (age < 0 || age > hours) continue;
    let fc = null;
    for (const r of runs) {
      const lead = hoursBetween(r.issued, time);
      if (lead < 3 || lead > 12) continue;
      const v = r.models[BLEND_ID]?.[time];
      if (v) fc = v; // le plus récent l'emporte (runs triés par date)
    }
    out.push({ time, obs: { t: o.t ?? null, w: o.w ?? null, g: o.g ?? null, p: o.p ?? null }, fc: fc ? { t: fc[T], w: fc[W], g: fc[G], p: fc[P] } : null, src: o.src || 'metar' });
  }
  return out;
}
