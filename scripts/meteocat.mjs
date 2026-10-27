// Observations des stations automatiques du Servei Meteorològic de Catalunya (réseau XEMA),
// en open data sur le portail de la Generalitat (pas de clé nécessaire). Sert à vérifier les prévisions
// des lieux de Catalogne, comme les stations Météo-France pour Le Lavandou.
import { localKey } from '../web/js/ensemble.js';
import { distanceKm } from './stations.mjs';

const PORTAL = 'https://analisi.transparenciacatalunya.cat/resource';
const STATIONS = `${PORTAL}/yqwd-vj5e.json`; // métadonnées des stations
const DATA = `${PORTAL}/nzvn-apee.json`;     // mesures (toutes les 30 min, heure UTC)
const MS_TO_KN = 1.943844;
const KEEP_DAYS = 10;
// Variables XEMA : température, vent moyen et direction à 10 m, rafale maximale, pluie.
const VARS = { 32: 't', 30: 'w', 31: 'd', 50: 'g', 35: 'p' };

async function get(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Meteocat ${res.status}`);
  return res.json();
}

// Regroupe les mesures par heure locale : valeur de l'heure pile, rafale maximale et pluie cumulée sur l'heure.
export function hourlyObs(rows, stations, timeZone) {
  const km = Object.fromEntries(stations.map((s) => [s.id, Math.max(1, s.km)]));
  const byHour = {};
  for (const r of rows) {
    const key = VARS[+r.codi_variable];
    const v = Number(r.valor_lectura);
    if (!key || !Number.isFinite(v) || km[r.codi_estacio] == null) continue;
    const t = new Date(String(r.data_lectura).replace(/Z?$/, 'Z'));
    if (Number.isNaN(t.getTime())) continue;
    // Pluie et rafale : la demi-heure qui se termine à l'heure pile compte pour cette heure.
    const end = new Date(Math.ceil(t.getTime() / 3600000) * 3600000);
    const hour = localKey(key === 'p' || key === 'g' ? end : t, timeZone);
    if (key !== 'p' && key !== 'g' && hour.slice(14) !== '00') continue;
    const h = (byHour[hour.slice(0, 13) + ':00'] ||= {});
    (h[r.codi_estacio] ||= {});
    const s = h[r.codi_estacio];
    if (key === 'p') s.p = (s.p ?? 0) + v;
    else if (key === 'g') s.g = Math.max(s.g ?? 0, v * MS_TO_KN);
    else s[key] = key === 'w' ? v * MS_TO_KN : v;
  }
  const obs = {};
  for (const [hour, per] of Object.entries(byHour)) {
    const ids = Object.keys(per);
    const avg = (k) => {
      let s = 0, w = 0;
      for (const id of ids) if (per[id][k] != null) { const wi = 1 / km[id]; s += per[id][k] * wi; w += wi; }
      return w ? Math.round((s / w) * 10) / 10 : undefined;
    };
    const o = { t: avg('t'), w: avg('w'), g: avg('g'), p: avg('p') };
    const withDir = ids.filter((id) => per[id].d != null && (per[id].w ?? 0) >= 2).sort((a, b) => km[a] - km[b]);
    if (withDir.length) o.d = per[withDir[0]].d;
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    if (Object.keys(o).length) obs[hour] = o;
  }
  return obs;
}

export async function fetchMeteocatObs(config, state, now = new Date()) {
  const st = config.meteocat || {};
  const cache = (state.mc ||= {});
  // Les mesures arrivent en continu : une fois par heure suffit.
  if (cache.fetchedAt && now - Date.parse(cache.fetchedAt) < 50 * 60000) return { obs: null, stations: cache.stations, skipped: true };
  const all = await get(`${STATIONS}?$limit=2000`);
  const here = { lat: config.latitude, lon: config.longitude };
  const wanted = st.only?.length ? new Set(st.only.map((c) => c.toUpperCase())) : null;
  const stations = all
    .map((s) => ({ id: s.codi_estacio, name: s.nom_estacio, lat: +s.latitud, lon: +s.longitud, alt: +s.altitud, open: !/desmantell|baixa/i.test(s.nom_estat_ema || '') }))
    .filter((s) => s.id && Number.isFinite(s.lat) && s.open && (!wanted || wanted.has(s.id.toUpperCase())))
    .map((s) => ({ ...s, km: distanceKm(here, s) }))
    .filter((s) => s.km <= (st.radiusKm ?? 15))
    .sort((a, b) => a.km - b.km)
    .slice(0, st.max ?? 3);
  if (!stations.length) throw new Error('Meteocat : aucune station proche');
  const since = new Date(now - KEEP_DAYS * 86400000).toISOString().slice(0, 19);
  const where = `codi_estacio in(${stations.map((s) => `'${s.id}'`).join(',')}) AND codi_variable in(${Object.keys(VARS).map((v) => `'${v}'`).join(',')}) AND data_lectura >= '${since}'`;
  const rows = await get(`${DATA}?$where=${encodeURIComponent(where)}&$limit=50000`);
  const obs = hourlyObs(rows, stations, config.timezone);
  cache.fetchedAt = now.toISOString();
  cache.stations = stations.map((s) => ({ name: s.name, km: Math.round(s.km * 10) / 10, alt: s.alt }));
  return { obs, stations: cache.stations, rows: rows.length };
}
