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
import { fetchElevations, ringPoints, fetchMountainHourly, buildMountain, mountainDays, DANGER } from '../web/js/mountain.js';
import { buildMontagne } from './montagne.mjs';

const root = new URL('..', import.meta.url).pathname;
const STATE_DIR = process.env.STATE_DIR || join(root, 'state');
const OUT_DIR = process.env.OUT_DIR || join(root, 'out', 'data');

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

const home = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const { others = [], ...homeConfig } = home;
const now = new Date();

// Bulletins de montagne de tous les massifs : un seul relevé par passage, pour tous les lieux.
const montagne = await buildMontagne({ now, stateDir: STATE_DIR }).catch((e) => ({ json: null, log: [`Bulletins montagne : ${e.message}`] }));

// Lieu montagneux ? Relief autour du lieu, puis isotherme, neige et vent en altitude, et bulletin du massif.
async function mountainFor({ latitude: lat, longitude: lon, timezone: tz }, nowKey) {
  const elev = await fetchElevations(ringPoints(lat, lon));
  const probe = buildMountain({ latitude: lat, longitude: lon, altitude: elev[0], ring: elev.slice(1), bulletins: montagne.json, nowKey });
  if (!probe) return { mountain: null, altitude: elev[0], relief: Math.round(Math.max(...elev) - Math.min(...elev)) };
  const hourly = await fetchMountainHourly(lat, lon, tz);
  return { mountain: { ...probe, hourly }, altitude: elev[0], relief: probe.relief };
}

function mountainLog(label, res, days) {
  if (!res.mountain) return console.log(`${label} : pas en montagne (altitude ${Math.round(res.altitude)} m, relief ${res.relief} m)`);
  const m = res.mountain, b = m.bulletin, d = days?.[0];
  console.log(`${label} : montagne, ${m.altitude} m (sommets ${m.summit} m), massif ${m.massif ? `${m.massif.name} à ${m.massif.km} km` : 'hors bulletins Météo-France'}`
    + `${b ? `, risque d'avalanche ${b.danger} (${DANGER[b.danger].label}, ${b.source})` : ', pas de bulletin d\'avalanche en cours'}`
    + `${d ? ` · aujourd'hui : iso 0 °C ${d.freezing ?? '?'} m, pluie-neige ${d.rainSnow ?? '?'} m, neige ${d.snowfall} cm, au sol ${d.snowDepth ?? '?'} cm, vent 3000 m ${d.wind3000 == null ? '?' : Math.round(d.wind3000 * 1.852)} km/h` : ''}`);
}

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
  const relief = await mountainFor(config, nowKey).catch(soft('Montagne'));
  const mountain = relief?.mountain || null;

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
    config, sources, ensemblePop: ensemblePop || {}, nowcast, marine, mountain, skill, errors, now,
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
  if (relief) mountainLog('Montagne', relief, fc.mountain?.days);
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
console.log('');
for (const line of montagne.log) console.log(line);
if (montagne.json) await writeFile(join(OUT_DIR, 'montagne.json'), JSON.stringify(montagne.json));

// Sur une demande de fusion : essai sur trois lieux de montagne, pour vérifier les sources dans le journal.
if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
  for (const p of [{ place: 'Chamonix', latitude: 45.9237, longitude: 6.8694 }, { place: 'Barcelonnette', latitude: 44.387, longitude: 6.652 }, { place: 'Valberg', latitude: 44.0965, longitude: 6.9311 }]) {
    const cfg = { ...p, timezone: 'Europe/Paris' };
    try {
      const res = await mountainFor(cfg, localKey(now, cfg.timezone));
      const days = res.mountain ? mountainDays(res.mountain, [localKey(now, cfg.timezone).slice(0, 10)]) : null;
      mountainLog(`Essai ${p.place}`, res, days);
    } catch (e) { console.log(`Essai ${p.place} : ${e.message}`); }
  }
}
await writeFile(join(OUT_DIR, 'places.json'), JSON.stringify(places.map((p) => ({ ...p, path: p.id ? `data/${p.id}/` : 'data/' }))));
