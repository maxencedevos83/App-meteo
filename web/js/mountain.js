// Montagne : reconnaître un lieu montagneux, et y suivre les bulletins de montagne plutôt qu'une prévision de plaine.
// Module partagé (navigateur et Node).
//  - Relief : altitude du lieu et des environs (modèle numérique de terrain 90 m d'Open-Meteo).
//  - Bulletins Météo-France par massif (risque d'avalanche, isotherme 0 °C, limite pluie-neige, vent en altitude),
//    rassemblés par scripts/montagne.mjs dans data/montagne.json.
//  - En complément partout : isotherme 0 °C, neige fraîche, hauteur de neige et vent à 1 500 m et 3 000 m (Open-Meteo).
// Unités internes : vent en nœuds, altitudes en mètres, neige fraîche en cm, hauteur de neige en cm.
import { kmh } from './ensemble.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const kn = (kmhValue) => kmhValue / 1.852;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const below = (x, ok, bad) => (!isNum(x) || x <= ok ? 1 : x >= bad ? 0 : (bad - x) / (bad - ok));

// Massifs des bulletins Météo-France (numéro officiel, centre approximatif).
// Les Alpes, les Pyrénées et la Corse ; ni le Jura, ni les Vosges, ni le Massif central n'ont de bulletin d'avalanche.
export const MASSIFS = [
  [1, 'Chablais', 46.25, 6.65], [2, 'Aravis', 45.9, 6.45], [3, 'Mont-Blanc', 45.92, 6.9], [4, 'Bauges', 45.65, 6.15],
  [5, 'Beaufortain', 45.7, 6.6], [6, 'Haute-Tarentaise', 45.55, 6.9], [7, 'Chartreuse', 45.35, 5.8], [8, 'Belledonne', 45.2, 6.05],
  [9, 'Maurienne', 45.25, 6.4], [10, 'Vanoise', 45.4, 6.7], [11, 'Haute-Maurienne', 45.3, 7.0], [12, 'Grandes-Rousses', 45.1, 6.15],
  [13, 'Thabor', 45.1, 6.55], [14, 'Vercors', 45.0, 5.5], [15, 'Oisans', 44.95, 6.15], [16, 'Pelvoux', 44.9, 6.4],
  [17, 'Queyras', 44.75, 6.85], [18, 'Dévoluy', 44.65, 5.9], [19, 'Champsaur', 44.7, 6.2], [20, 'Embrunais-Parpaillon', 44.5, 6.5],
  [21, 'Ubaye', 44.4, 6.75], [22, 'Haut-Var Haut-Verdon', 44.15, 6.75], [23, 'Mercantour', 44.15, 7.15],
  [40, 'Cinto-Rotondo', 42.3, 8.95], [41, 'Renoso-Incudine', 41.95, 9.15],
  [64, 'Pays Basque', 43.05, -0.95], [65, 'Aspe-Ossau', 42.9, -0.5], [66, 'Haute-Bigorre', 42.85, 0.05], [67, 'Aure-Louron', 42.8, 0.4],
  [68, 'Luchonnais', 42.75, 0.65], [69, 'Couserans', 42.8, 1.1], [70, 'Haute-Ariège', 42.7, 1.6], [71, 'Andorre', 42.55, 1.55],
  [72, 'Orlu-Saint-Barthélemy', 42.75, 1.95], [73, 'Capcir-Puymorens', 42.6, 2.0], [74, 'Cerdagne-Canigou', 42.45, 2.35],
].map(([id, name, latitude, longitude]) => ({ id, name, latitude, longitude }));

// Échelle européenne du risque d'avalanche (couleurs officielles).
export const DANGER = [
  null,
  { level: 1, label: 'faible', color: '#ccff66' },
  { level: 2, label: 'limité', color: '#ffff00' },
  { level: 3, label: 'marqué', color: '#ff9900' },
  { level: 4, label: 'fort', color: '#ff0000' },
  { level: 5, label: 'très fort', color: '#a00000' },
];

// La limite pluie-neige se tient en général 200 à 400 m sous l'isotherme 0 °C.
export const RAIN_SNOW_OFFSET = 300;

function km(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Massif Météo-France le plus proche (centre à moins de maxKm).
export function nearestMassif(lat, lon, maxKm = 35) {
  let best = null;
  for (const m of MASSIFS) {
    const d = km({ latitude: lat, longitude: lon }, m);
    if (d <= maxKm && (!best || d < best.km)) best = { ...m, km: Math.round(d) };
  }
  return best;
}

// Points autour du lieu (à 3 et 8 km, huit directions) pour mesurer le relief.
export function ringPoints(lat, lon) {
  const pts = [{ latitude: lat, longitude: lon }];
  for (const r of [3, 8]) {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      pts.push({ latitude: +(lat + (r / 111.2) * Math.cos(a)).toFixed(4), longitude: +(lon + (r / (111.2 * Math.cos(lat * Math.PI / 180))) * Math.sin(a)).toFixed(4) });
    }
  }
  return pts;
}

// Lieu montagneux : en altitude, ou au pied de vrais reliefs (vallée de montagne).
// Une ville de plaine ou de bord de mer entourée de collines (Le Lavandou et les Maures) n'en est pas un.
export function detectMountain(altitude, ring = []) {
  if (!isNum(altitude)) return { mountain: false, altitude: null };
  const around = ring.filter(isNum);
  const summit = around.length ? Math.max(altitude, ...around) : altitude;
  const low = around.length ? Math.min(altitude, ...around) : altitude;
  const relief = Math.round(summit - low);
  const mountain = altitude >= 800 || (altitude >= 400 && (summit - altitude >= 500 || summit >= 1200));
  return { mountain, altitude: Math.round(altitude), summit: Math.round(summit), relief };
}

async function getJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export async function fetchElevations(points, fetchImpl) {
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${points.map((p) => p.latitude).join(',')}&longitude=${points.map((p) => p.longitude).join(',')}`;
  const json = await getJson(url, fetchImpl);
  return json.elevation || [];
}

const MOUNTAIN_HOURLY = {
  freezing: 'freezing_level_height',
  snowfall: 'snowfall',
  snowDepth: 'snow_depth',
  wind850: 'wind_speed_850hPa',
  dir850: 'wind_direction_850hPa',
  temp850: 'temperature_850hPa',
  wind700: 'wind_speed_700hPa',
  dir700: 'wind_direction_700hPa',
  temp700: 'temperature_700hPa',
};

// Grandeurs de montagne heure par heure. Plusieurs modèles : le premier qui donne une valeur l'emporte
// (Météo-France d'abord via best_match, puis ICON et GFS, qui donnent tous l'isotherme et la neige au sol).
export async function fetchMountainHourly(lat, lon, timeZone, fetchImpl) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=${encodeURIComponent(timeZone)}&wind_speed_unit=kn`
    + `&hourly=${Object.values(MOUNTAIN_HOURLY).join(',')}&models=best_match,icon_seamless,gfs_seamless&forecast_days=10`;
  const json = await getJson(url, fetchImpl);
  const h = json.hourly || {};
  if (!h.time) throw new Error('montagne : pas de données horaires');
  const out = { times: h.time, elevation: json.elevation };
  for (const [k, name] of Object.entries(MOUNTAIN_HOURLY)) {
    const keys = Object.keys(h).filter((x) => x === name || x.startsWith(`${name}_`));
    out[k] = h.time.map((_, i) => {
      for (const key of keys) if (isNum(h[key][i])) return h[key][i];
      return null;
    });
  }
  // Hauteur de neige en mètres chez Open-Meteo : en cm ici.
  out.snowDepth = out.snowDepth.map((v) => (isNum(v) ? Math.round(v * 100) : null));
  return out;
}

// Risques d'avalanche du jour, au format EAWS : « FR-03 » → maximum du massif, « FR-03:high » / « FR-03:low » → au-dessus /
// en dessous de l'altitude limite, suffixes « :am » / « :pm » quand le risque change dans la journée.
// Valeurs : niveau 1 à 5 (format actuel du fichier), ou low, moderate, considerable, high, very_high
// (no_snow, no_rating, 0… : pas de niveau).
const EAWS_LEVEL = { low: 1, moderate: 2, considerable: 3, high: 4, very_high: 5 };
const eawsLevel = (v) => {
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
  return EAWS_LEVEL[String(v ?? '').toLowerCase()] ?? 0;
};
export function parseEawsRatings(json) {
  const ratings = json?.maxDangerRatings || json || {};
  const out = new Map();
  for (const m of MASSIFS) {
    const key = `FR-${String(m.id).padStart(2, '0')}`;
    const keys = Object.keys(ratings).filter((k) => k === key || k.startsWith(`${key}:`));
    const level = (filter) => Math.max(0, ...keys.filter(filter).map((k) => eawsLevel(ratings[k]))) || null;
    const danger = level(() => true);
    if (danger) out.set(m.id, { danger, high: level((k) => k.includes(':high')), low: level((k) => k.includes(':low')) });
  }
  return out;
}

// Bulletin du massif dans data/montagne.json (publié par le serveur), s'il est du jour ou de la veille.
export function massifBulletin(bulletins, massif, nowKey) {
  if (!bulletins || !massif) return null;
  const b = (bulletins.massifs || []).find((x) => x.id === massif.id);
  if (!b) return null;
  const date = b.date || bulletins.date;
  if (date && nowKey && (Date.parse(nowKey.slice(0, 10)) - Date.parse(date.slice(0, 10))) / 86400000 > 1) return null;
  return { ...b, date };
}

// Assemble les informations de montagne du lieu ; null si le lieu n'est pas montagneux.
// bulletins : contenu de data/montagne.json (facultatif).
export function buildMountain({ latitude, longitude, altitude, ring, hourly = null, bulletins = null, nowKey = null }) {
  const relief = detectMountain(altitude, ring);
  if (!relief.mountain) return null;
  const massif = nearestMassif(latitude, longitude);
  const bulletin = massifBulletin(bulletins, massif, nowKey);
  return {
    ...relief,
    massif: massif ? { id: massif.id, name: massif.name, km: massif.km } : null,
    bulletin,
    hourly,
  };
}

// Modèles en montagne : la maille fine voit les vallées et les crêtes, une maille de 25 km les lisse.
// Les modèles à 1,5 à 2,5 km pèsent davantage, les modèles globaux moins.
export const MOUNTAIN_PRIOR = {
  meteofrance_arome_france_hd: 1.6,
  meteofrance_arome_france: 1.4,
  icon_d2: 1.25,
  knmi_harmonie_arome_europe: 1.1,
  meteofrance_arpege_europe: 0.9,
  icon_eu: 0.9,
  ecmwf_ifs025: 0.8,
  ukmo_seamless: 0.7,
  ecmwf_aifs025_single: 0.6,
  gfs_seamless: 0.5,
};

export function mountainSources(sources) {
  return sources.map((s) => {
    const f = MOUNTAIN_PRIOR[s.id];
    if (!f || !s.prior) return s;
    return { ...s, prior: Object.fromEntries(Object.entries(s.prior).map(([k, v]) => [k, v * f])) };
  });
}

// Valeur horaire de montagne à l'heure donnée.
function hourIndex(hourly) {
  const idx = new Map();
  (hourly?.times || []).forEach((t, i) => idx.set(t, i));
  return idx;
}

// Limite pluie-neige de l'heure : celle du bulletin du jour s'il en donne une, sinon isotherme 0 °C − 300 m.
export function rainSnowLimit(mountain, time, i) {
  const b = mountain?.bulletin?.meteo?.find((e) => e.date?.slice(0, 10) === time.slice(0, 10) && isNum(e.rainSnow) && e.rainSnow > 0);
  if (b) return b.rainSnow;
  const f = mountain?.hourly?.freezing?.[i];
  return isNum(f) ? Math.max(0, f - RAIN_SNOW_OFFSET) : null;
}

// Pluie ou neige d'après la limite pluie-neige et l'altitude du lieu, comme dans un bulletin montagne.
// hours : heures combinées (modifiées sur place : code météo et indicateur snow).
export function applyRainSnow(hours, mountain) {
  if (!mountain?.hourly) return hours;
  const idx = hourIndex(mountain.hourly);
  const alt = mountain.altitude;
  for (const h of hours) {
    const i = idx.get(h.time);
    if (i == null) continue;
    const limit = rainSnowLimit(mountain, h.time, i);
    h.rainSnow = isNum(limit) ? Math.round(limit / 50) * 50 : null;
    h.freezing = isNum(mountain.hourly.freezing[i]) ? Math.round(mountain.hourly.freezing[i] / 50) * 50 : null;
    const p = h.precip ?? 0;
    if (p < 0.1 || h.code >= 95 || !isNum(limit)) continue;
    const snowing = limit <= alt || (isNum(h.temp) && h.temp <= 0.5);
    const raining = limit > alt + 200 && (!isNum(h.temp) || h.temp >= 2);
    if (snowing) h.code = p >= 2 ? 75 : p >= 0.6 ? 73 : 71;
    else if (raining && ((h.code >= 71 && h.code <= 77) || h.code === 85 || h.code === 86)) h.code = p >= 4 ? 65 : p >= 1 ? 63 : p >= 0.3 ? 61 : 51;
  }
  return hours;
}

const avg = (arr) => { const v = arr.filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const max = (arr) => { const v = arr.filter(isNum); return v.length ? Math.max(...v) : null; };
const min = (arr) => { const v = arr.filter(isNum); return v.length ? Math.min(...v) : null; };
const r50 = (v) => (isNum(v) ? Math.round(v / 50) * 50 : null);

// Résumé par jour, façon bulletin montagne : isotherme 0 °C, limite pluie-neige, neige fraîche, vent en altitude.
export function mountainDays(mountain, dates) {
  const hm = mountain?.hourly;
  if (!hm) return [];
  return dates.map((date) => {
    const all = hm.times.map((t, i) => (t.startsWith(date) ? i : -1)).filter((i) => i >= 0);
    const day = all.filter((i) => { const hr = +hm.times[i].slice(11, 13); return hr >= 6 && hr <= 18; });
    if (!all.length) return null;
    const pick = (arr, ix = day.length ? day : all) => ix.map((i) => arr[i]);
    const fromBulletin = mountain.bulletin?.meteo?.find((e) => e.date?.slice(0, 10) === date);
    const noon = all.find((i) => +hm.times[i].slice(11, 13) === 12) ?? all[0];
    return {
      date,
      freezingMin: r50(min(pick(hm.freezing))),
      freezingMax: r50(max(pick(hm.freezing))),
      // Le bulletin Météo-France prime quand il couvre ce jour.
      freezing: isNum(fromBulletin?.iso0) ? fromBulletin.iso0 : r50(avg(pick(hm.freezing))),
      rainSnow: isNum(fromBulletin?.rainSnow) && fromBulletin.rainSnow > 0 ? fromBulletin.rainSnow : r50(isNum(min(pick(hm.freezing))) ? min(pick(hm.freezing)) - RAIN_SNOW_OFFSET : null),
      snowfall: Math.round((all.reduce((s, i) => s + (hm.snowfall[i] ?? 0), 0)) * 10) / 10,
      snowDepth: hm.snowDepth[noon],
      wind1500: max(pick(hm.wind850)), dir1500: hm.dir850[noon],
      wind3000: max(pick(hm.wind700)), dir3000: hm.dir700[noon],
      temp3000: isNum(min(pick(hm.temp700))) ? Math.round(min(pick(hm.temp700))) : null,
      bulletin: !!fromBulletin,
    };
  }).filter(Boolean);
}

// Vent sur les crêtes au-dessus du lieu : 1 500 m en moyenne montagne, 3 000 m en haute montagne.
function ridgeWind(mountain, i) {
  const hm = mountain.hourly;
  if (!hm) return null;
  return mountain.altitude >= 1500 || mountain.summit >= 2500 ? hm.wind700[i] : hm.wind850[i];
}

// Coefficient d'avalanche pour une sortie : seulement s'il y a de la neige au sol.
function avalancheFactor(danger, snowDepth, offPiste) {
  if (!danger || !(snowDepth >= 10)) return { f: 1 };
  if (danger >= 5) return { f: 0.05, note: 'avalanches : risque très fort' };
  if (danger >= 4) return { f: offPiste ? 0.2 : 0.4, note: 'avalanches : risque fort' };
  if (danger >= 3) return { f: offPiste ? 0.6 : 0.8, note: 'avalanches : risque marqué' };
  return { f: 1 };
}

// Réglages des sorties en montagne, passés à buildActivities : la balade devient une randonnée,
// et le ski / les raquettes apparaissent quand il y a assez de neige.
export function mountainActivityOptions(mountain) {
  if (!mountain) return {};
  const idx = hourIndex(mountain.hourly);
  const danger = mountain.bulletin?.danger ?? null;
  const snowAt = (i) => (i == null ? null : mountain.hourly?.snowDepth?.[i]);
  const snowy = (mountain.hourly?.snowDepth || []).slice(0, 120).some((v) => v >= 20);
  const extra = snowy ? [{ id: 'ski', label: 'Ski / raquettes', emoji: '🎿' }] : [];
  return {
    relabel: { balade: { label: 'Randonnée', emoji: '🥾' } },
    // Équipé, on randonne volontiers par 0 °C ; la chaleur pèse moins en altitude.
    rules: { balade: { temp: [-12, -3, 25, 33] }, velo: { temp: [-3, 5, 27, 35] } },
    extra,
    rescore(id, h, row) {
      const i = idx.get(h.time);
      const notes = [...row.notes];
      const note = (n) => { if (n && !notes.includes(n)) notes.push(n); };
      const ridge = i == null ? null : ridgeWind(mountain, i);
      const depth = snowAt(i);
      const fog = h.code === 45 || h.code === 48;
      if (id === 'balade' || id === 'velo') {
        let s = row.score / 100;
        s *= below(ridge, kn(id === 'velo' ? 35 : 45), kn(id === 'velo' ? 70 : 90));
        if (ridge >= kn(50)) note('vent fort sur les crêtes');
        if (fog) { s *= 0.6; note('brouillard'); }
        if (depth >= 5) { s *= id === 'velo' ? 0.3 : 0.7; note('neige au sol'); }
        const av = avalancheFactor(danger, depth, false);
        s *= av.f; note(av.note);
        if (isNum(h.freezing) && h.freezing < mountain.altitude && isNum(h.temp) && h.temp < 1 && (row.notes.includes('sol mouillé') || row.notes.includes('routes mouillées'))) note('verglas possible');
        return { score: Math.round(clamp01(s) * 100), notes };
      }
      if (id === 'ski') {
        if (!h.isDay || !(depth >= 20)) return { score: 0, notes: depth >= 20 ? [] : ['pas assez de neige'] };
        const rain = h.precip ?? 0;
        const rainy = rain >= 0.1 && isNum(h.rainSnow) && h.rainSnow > mountain.altitude;
        const temp = isNum(h.feels) ? h.feels : h.temp;
        let s = 1;
        s *= below(ridge, kn(35), kn(75));
        if (ridge >= kn(45)) note('vent fort sur les crêtes');
        s *= below(h.gust, kn(40), kn(80));
        if (rainy) { s *= below(rain, 0, 1.5) * 0.5; note('pluie sur la neige'); }
        else if (rain >= 0.5) { s *= 0.6; note('chute de neige'); }
        if (fog) { s *= 0.4; note('brouillard'); }
        s *= clamp01(1.15 - (h.cloud ?? 0) / 150);
        if (isNum(temp)) {
          s *= temp < -20 ? 0.3 : temp < -12 ? 0.7 : temp > 12 ? 0.6 : 1;
          if (temp < -12) note('grand froid');
        }
        if (h.code >= 95) { s *= 0.05; note('orages'); }
        const av = avalancheFactor(danger, depth, true);
        s *= av.f; note(av.note && `${av.note} (hors-piste)`);
        return { score: Math.round(clamp01(s) * 100), notes };
      }
      return row;
    },
  };
}

// Alertes propres à la montagne : risque d'avalanche, neige abondante, tempête sur les crêtes.
export function mountainAlerts(fc) {
  const m = fc.mountain;
  if (!m) return [];
  const out = [];
  const b = m.bulletin;
  if (b?.danger >= 3) {
    const d = DANGER[b.danger];
    out.push({ id: `avalanche-${m.massif?.id}-${b.date}-${b.danger}`, type: 'avalanche', level: b.danger >= 4 ? 3 : 2,
      title: `Risque d'avalanche ${b.danger} (${d.label}) – ${m.massif?.name}`,
      text: b.summary || (b.high && b.low && b.high !== b.low && b.altitude ? `${b.high} au-dessus de ${b.altitude} m, ${b.low} en dessous` : 'Bulletin d\'estimation du risque d\'avalanche Météo-France') });
  }
  const days = m.days || [];
  const snow = days.slice(0, 2).find((d) => d.snowfall >= 10);
  if (snow) out.push({ id: `neige-${snow.date}`, type: 'neige', level: snow.snowfall >= 30 ? 3 : 2, title: `Neige : ${Math.round(snow.snowfall)} cm ${snow.date === fc.now.slice(0, 10) ? "aujourd'hui" : 'demain'}`, text: isNum(snow.rainSnow) ? `Limite pluie-neige vers ${snow.rainSnow} m` : '' });
  const gale = days.slice(0, 2).find((d) => d.wind3000 >= kn(90));
  if (gale) out.push({ id: `cretes-${gale.date}`, type: 'vent', level: gale.wind3000 >= kn(120) ? 3 : 2, title: `Tempête sur les crêtes : ${Math.round(kmh(gale.wind3000))} km/h à 3 000 m`, text: `${gale.date === fc.now.slice(0, 10) ? "Aujourd'hui" : 'Demain'}, rafales plus fortes encore sur les sommets` });
  return out;
}

// Liens vers les bulletins officiels.
export function mountainLinks(fc) {
  const m = fc?.mountain;
  if (!m) return [];
  const france = !!m.massif;
  return [
    france && ['Bulletins montagne Météo-France (risque d\'avalanche, enneigement)', 'https://meteofrance.com/meteo-montagne'],
    ['Carte européenne du risque d\'avalanche (EAWS)', 'https://www.avalanches.org/'],
    !france && ['Bulletin d\'avalanche suisse (SLF)', 'https://www.slf.ch/fr/bulletin-davalanches-et-situation-nivologique/'],
    ['Neige et isotherme (Windy)', `https://www.windy.com/?snowcover,${fc.latitude.toFixed(3)},${fc.longitude.toFixed(3)},9`],
  ].filter(Boolean);
}
