// Met à jour la prévision combinée : lancé toutes les 30 min par GitHub Actions.
// Écrit out/data/forecast.json (appli) et out/data/widget.json (widgets), et l'état de vérification dans state/.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { localKey } from '../web/js/ensemble.js';
import { fetchAllOpenMeteo, fetchEnsemblePop, fetchNowcast, fetchMarine } from '../web/js/sources.js';
import { buildForecast, buildWidget } from '../web/js/forecast.js';
import { fetchWindguru } from './windguru.mjs';
import { fetchMetar, mergeObs, archiveRun, computeSkill } from './verify.mjs';

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
if (metar) mergeObs(state, metar, nowKey);
const { scores, skill } = computeSkill(state);
archiveRun(state, sources, nowKey);

const scoreList = sources.map((s) => ({
  id: s.id, label: s.label,
  temp: scores[s.id]?.temp ? { n: scores[s.id].temp.n, mae: +scores[s.id].temp.mae.toFixed(2), bias: +scores[s.id].temp.bias.toFixed(2) } : null,
  wind: scores[s.id]?.wind ? { n: scores[s.id].wind.n, mae: +scores[s.id].wind.mae.toFixed(2), ratio: +scores[s.id].wind.ratio.toFixed(2) } : null,
  skill: skill[s.id] || null,
}));

const fc = buildForecast({
  config, sources, ensemblePop: ensemblePop || {}, nowcast, marine, skill, errors, now,
  scores: { station: config.metar, observations: Object.keys(state.obs || {}).length, runs: state.runs.length, models: scoreList },
});
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
if (errors.length) console.log('Avertissements :\n- ' + errors.join('\n- '));
