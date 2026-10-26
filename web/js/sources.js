// Récupération des sources accessibles depuis le navigateur comme depuis Node (Open-Meteo).
import { MODELS } from './ensemble.js';

const HOURLY = {
  temp: 'temperature_2m',
  feels: 'apparent_temperature',
  precip: 'precipitation',
  code: 'weather_code',
  cloud: 'cloud_cover',
  wind: 'wind_speed_10m',
  gust: 'wind_gusts_10m',
  dir: 'wind_direction_10m',
  rh: 'relative_humidity_2m',
  pressure: 'pressure_msl',
};

async function getJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function base(lat, lon, timeZone) {
  return `latitude=${lat}&longitude=${lon}&timezone=${encodeURIComponent(timeZone)}&wind_speed_unit=kn`;
}

// Un appel par modèle : un modèle indisponible ou hors domaine n'empêche pas les autres.
export async function fetchOpenMeteoModel(model, lat, lon, timeZone, fetchImpl) {
  const url = `https://api.open-meteo.com/v1/forecast?${base(lat, lon, timeZone)}`
    + `&hourly=${Object.values(HOURLY).join(',')}&forecast_days=10&models=${model.id}`;
  const json = await getJson(url, fetchImpl);
  const h = json.hourly || {};
  const pick = (name) => h[`${name}_${model.id}`] ?? h[name];
  const data = {};
  for (const [k, name] of Object.entries(HOURLY)) data[k] = pick(name) || [];
  if (!data.temp.some((v) => v != null)) throw new Error(`${model.id} : aucune donnée sur ce point`);
  return { ...model, kind: 'open-meteo', times: h.time, data };
}

export async function fetchAllOpenMeteo(lat, lon, timeZone, fetchImpl) {
  const results = await Promise.allSettled(MODELS.map((m) => fetchOpenMeteoModel(m, lat, lon, timeZone, fetchImpl)));
  const sources = [];
  const errors = [];
  results.forEach((r, i) => (r.status === 'fulfilled' ? sources.push(r.value) : errors.push(`${MODELS[i].id}: ${r.reason?.message}`)));
  return { sources, errors };
}

// Ensemble ECMWF (51 membres) : probabilité de pluie ≥ 0,2 mm par heure.
export async function fetchEnsemblePop(lat, lon, timeZone, fetchImpl) {
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?${base(lat, lon, timeZone)}`
    + '&hourly=precipitation&models=ecmwf_ifs025&forecast_days=10';
  const json = await getJson(url, fetchImpl);
  const h = json.hourly || {};
  const keys = Object.keys(h).filter((k) => k.startsWith('precipitation'));
  const pop = {};
  h.time.forEach((t, i) => {
    let n = 0, wet = 0;
    for (const k of keys) {
      const v = h[k][i];
      if (v == null) continue;
      n++; if (v >= 0.2) wet++;
    }
    if (n >= 10) pop[t] = wet / n;
  });
  return pop;
}

// Pluie dans l'heure (pas de 15 min, AROME en France), lever/coucher du soleil, UV.
export async function fetchNowcast(lat, lon, timeZone, fetchImpl) {
  const url = `https://api.open-meteo.com/v1/forecast?${base(lat, lon, timeZone)}`
    + '&minutely_15=precipitation&forecast_minutely_15=12&past_minutely_15=1'
    + '&current=is_day,temperature_2m&daily=sunrise,sunset,uv_index_max&forecast_days=10';
  const json = await getJson(url, fetchImpl);
  const m = json.minutely_15 || { time: [], precipitation: [] };
  return {
    minutely: m.time.map((t, i) => ({ time: t, precip: m.precipitation[i] })),
    isDay: json.current?.is_day === 1,
    sun: (json.daily?.time || []).map((d, i) => ({ date: d, sunrise: json.daily.sunrise[i], sunset: json.daily.sunset[i], uv: json.daily.uv_index_max?.[i] })),
  };
}

// État de la mer (vagues, température de l'eau).
export async function fetchMarine(lat, lon, timeZone, fetchImpl) {
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&timezone=${encodeURIComponent(timeZone)}`
    + '&hourly=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,wind_wave_height,sea_surface_temperature&forecast_days=6';
  const json = await getJson(url, fetchImpl);
  const h = json.hourly || {};
  if (!h.time) return null;
  return h.time.map((t, i) => ({
    time: t, wave: h.wave_height?.[i], waveDir: h.wave_direction?.[i], period: h.wave_period?.[i],
    swell: h.swell_wave_height?.[i], swellDir: h.swell_wave_direction?.[i], swellPeriod: h.swell_wave_period?.[i],
    windWave: h.wind_wave_height?.[i], sst: h.sea_surface_temperature?.[i],
  }));
}

// Nom de la ville à partir de coordonnées (service gratuit prévu pour être appelé depuis le navigateur).
export async function reverseGeocode(lat, lon, fetchImpl) {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=fr`;
  const json = await getJson(url, fetchImpl);
  return json.city || json.locality || json.principalSubdivision || 'Ma position';
}

export function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function geocode(query, fetchImpl) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=fr&format=json`;
  const json = await getJson(url, fetchImpl);
  return (json.results || []).map((r) => ({ name: r.name, admin: [r.admin1, r.country].filter(Boolean).join(', '), latitude: r.latitude, longitude: r.longitude, timezone: r.timezone }));
}
