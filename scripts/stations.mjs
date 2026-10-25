// Observations horaires des stations Météo-France du département (open data, data.gouv.fr).
// Les fichiers sont mis à jour une fois par jour : parfait pour vérifier les prévisions passées,
// avec des stations bien plus proches du lieu que l'aéroport.
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { localKey } from '../web/js/ensemble.js';

const DATASET = 'https://www.data.gouv.fr/api/1/datasets/donnees-climatologiques-de-base-horaires/';
const MS_TO_KN = 1.943844;
const KEEP_DAYS = 12;

export function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function findLatestFile(dept) {
  const res = await fetch(DATASET);
  if (!res.ok) throw new Error(`data.gouv ${res.status}`);
  const json = await res.json();
  const re = new RegExp(`(^|[^0-9])H_${dept}_latest`, 'i');
  const r = (json.resources || []).find((x) => re.test(x.title || '') || re.test(x.url || ''));
  if (!r) throw new Error(`aucun fichier horaire « latest » pour le département ${dept}`);
  return r.url;
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// Lit le CSV (séparateur ;) en flux et ne garde que les stations proches et les jours récents.
export async function parseStationsCsv(lines, { lat, lon, radiusKm, maxStations, since, timeZone, only = null }) {
  let header = null;
  const stations = new Map();
  const rows = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split(';');
    if (!header) { header = Object.fromEntries(cells.map((c, i) => [c.trim().toUpperCase(), i])); continue; }
    const get = (k) => (header[k] === undefined ? undefined : cells[header[k]]);
    const stamp = get('AAAAMMJJHH');
    if (!stamp || stamp < since) continue;
    const id = get('NUM_POSTE');
    if (!stations.has(id)) {
      const s = { id, name: (get('NOM_USUEL') || '').trim(), lat: num(get('LAT')), lon: num(get('LON')), alt: num(get('ALTI')) };
      s.km = s.lat == null ? Infinity : distanceKm({ lat, lon }, s);
      stations.set(id, s);
    }
    if (stations.get(id).km > radiusKm) continue;
    rows.push({ id, stamp, t: num(get('T')), ff: num(get('FF')), fxi: num(get('FXI')), dd: num(get('DD')), rr: num(get('RR1')) });
  }
  // `only` : liste de noms de stations retenues (par exemple les stations côtières, plus représentatives).
  const wanted = only?.length ? new Set(only.map((n) => n.toUpperCase())) : null;
  const near = [...stations.values()]
    .filter((s) => s.km <= radiusKm && (!wanted || wanted.has(s.name.toUpperCase())))
    .sort((a, b) => a.km - b.km).slice(0, maxStations);
  const keep = new Set(near.map((s) => s.id));
  const byHour = {};
  for (const r of rows) {
    if (!keep.has(r.id)) continue;
    const utc = new Date(Date.UTC(+r.stamp.slice(0, 4), +r.stamp.slice(4, 6) - 1, +r.stamp.slice(6, 8), +r.stamp.slice(8, 10)));
    const key = localKey(utc, timeZone);
    (byHour[key] ||= []).push(r);
  }
  return { stations: near, byHour };
}

// Moyenne pondérée par l'inverse de la distance : la station la plus proche compte le plus.
export function aggregateHour(records, stations) {
  const km = Object.fromEntries(stations.map((s) => [s.id, Math.max(1, s.km)]));
  const avg = (key, conv = (x) => x) => {
    let s = 0, w = 0;
    for (const r of records) if (r[key] != null) { const wi = 1 / km[r.id]; s += conv(r[key]) * wi; w += wi; }
    return w ? Math.round((s / w) * 10) / 10 : undefined;
  };
  const o = { t: avg('t'), w: avg('ff', (x) => x * MS_TO_KN), g: avg('fxi', (x) => x * MS_TO_KN), p: avg('rr') };
  // Direction : celle de la station la plus proche qui a du vent mesurable.
  const withDir = records.filter((r) => r.dd != null && (r.ff ?? 0) >= 1).sort((a, b) => km[a.id] - km[b.id]);
  if (withDir.length) o.d = withDir[0].dd;
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export async function fetchStationObs(config, state, now = new Date()) {
  const st = config.stations || {};
  const dept = st.departement || '83';
  const cache = (state.mf ||= {});
  // Une fois toutes les 6 h suffit : le fichier source n'est mis à jour qu'une fois par jour.
  if (cache.fetchedAt && now - Date.parse(cache.fetchedAt) < 6 * 3600000) return { obs: null, stations: cache.stations, skipped: true };
  const url = await findLatestFile(dept);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Météo-France ${res.status}`);
  let stream = Readable.fromWeb(res.body);
  if (/\.gz($|\?)/.test(url)) stream = stream.pipe(createGunzip());
  const since = new Date(now - KEEP_DAYS * 86400000).toISOString().replace(/\D/g, '').slice(0, 10);
  const { stations, byHour } = await parseStationsCsv(createInterface({ input: stream, crlfDelay: Infinity }), {
    lat: config.latitude, lon: config.longitude, radiusKm: st.radiusKm ?? 20, maxStations: st.max ?? 4, since, timeZone: config.timezone, only: st.only,
  });
  const obs = {};
  for (const [key, records] of Object.entries(byHour)) {
    const o = aggregateHour(records, stations);
    if (Object.keys(o).length) obs[key] = o;
  }
  cache.fetchedAt = now.toISOString();
  cache.stations = stations.map((s) => ({ name: s.name, km: Math.round(s.km * 10) / 10, alt: s.alt }));
  return { obs, stations: cache.stations, url };
}
