// Assemble la prévision finale (appli) et le résumé compact (widgets).
import { combine, daily, codeLabel, codeEmoji, dirLabel, localKey } from './ensemble.js';

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r0 = (v) => (v == null ? null : Math.round(v));

export function isDayAt(time, sun) {
  const day = sun?.find((s) => s.date === time.slice(0, 10));
  if (!day) { const h = +time.slice(11, 13); return h >= 7 && h < 20; }
  return time >= day.sunrise && time < day.sunset;
}

export function rainNextHour(minutely, nowKey) {
  if (!minutely?.length) return { text: null, slots: [] };
  // Garde le créneau de 15 min en cours et les suivants.
  const nowMs = Date.parse(nowKey + ':00Z');
  const slots = minutely.filter((m) => Date.parse(m.time + ':00Z') + 15 * 60000 > nowMs).slice(0, 5);
  if (!slots.length) return { text: null, slots: [] };
  const wet = (m) => (m.precip ?? 0) >= 0.1;
  const hhmm = (t) => t.slice(11, 16).replace(':', 'h');
  let text;
  if (wet(slots[0])) {
    const end = slots.find((m) => !wet(m));
    text = end ? `Pluie en cours, fin vers ${hhmm(end.time)}` : 'Pluie en cours sur l\'heure';
  } else {
    const start = slots.find(wet);
    text = start ? `Pluie vers ${hhmm(start.time)}` : 'Pas de pluie dans l\'heure';
  }
  return { text, slots: slots.map((m) => ({ time: m.time, precip: r1(m.precip) })) };
}

// sources : modèles Open-Meteo + Windguru, déjà normalisés.
export function buildForecast({ config, sources, ensemblePop = {}, nowcast = null, marine = null, skill = {}, scores = null, errors = [], now = new Date() }) {
  const nowKey = localKey(now, config.timezone);
  const { hours, weights } = combine(sources, { now: nowKey, skill, ensemblePop });
  const sun = nowcast?.sun || [];
  for (const h of hours) h.isDay = isDayAt(h.time, sun);
  const days = daily(hours);
  for (const d of days) {
    const s = sun.find((x) => x.date === d.date);
    if (s) { d.sunrise = s.sunrise.slice(11); d.sunset = s.sunset.slice(11); d.uv = s.uv; }
  }

  // Détail par modèle sur 48 h, pour comparer les sources.
  const models = sources.map((s) => {
    const idx = s.times.findIndex((t) => t >= nowKey.slice(0, 13) + ':00');
    const sl = (arr) => (idx < 0 ? [] : arr.slice(idx, idx + 48).map(r1));
    return {
      id: s.id, label: s.label, provider: s.provider, weight: r1((weights[s.id] || 0) * 100),
      times: idx < 0 ? [] : s.times.slice(idx, idx + 48),
      temp: sl(s.data.temp || []), wind: sl(s.data.wind || []), gust: sl(s.data.gust || []), precip: sl(s.data.precip || []),
    };
  }).sort((a, b) => b.weight - a.weight);

  return {
    generatedAt: now.toISOString(),
    place: config.place,
    latitude: config.latitude,
    longitude: config.longitude,
    timezone: config.timezone,
    now: nowKey,
    rain: rainNextHour(nowcast?.minutely, nowKey),
    hours: hours.map((h) => ({
      time: h.time, temp: r1(h.temp), feels: r1(h.feels), tempSpread: r1(h.tempSpread),
      precip: r1(h.precip), pop: h.pop == null ? null : r0(h.pop * 100), wind: r0(h.wind), gust: r0(h.gust),
      windSpread: r1(h.windSpread), dir: r0(h.dir), cloud: r0(h.cloud), rh: r0(h.rh), pressure: r0(h.pressure),
      code: h.code, isDay: h.isDay, confidence: h.confidence, n: h.n,
    })),
    days: days.map((d) => ({ ...d, min: r1(d.min), max: r1(d.max), precip: r1(d.precip), pop: r0(d.pop * 100), wind: r0(d.wind), gust: r0(d.gust), dir: r0(d.dir) })),
    marine: marine ? marine.filter((m) => m.time >= nowKey.slice(0, 13) + ':00').slice(0, 48) : null,
    models,
    scores,
    errors,
  };
}

const FR_DAYS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const dayName = (date) => FR_DAYS[new Date(date + 'T12:00:00Z').getUTCDay()];

// Résumé plat, facile à lire pour KWGT ($wg(url, json, ".temp")$) et le widget Android.
export function buildWidget(fc) {
  const cur = fc.hours[0] || {};
  const today = fc.days[0] || {};
  const nextHours = [];
  for (let i = 1; i < fc.hours.length && nextHours.length < 6; i += 2) {
    const h = fc.hours[i];
    nextHours.push({ t: `${+h.time.slice(11, 13)}h`, temp: r0(h.temp), icon: codeEmoji(h.code, h.isDay), pop: h.pop ?? 0, wind: h.wind, gust: h.gust, dir: dirLabel(h.dir), dirDeg: h.dir });
  }
  const label = (i) => (i === 0 ? 'Auj.' : i === 1 ? 'Dem.' : dayName(fc.days[i].date));
  return {
    place: fc.place,
    updated: fc.now.slice(11, 16).replace(':', 'h'),
    updatedIso: fc.generatedAt,
    temp: r0(cur.temp),
    feels: r0(cur.feels),
    code: cur.code,
    icon: codeEmoji(cur.code, cur.isDay),
    cond: codeLabel(cur.code, cur.isDay),
    wind: cur.wind,
    gust: cur.gust,
    dir: dirLabel(cur.dir),
    dirDeg: cur.dir,
    pop: cur.pop ?? 0,
    rain: fc.rain?.text || '',
    min: r0(today.min),
    max: r0(today.max),
    confidence: cur.confidence,
    sea: fc.marine?.[0]?.sst != null ? r0(fc.marine[0].sst) : null,
    wave: fc.marine?.[0]?.wave != null ? r1(fc.marine[0].wave) : null,
    sources: fc.models.filter((m) => m.weight > 0).length,
    h: nextHours,
    d: fc.days.slice(0, 5).map((d, i) => ({ day: label(i), min: r0(d.min), max: r0(d.max), icon: codeEmoji(d.code, true), pop: d.pop, wind: d.wind, gust: d.gust })),
  };
}
