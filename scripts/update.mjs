// Met à jour la prévision combinée : lancé toutes les 30 min par GitHub Actions.
// Écrit out/data/forecast.json (appli) et out/data/widget.json (widgets), et l'état de vérification dans state/.
// Les lieux suivis en plus (config.others, par exemple Cambrils) vont dans out/data/<id>/ et state/<id>/.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { localKey } from '../web/js/ensemble.js';
import { fetchAllOpenMeteo, fetchEnsemblePop, fetchNowcast, fetchMarine } from '../web/js/sources.js';
import { buildForecast, buildWidget } from '../web/js/forecast.js';
import { fetchWindguru } from './windguru.mjs';
import { fetchMetar, mergeObs, archiveRun, computeSkill, history, BLEND_ID } from './verify.mjs';
import { fetchStationObs } from './stations.mjs';
import { fetchVigilance } from './vigilance.mjs';
import { fetchMeteocatObs } from './meteocat.mjs';
import { buildAlerts } from '../web/js/alerts.js';

const root = new URL('..', import.meta.url).pathname;
const STATE_DIR = process.env.STATE_DIR || join(root, 'state');
const OUT_DIR = process.env.OUT_DIR || join(root, 'out', 'data');

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

const home = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const { others = [], ...homeConfig } = home;
const now = new Date();

async function run(config, outDir, stateDir) {
  const { latitude: lat, longitude: lon, timezone: tz } = config;
  const nowKey = localKey(now, tz);
  const errors = [];
  const soft = (label) => (e) => { errors.push(`${label} : ${e.message}`); return null; };

  const [om, ensemblePop, nowcast, marine, wg, metar, vigilance] = await Promise.all([
    fetchAllOpenMeteo(lat, lon, tz),
    fetchEnsemblePop(lat, lon, tz).catch(soft('Ensemble ECMWF')),
    fetchNowcast(lat, lon, tz).catch(soft('Pluie dans l\'heure')),
    fetchMarine(lat, lon, tz).catch(soft('Mer')),
    fetchWindguru(config).catch(soft('Windguru')),
    config.metar ? fetchMetar(config.metar, tz).catch(soft(`METAR ${config.metar}`)) : null,
    fetchVigilance(config, now).catch(soft('Vigilance Météo-France')),
  ]);
  errors.push(...om.errors);
  if (wg) errors.push(...wg.log);

  const sources = [...om.sources, ...(wg?.sources || [])];
  if (!sources.length) throw new Error(`${config.place} : aucune source disponible : ${errors.join(' | ')}`);

  const state = await readJson(join(stateDir, 'verification.json'), { runs: [], obs: {} });
  if (metar) mergeObs(state, metar, nowKey, { source: 'metar' });
  const mf = config.stations ? await fetchStationObs(config, state, now).catch(soft('Stations Météo-France')) : null;
  if (mf?.obs) mergeObs(state, mf.obs, nowKey, { priority: true });
  const mc = config.meteocat ? await fetchMeteocatObs(config, state, now).catch(soft('Stations Meteocat')) : null;
  if (mc?.obs) mergeObs(state, mc.obs, nowKey, { priority: true });
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
      stations: (config.meteocat ? state.mc?.stations : state.mf?.stations) || [],
      network: config.meteocat ? 'Meteocat' : 'Météo-France',
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
  fc.vigilance = vigilance;
  fc.alerts = buildAlerts(fc, { gustKn: config.alerts?.gustKn ?? 30, sessionMin: config.alerts?.sessionMin ?? 75, vigilance: vigilance || [] });
  const widget = buildWidget(fc);

  await mkdir(outDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(outDir, 'forecast.json'), JSON.stringify(fc));
  await writeFile(join(outDir, 'widget.json'), JSON.stringify(widget, null, 1));
  await writeFile(join(stateDir, 'verification.json'), JSON.stringify(state));

  console.log(`${fc.place} ${nowKey} : ${sources.length} sources (${om.sources.length} Open-Meteo, ${wg?.sources.length || 0} Windguru)`);
  console.log(`Maintenant : ${widget.temp}°C ${widget.cond}, vent ${widget.wind} kn (raf. ${widget.gust}) ${widget.dir}, confiance ${widget.confidence} %`);
  console.log(`Vérification : ${fc.scores.observations} observations, ${state.runs.length} prévisions archivées`);
  if (mf?.stations) console.log(`Stations Météo-France : ${mf.stations.map((s) => `${s.name} (${s.km} km)`).join(', ')}${mf.skipped ? ' (cache)' : ''}`);
  if (mf?.url) console.log(`Fichier : ${mf.url}`);
  if (mc?.stations) console.log(`Stations Meteocat : ${mc.stations.map((s) => `${s.name} (${s.km} km)`).join(', ')}${mc.skipped ? ' (cache)' : ` : ${mc.rows} mesures, ${Object.keys(mc.obs || {}).length} heures`}`);
  if (vigilance && !vigilance.length && config.vigilance) console.log(`Zones de vigilance publiées : ${vigilance.areas?.slice(0, 40).join(' ; ')}`);
  const b = fc.scores.blend;
  if (b.temp) console.log(`Justesse de l'appli : temp. ±${b.temp.mae}°, vent ±${b.wind?.mae ?? '?'} kn (${b.temp.n} comparaisons)`);
  console.log(`Vigilance : ${vigilance ? (vigilance.length ? vigilance.map((v) => `${v.color} ${v.type}`).join(', ') : 'aucune') : 'indisponible'}`);
  console.log(`Alertes : ${fc.alerts.map((a) => a.title).join(' | ') || 'aucune'}`);
  for (const a of fc.activities) console.log(`${a.label} : ${a.windows.map((w) => `${w.start.slice(5, 13)}h ×${w.hours} (${w.score})`).join(', ') || '—'}`);
  if (errors.length) console.log('Avertissements :\n- ' + errors.join('\n- '));
  return { id: config.id || '', place: config.place, latitude: config.latitude, longitude: config.longitude, timezone: config.timezone };
}

// Lieu principal, puis les autres lieux suivis : une erreur sur l'un n'empêche pas les autres.
const places = [await run(homeConfig, OUT_DIR, STATE_DIR)];
for (const o of others) {
  console.log('');
  try {
    places.push(await run({ ...o, alerts: o.alerts || homeConfig.alerts }, join(OUT_DIR, o.id), join(STATE_DIR, o.id)));
  } catch (e) {
    console.error(`${o.place} : ${e.message}`);
  }
}
await writeFile(join(OUT_DIR, 'places.json'), JSON.stringify(places.map((p) => ({ ...p, path: p.id ? `data/${p.id}/` : 'data/' }))));
