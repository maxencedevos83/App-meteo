// Windguru : API interne du site (non documentée), appelée côté serveur car elle exige un Referer windguru.cz.
// Tout est défensif : si Windguru change son format, la source est simplement ignorée.
import { WINDGURU_PRIOR, localKey } from '../web/js/ensemble.js';

const API = 'https://www.windguru.cz/int/iapi.php';
const HEADERS = {
  Referer: 'https://www.windguru.cz/',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
};

async function call(params) {
  const url = `${API}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Windguru ${res.status} (${params.q})`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`Windguru : réponse non JSON (${params.q}) : ${text.slice(0, 120)}`); }
}

// Parcourt une réponse JSON et renvoie tous les objets qui satisfont `test`.
function collect(node, test, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collect(n, test, out));
  else if (node && typeof node === 'object') {
    if (test(node)) out.push(node);
    Object.values(node).forEach((n) => collect(n, test, out));
  }
  return out;
}

const dist2 = (a, b) => (a.lat - b.lat) ** 2 + ((a.lon - b.lon) * Math.cos(a.lat * Math.PI / 180)) ** 2;

export async function findSpot(query, lat, lon) {
  const json = await call({ q: 'autocomplete_ss', type_info: 'true', all: '0', latlon: '1', query });
  const cands = collect(json, (o) => (o.id_spot ?? o.data ?? o.id) != null && (o.lat ?? o.latitude) != null)
    .map((o) => ({ id: +(o.id_spot ?? o.data ?? o.id), name: o.spotname ?? o.value ?? o.name ?? '', lat: +(o.lat ?? o.latitude), lon: +(o.lon ?? o.lng ?? o.longitude) }))
    .filter((c) => Number.isFinite(c.id) && Number.isFinite(c.lat));
  if (!cands.length) throw new Error(`Windguru : aucun spot trouvé pour « ${query} »`);
  cands.sort((a, b) => dist2(a, { lat, lon }) - dist2(b, { lat, lon }));
  return cands[0];
}

export async function spotModels(spotId) {
  const json = await call({ q: 'forecast_spot', id_spot: String(spotId) });
  const seen = new Map();
  for (const o of collect(json, (x) => x.id_model != null && x.rundef)) {
    if (!seen.has(+o.id_model)) seen.set(+o.id_model, { id: +o.id_model, rundef: o.rundef, name: o.model_name ?? o.model ?? o.name ?? null });
  }
  const names = {};
  for (const o of collect(json, (x) => x.id_model != null && (x.model_name || x.model_longname))) names[+o.id_model] = o.model_name || o.model_longname;
  const spot = collect(json, (x) => x.spotname || x.spot)[0];
  return { name: spot?.spotname ?? spot?.spot ?? null, models: [...seen.values()].map((m) => ({ ...m, name: m.name || names[m.id] || `modèle ${m.id}` })) };
}

// Échéance maximale de confiance selon le nom du modèle Windguru.
function horizons(name) {
  const n = name.toLowerCase();
  if (/arome|harmonie|wrf|wg|icon.?d2|1\.3|2\.5|3 ?km|4 ?km/.test(n)) return { short: 24, lead: 72 };
  if (/icon|arpege|ecmwf|ifs/.test(n)) return { short: 72, lead: 180 };
  return { short: 48, lead: 240 };
}

export function parseForecast(json, model, timeZone) {
  const f = json?.fcst ?? json;
  if (!f || !Array.isArray(f.hours) || f.initstamp == null) throw new Error(`Windguru ${model.name} : format inattendu`);
  const init = +f.initstamp * 1000;
  const times = f.hours.map((h) => localKey(new Date(init + h * 3600000), timeZone).slice(0, 13) + ':00');
  const num = (arr, i) => (Array.isArray(arr) && arr[i] != null && arr[i] !== '' ? +arr[i] : null);
  const step = (i) => (i > 0 ? f.hours[i] - f.hours[i - 1] : (f.hours[1] ?? 1) - (f.hours[0] ?? 0)) || 1;
  const data = { temp: [], feels: [], precip: [], wind: [], gust: [], dir: [], cloud: [], rh: [], pressure: [], code: [] };
  f.hours.forEach((_, i) => {
    data.temp.push(num(f.TMP, i));
    data.wind.push(num(f.WINDSPD, i));
    data.gust.push(num(f.GUST, i));
    data.dir.push(num(f.WINDDIR, i));
    data.cloud.push(num(f.TCDC, i));
    data.rh.push(num(f.RH, i));
    data.pressure.push(num(f.SLP, i));
    const p1 = num(f.APCP1, i);
    const p = num(f.APCP, i);
    data.precip.push(p1 != null ? p1 : p != null ? p / step(i) : null);
    data.feels.push(null);
    data.code.push(null);
  });
  // Windguru publie souvent par pas de 3 h : on remplit les heures intermédiaires par interpolation.
  return { ...interpolateHourly(times, data), initIso: new Date(init).toISOString() };
}

function interpolateHourly(times, data) {
  const outTimes = [];
  const out = Object.fromEntries(Object.keys(data).map((k) => [k, []]));
  for (let i = 0; i < times.length; i++) {
    outTimes.push(times[i]);
    for (const k of Object.keys(data)) out[k].push(data[k][i]);
    if (i + 1 >= times.length) break;
    const gap = Math.round((Date.parse(times[i + 1] + ':00Z') - Date.parse(times[i] + ':00Z')) / 3600000);
    for (let g = 1; g < gap && gap <= 6; g++) {
      const t = new Date(Date.parse(times[i] + ':00Z') + g * 3600000).toISOString().slice(0, 16);
      outTimes.push(t);
      for (const k of Object.keys(data)) {
        const a = data[k][i], b = data[k][i + 1];
        if (a == null || b == null) { out[k].push(null); continue; }
        if (k === 'precip') { out[k].push(b); continue; } // pluie horaire moyenne de l'intervalle
        if (k === 'dir') { const d = ((b - a + 540) % 360) - 180; out[k].push((a + d * g / gap + 360) % 360); continue; }
        out[k].push(a + (b - a) * g / gap);
      }
    }
  }
  return { times: outTimes, data: out };
}

export async function fetchWindguru(config) {
  const wg = config.windguru || {};
  const log = [];
  let spotId = wg.spotId;
  if (!spotId) {
    const spot = await findSpot(wg.search || config.place, config.latitude, config.longitude);
    spotId = spot.id;
    log.push(`Spot Windguru trouvé automatiquement : ${spot.name} (#${spot.id})`);
  }
  const info = await spotModels(spotId);
  if (!info.models.length) throw new Error(`Windguru : aucun modèle pour le spot #${spotId}`);
  const sources = [];
  for (const m of info.models) {
    try {
      const json = await call({ q: 'forecast', id_model: String(m.id), rundef: m.rundef, id_spot: String(spotId), WGCACHEABLE: '21600', cachefix: `${config.latitude}x${config.longitude}x0` });
      const parsed = parseForecast(json, m, config.timezone);
      sources.push({ id: `windguru_${m.id}`, label: `Windguru ${m.name}`, provider: 'Windguru', kind: 'windguru', prior: WINDGURU_PRIOR, ...horizons(m.name), ...parsed });
    } catch (e) {
      log.push(e.message);
    }
  }
  return { spotId, spotName: info.name, sources, log };
}
