// Moteur de combinaison des modèles météo.
// Module partagé : utilisé par le navigateur (appli) et par Node (scripts/update.mjs).

export const VARS = ['temp', 'feels', 'precip', 'wind', 'gust', 'dir', 'cloud', 'rh', 'pressure', 'code'];

// Poids a priori par modèle et par variable, avant toute vérification locale.
// lead: échéance (h) au-delà de laquelle le modèle n'a plus de données fiables.
// short: échéance jusqu'à laquelle le modèle garde son poids plein.
export const MODELS = [
  { id: 'meteofrance_arome_france_hd', label: 'AROME HD 1,5 km', provider: 'Météo-France', short: 24, lead: 42,
    prior: { temp: 1.5, wind: 1.4, precip: 1.4, cloud: 1.2 } },
  { id: 'meteofrance_arome_france', label: 'AROME 2,5 km', provider: 'Météo-France', short: 30, lead: 48,
    prior: { temp: 1.4, wind: 1.3, precip: 1.3, cloud: 1.2 } },
  { id: 'meteofrance_arpege_europe', label: 'ARPEGE', provider: 'Météo-France', short: 48, lead: 102,
    prior: { temp: 1.0, wind: 1.0, precip: 1.0, cloud: 1.0 } },
  { id: 'ecmwf_ifs025', label: 'ECMWF IFS', provider: 'ECMWF', short: 120, lead: 360,
    prior: { temp: 1.3, wind: 1.2, precip: 1.2, cloud: 1.1 } },
  { id: 'ecmwf_aifs025_single', label: 'ECMWF AIFS (IA)', provider: 'ECMWF', short: 120, lead: 360,
    prior: { temp: 1.2, wind: 1.1, precip: 0.9, cloud: 0.8 } },
  { id: 'icon_d2', label: 'ICON-D2', provider: 'DWD', short: 24, lead: 48,
    prior: { temp: 1.1, wind: 1.1, precip: 1.1, cloud: 1.0 } },
  { id: 'icon_eu', label: 'ICON-EU', provider: 'DWD', short: 48, lead: 120,
    prior: { temp: 1.0, wind: 1.0, precip: 1.0, cloud: 1.0 } },
  { id: 'knmi_harmonie_arome_europe', label: 'HARMONIE-AROME', provider: 'KNMI', short: 24, lead: 60,
    prior: { temp: 1.0, wind: 1.0, precip: 1.0, cloud: 1.0 } },
  { id: 'ukmo_seamless', label: 'UKMO', provider: 'Met Office', short: 72, lead: 168,
    prior: { temp: 1.0, wind: 1.0, precip: 0.9, cloud: 0.9 } },
  { id: 'gfs_seamless', label: 'GFS', provider: 'NOAA', short: 72, lead: 384,
    prior: { temp: 0.8, wind: 0.8, precip: 0.8, cloud: 0.8 } },
];

// Windguru : Maxence le trouve très fiable sur son spot, surtout pour le vent.
export const WINDGURU_PRIOR = { temp: 0.9, wind: 1.6, precip: 0.9, cloud: 0.8 };

// Variable de poids pour chaque grandeur combinée.
const WEIGHT_KEY = { temp: 'temp', feels: 'temp', rh: 'temp', pressure: 'temp', wind: 'wind', gust: 'wind', dir: 'wind', precip: 'precip', code: 'precip', cloud: 'cloud' };

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Décroissance du poids avec l'échéance : plein poids jusqu'à `short`, puis baisse linéaire jusqu'à 25 % à `lead`.
export function leadFactor(source, leadHours) {
  const short = source.short ?? 72;
  const lead = source.lead ?? 240;
  if (leadHours > lead) return 0;
  if (leadHours <= short) return 1;
  return 1 - 0.75 * (leadHours - short) / Math.max(1, lead - short);
}

// Corrections issues de la vérification locale (voir scripts/verify.mjs).
// skill[model][var] = { factor, bias, ratio }
function corrected(value, varName, sk) {
  if (!isNum(value) || !sk) return value;
  if ((varName === 'temp' || varName === 'feels') && sk.temp && isNum(sk.temp.bias)) return value - sk.temp.bias;
  if ((varName === 'wind' || varName === 'gust') && sk.wind && isNum(sk.wind.ratio)) return value * sk.wind.ratio;
  return value;
}

export function sourceWeight(source, varName, leadHours, skill) {
  const key = WEIGHT_KEY[varName] || 'temp';
  const prior = source.prior?.[key] ?? 1;
  const factor = skill?.[source.id]?.[key]?.factor ?? 1;
  return prior * factor * leadFactor(source, leadHours);
}

function weightedMean(pairs) {
  let sw = 0, s = 0;
  for (const [v, w] of pairs) { s += v * w; sw += w; }
  return sw > 0 ? s / sw : null;
}

function weightedStd(pairs, mean) {
  let sw = 0, s = 0;
  for (const [v, w] of pairs) { s += w * (v - mean) ** 2; sw += w; }
  return sw > 0 ? Math.sqrt(s / sw) : 0;
}

function circularMean(pairs) {
  let x = 0, y = 0;
  for (const [deg, w] of pairs) {
    const r = deg * Math.PI / 180;
    x += Math.sin(r) * w; y += Math.cos(r) * w;
  }
  if (x === 0 && y === 0) return null;
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}

// Différence en heures entre deux horodatages locaux "AAAA-MM-JJTHH:MM".
export function hoursBetween(a, b) {
  return (Date.parse(b + ':00Z') - Date.parse(a + ':00Z')) / 3600000;
}

// Code météo WMO déduit des grandeurs combinées (et non d'un vote), pour rester cohérent avec la pluie affichée.
export function deriveCode({ precip, cloud, temp, thunderShare = 0, fogShare = 0, snowShare = 0 }) {
  const p = precip ?? 0;
  const snowy = snowShare > 0.5 || (isNum(temp) && temp <= 0.5);
  if (thunderShare >= 0.3 && p >= 0.1) return thunderShare >= 0.6 && p >= 4 ? 96 : 95;
  if (p >= 0.1) {
    if (snowy) return p >= 2 ? 75 : p >= 0.6 ? 73 : 71;
    if (p >= 4) return 65;
    if (p >= 1) return 63;
    if (p >= 0.3) return 61;
    return 51;
  }
  if (fogShare >= 0.4) return 45;
  const c = cloud ?? 0;
  if (c >= 85) return 3;
  if (c >= 50) return 2;
  if (c >= 20) return 1;
  return 0;
}

// sources : [{ id, label, prior, short, lead, times: [...], data: { temp: [...], ... } }]
// options : { now: "AAAA-MM-JJTHH:MM", skill, ensemblePop: { time: proba 0..1 } }
export function combine(sources, { now, skill = {}, ensemblePop = {} } = {}) {
  const startKey = now ? now.slice(0, 13) + ':00' : null;
  const timeSet = new Set();
  const index = sources.map((s) => {
    const m = new Map();
    s.times.forEach((t, i) => { m.set(t, i); if (!startKey || t >= startKey) timeSet.add(t); });
    return m;
  });
  const times = [...timeSet].sort();
  const hours = [];
  const totalWeights = {};

  for (const t of times) {
    const lead = startKey ? Math.max(0, hoursBetween(startKey, t)) : 0;
    const vals = {};
    for (const v of VARS) vals[v] = [];

    sources.forEach((s, si) => {
      const i = index[si].get(t);
      if (i === undefined) return;
      const sk = skill[s.id];
      for (const v of VARS) {
        const raw = s.data[v]?.[i];
        if (!isNum(raw)) continue;
        const w = sourceWeight(s, v, lead, skill);
        if (w <= 0) continue;
        vals[v].push([corrected(raw, v, sk), w, s.id]);
      }
    });

    if (!vals.temp.length) continue;
    const out = { time: t, lead: Math.round(lead), n: vals.temp.length };
    for (const v of ['temp', 'feels', 'wind', 'gust', 'cloud', 'rh', 'pressure', 'precip']) {
      if (!vals[v].length) { out[v] = null; continue; }
      out[v] = weightedMean(vals[v]);
    }
    out.tempSpread = out.temp != null ? weightedStd(vals.temp, out.temp) : 0;
    out.windSpread = out.wind != null ? weightedStd(vals.wind, out.wind) : 0;
    out.dir = vals.dir.length ? circularMean(vals.dir) : null;
    if (out.gust != null && out.wind != null && out.gust < out.wind) out.gust = out.wind;

    // Probabilité de pluie : part pondérée des modèles qui prévoient ≥ 0,2 mm, mélangée à l'ensemble ECMWF (51 membres).
    let modelPop = null;
    if (vals.precip.length) {
      let sw = 0, wet = 0;
      for (const [p, w] of vals.precip) { sw += w; if (p >= 0.2) wet += w; }
      modelPop = wet / sw;
    }
    const ens = ensemblePop[t];
    out.pop = modelPop == null ? (isNum(ens) ? ens : null)
      : isNum(ens) ? 0.6 * modelPop + 0.4 * ens : modelPop;

    // Phénomènes signalés par le code WMO de chaque modèle.
    let sw = 0, thunder = 0, fog = 0, snow = 0;
    for (const [c, w] of vals.code) {
      sw += w;
      if (c >= 95) thunder += w;
      if (c === 45 || c === 48) fog += w;
      if ((c >= 71 && c <= 77) || c === 85 || c === 86) snow += w;
    }
    const share = (x) => (sw > 0 ? x / sw : 0);
    out.code = deriveCode({ precip: out.precip, cloud: out.cloud, temp: out.temp, thunderShare: share(thunder), fogShare: share(fog), snowShare: share(snow) });

    // Indice de confiance : accord entre modèles (température, vent, pluie) et échéance.
    const pd = out.pop == null ? 0 : 4 * out.pop * (1 - out.pop);
    const disagreement = 0.45 * clamp(out.tempSpread / 3, 0, 1) + 0.3 * clamp(out.windSpread / 8, 0, 1) + 0.25 * pd;
    const leadPenalty = clamp(lead / 240, 0, 1) * 0.35;
    out.confidence = Math.round(100 * clamp(1 - disagreement - leadPenalty, 0.05, 1));

    // Poids effectifs (pour l'écran « Sources »), sur les 48 premières heures.
    if (lead <= 48) {
      for (const [, w, id] of vals.temp) totalWeights[id] = (totalWeights[id] || 0) + w;
    }
    hours.push(out);
  }

  const sum = Object.values(totalWeights).reduce((a, b) => a + b, 0) || 1;
  const weights = Object.fromEntries(Object.entries(totalWeights).map(([k, v]) => [k, v / sum]));
  return { hours, weights };
}

// Agrégation journalière (date locale).
export function daily(hours) {
  const byDay = new Map();
  for (const h of hours) {
    const d = h.time.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(h);
  }
  const days = [];
  for (const [date, hs] of byDay) {
    const temps = hs.map((h) => h.temp).filter(isNum);
    const day = hs.filter((h) => { const hr = +h.time.slice(11, 13); return hr >= 8 && hr <= 20; });
    const ref = day.length ? day : hs;
    const precip = hs.reduce((a, h) => a + (h.precip || 0), 0);
    const pop = Math.max(0, ...hs.map((h) => h.pop ?? 0));
    const gust = Math.max(0, ...hs.map((h) => h.gust ?? 0));
    const wind = Math.max(0, ...ref.map((h) => h.wind ?? 0));
    const dir = circularMean(ref.filter((h) => isNum(h.dir)).map((h) => [h.dir, (h.wind || 0) + 0.1]));
    const cloud = ref.reduce((a, h) => a + (h.cloud ?? 0), 0) / ref.length;
    // Le phénomène le plus marquant de la journée l'emporte.
    const sig = (c) => (c >= 95 ? 6 : c >= 71 && c <= 77 ? 5 : c >= 61 ? 4 : c >= 51 ? 3 : c === 45 ? 2 : 0);
    let code = deriveCode({ precip: 0, cloud });
    for (const h of ref) if (sig(h.code) > sig(code)) code = h.code;
    if (precip < 0.5 && sig(code) >= 3 && sig(code) < 6) code = deriveCode({ precip: 0, cloud: Math.max(cloud, 60) });
    days.push({
      date,
      min: temps.length ? Math.min(...temps) : null,
      max: temps.length ? Math.max(...temps) : null,
      precip, pop, wind, gust, dir, code,
      confidence: Math.round(hs.reduce((a, h) => a + h.confidence, 0) / hs.length),
      partial: hs.length < 20,
    });
  }
  return days;
}

// ---------- Libellés ----------

export const CODE_LABELS = {
  0: 'Ensoleillé', 1: 'Peu nuageux', 2: 'Partiellement nuageux', 3: 'Couvert',
  45: 'Brouillard', 48: 'Brouillard givrant',
  51: 'Bruine', 53: 'Bruine', 55: 'Bruine forte',
  61: 'Pluie faible', 63: 'Pluie', 65: 'Forte pluie',
  71: 'Neige faible', 73: 'Neige', 75: 'Forte neige', 77: 'Grésil',
  80: 'Averses', 81: 'Averses', 82: 'Fortes averses',
  95: 'Orages', 96: 'Orages forts', 99: 'Orages de grêle',
};

export function codeLabel(code, isDay = true) {
  if (!isDay && code === 0) return 'Ciel dégagé';
  return CODE_LABELS[code] || 'Variable';
}

export function codeEmoji(code, isDay = true) {
  if (code === 0) return isDay ? '☀️' : '🌙';
  if (code === 1) return isDay ? '🌤️' : '🌙';
  if (code === 2) return isDay ? '⛅' : '☁️';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 55) return '🌦️';
  if (code >= 61 && code <= 65) return '🌧️';
  if (code >= 71 && code <= 77) return '🌨️';
  if (code >= 80 && code <= 82) return '🌦️';
  if (code >= 95) return '⛈️';
  return '🌡️';
}

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
export function dirLabel(deg) {
  if (!isNum(deg)) return '';
  return DIRS[Math.round(deg / 22.5) % 16];
}

// Repère local pour l'heure courante dans un fuseau : "AAAA-MM-JJTHH:MM".
export function localKey(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
