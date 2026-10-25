// Vérification locale : on compare les prévisions passées de chaque modèle aux observations
// de la station METAR la plus proche, pour ajuster leurs poids et corriger leurs biais.
import { localKey, hoursBetween } from '../web/js/ensemble.js';

const ARCHIVE_EVERY_H = 3;   // une prévision archivée toutes les 3 h
const ARCHIVE_LEAD_H = 36;   // échéances conservées
const KEEP_DAYS = 10;
const MIN_PAIRS = 30;
const FULL_PAIRS = 150;

export async function fetchMetar(station, timeZone) {
  const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${station}&format=json&hours=36`, { headers: { 'User-Agent': 'app-meteo (github.com/maxencedevos83/app-meteo)' } });
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
    if (Object.keys(o).length) obs[key] = o;
  }
  return obs;
}

export function mergeObs(state, obs, nowKey) {
  const all = { ...(state.obs || {}), ...obs };
  for (const k of Object.keys(all)) if (hoursBetween(k, nowKey) > KEEP_DAYS * 24) delete all[k];
  state.obs = all;
}

export function archiveRun(state, sources, nowKey) {
  state.runs = (state.runs || []).filter((r) => hoursBetween(r.issued, nowKey) <= KEEP_DAYS * 24);
  const last = state.runs[state.runs.length - 1];
  if (last && hoursBetween(last.issued, nowKey) < ARCHIVE_EVERY_H) return false;
  const start = nowKey.slice(0, 13) + ':00';
  const models = {};
  for (const s of sources) {
    const m = {};
    s.times.forEach((t, i) => {
      const lead = hoursBetween(start, t);
      if (lead < 1 || lead > ARCHIVE_LEAD_H) return;
      const v = [s.data.temp?.[i], s.data.wind?.[i]].map((x) => (x == null ? null : Math.round(x * 10) / 10));
      if (v.some((x) => x != null)) m[t] = v;
    });
    if (Object.keys(m).length) models[s.id] = m;
  }
  state.runs.push({ issued: start, models });
  return true;
}

// Scores par modèle : erreur absolue moyenne, biais (température), rapport obs/prévision (vent).
export function computeSkill(state) {
  const acc = {};
  for (const run of state.runs || []) {
    for (const [id, series] of Object.entries(run.models)) {
      const a = (acc[id] ||= { t: [], w: [] });
      for (const [time, [t, w]] of Object.entries(series)) {
        const o = state.obs?.[time];
        if (!o) continue;
        if (t != null && o.t != null) a.t.push([t, o.t]);
        if (w != null && o.w != null) a.w.push([w, o.w]);
      }
    }
  }
  const scores = {};
  for (const [id, a] of Object.entries(acc)) {
    const s = {};
    if (a.t.length) {
      s.temp = { n: a.t.length, mae: mean(a.t.map(([f, o]) => Math.abs(f - o))), bias: mean(a.t.map(([f, o]) => f - o)) };
    }
    if (a.w.length) {
      const sf = a.w.reduce((x, [f]) => x + f, 0), so = a.w.reduce((x, [, o]) => x + o, 0);
      s.wind = { n: a.w.length, mae: mean(a.w.map(([f, o]) => Math.abs(f - o))), ratio: sf > 0 ? so / sf : 1 };
    }
    scores[id] = s;
  }

  // Poids : plus un modèle se trompe peu par rapport aux autres, plus il compte.
  // Les corrections montent en puissance avec le nombre de comparaisons et restent modérées,
  // car la station (aéroport) n'est pas exactement au même endroit que le lieu prévu.
  const skill = {};
  for (const key of ['temp', 'wind']) {
    const ok = Object.entries(scores).filter(([, s]) => s[key]?.n >= MIN_PAIRS);
    if (ok.length < 2) continue;
    const ref = mean(ok.map(([, s]) => s[key].mae));
    for (const [id, s] of ok) {
      const conf = Math.min(1, s[key].n / FULL_PAIRS);
      const raw = Math.min(3, Math.max(0.3, (ref / Math.max(0.2, s[key].mae)) ** 2));
      const entry = { factor: 1 + (raw - 1) * conf };
      if (key === 'temp') entry.bias = Math.max(-3, Math.min(3, s.temp.bias)) * 0.5 * conf;
      if (key === 'wind') entry.ratio = 1 + (Math.max(0.6, Math.min(1.6, s.wind.ratio)) - 1) * 0.5 * conf;
      (skill[id] ||= {})[key] = entry;
    }
  }
  return { scores, skill };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
