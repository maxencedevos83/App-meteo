// Met à jour la prévision combinée : lancé toutes les 30 min par GitHub Actions.
// Écrit out/data/forecast.json (appli) et out/data/widget.json (widgets), et l'état de vérification dans state/.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { localKey } from '../web/js/ensemble.js';
import { fetchAllOpenMeteo, fetchEnsemblePop, fetchNowcast, fetchMarine } from '../web/js/sources.js';
import { buildForecast, buildWidget } from '../web/js/forecast.js';
import { fetchWindguru } from './windguru.mjs';
import { fetchMetar, mergeObs, archiveRun, computeSkill, history, BLEND_ID } from './verify.mjs';
import { fetchStationObs } from './stations.mjs';

const root = new URL('..', import.meta.url).pathname;
const STATE_DIR = process.env.STATE_DIR || join(root, 'state');
const OUT_DIR = process.env.OUT_DIR || join(root, 'out', 'data');

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const { latitude: lat, longitude: lon, timezone: tz } = config;
const now = new Date();
const nowKey = localKey(now, tz);
const errors = [];
const soft = (label) => (e) => { errors.push(`${label} : ${e.message}`); return null; };

const [om, ensemblePop, nowcast, marine, wg, metar] = await Promise.all([
  fetchAllOpenMeteo(lat, lon, tz),
  fetchEnsemblePop(lat, lon, tz).catch(soft('Ensemble ECMWF')),
  fetchNowcast(lat, lon, tz).catch(soft('Pluie dans l\'heure')),
  fetchMarine(lat, lon, tz).catch(soft('Mer')),
  fetchWindguru(config).catch(soft('Windguru')),
  config.metar ? fetchMetar(config.metar, tz).catch(soft(`METAR ${config.metar}`)) : null,
]);
errors.push(...om.errors);
if (wg) errors.push(...wg.log);

const sources = [...om.sources, ...(wg?.sources || [])];
if (!sources.length) {
  console.error('Aucune source disponible :', errors.join('\n'));
  process.exit(1);
}

const state = await readJson(join(STATE_DIR, 'verification.json'), { runs: [], obs: {} });
if (metar) mergeObs(state, metar, nowKey, { source: 'metar' });
const mf = await fetchStationObs(config, state, now).catch(soft('Stations Météo-France'));
if (mf?.obs) mergeObs(state, mf.obs, nowKey, { priority: true });
const { scores, skill } = computeSkill(state);

const fix = (x, d = 2) => (x == null ? null : +x.toFixed(d));
const scoreOf = (id, label) => {
  const s = scores[id] || {};
  return {
    id, label,
    temp: s.temp ? { n: s.temp.n, mae: fix(s.temp.mae), bias: fix(s.temp.bias) } : null,
    wind: s.wind ? { n: s.wind.n, mae: fix(s.wind.mae), ratio: fix(s.wind.ratio) } : null,
    gust: s.gust ? { n: s.gust.n, mae: fix(s.gust.mae), ratio: fix(s.gust.ratio) } : null,
    precip: s.precip ? { n: s.precip.n, accuracy: fix(s.precip.accuracy, 3), wetObs: s.precip.wetObs } : null,
    sectors: s.sectors || null,
    skill: skill[id] || null,
  };
};
const scoreList = sources.map((s) => scoreOf(s.id, s.label));

const fc = buildForecast({
  config, sources, ensemblePop: ensemblePop || {}, nowcast, marine, skill, errors, now,
  scores: {
    station: config.metar,
    stations: state.mf?.stations || [],
    observations: Object.keys(state.obs || {}).length,
    runs: state.runs.length,
    blend: scoreOf(BLEND_ID, 'Prévision combinée'),
    models: scoreList,
  },
});
fc.history = history(state, nowKey);

// On archive aussi la prévision combinée, pour mesurer la justesse de l'appli elle-même.
const blend = { id: BLEND_ID, times: fc.hours.map((h) => h.time), data: {
  temp: fc.hours.map((h) => h.temp), wind: fc.hours.map((h) => h.wind), gust: fc.hours.map((h) => h.gust),
  precip: fc.hours.map((h) => h.precip), dir: fc.hours.map((h) => h.dir),
} };
archiveRun(state, sources, nowKey, [blend]);
if (wg) fc.windguru = { spotId: wg.spotId, spotName: wg.spotName, models: wg.sources.length };
const widget = buildWidget(fc);

await mkdir(OUT_DIR, { recursive: true });
await mkdir(STATE_DIR, { recursive: true });
await writeFile(join(OUT_DIR, 'forecast.json'), JSON.stringify(fc));
await writeFile(join(OUT_DIR, 'widget.json'), JSON.stringify(widget, null, 1));
await writeFile(join(STATE_DIR, 'verification.json'), JSON.stringify(state));

console.log(`${fc.place} ${nowKey} : ${sources.length} sources (${om.sources.length} Open-Meteo, ${wg?.sources.length || 0} Windguru)`);
console.log(`Maintenant : ${widget.temp}°C ${widget.cond}, vent ${widget.wind} kn (raf. ${widget.gust}) ${widget.dir}, confiance ${widget.confidence} %`);
console.log(`Vérification : ${fc.scores.observations} observations, ${state.runs.length} prévisions archivées`);
if (mf?.stations) console.log(`Stations Météo-France : ${mf.stations.map((s) => `${s.name} (${s.km} km)`).join(', ')}${mf.skipped ? ' (cache)' : ''}`);
if (mf?.url) console.log(`Fichier : ${mf.url}`);
const b = fc.scores.blend;
if (b.temp) console.log(`Justesse de l'appli : temp. ±${b.temp.mae}°, vent ±${b.wind?.mae ?? '?'} kn (${b.temp.n} comparaisons)`);
if (errors.length) console.log('Avertissements :\n- ' + errors.join('\n- '));
