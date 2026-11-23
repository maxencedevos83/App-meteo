// Score des sorties (bateau, baignade, balade, vélo), heure par heure, et meilleurs créneaux.
// Module partagé (navigateur et Node). Les seuils sont des réglages de départ raisonnables, modifiables ici.
// Unités internes : vent et rafales en nœuds, pluie en mm par heure, probabilité de pluie entre 0 et 1.
import { dirLabel } from './ensemble.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const kn = (kmh) => kmh / 1.852; // seuils écrits en km/h, comparés à des nœuds
// La prévision combinée donne la probabilité entre 0 et 1 ; l'affichage la donne en %. On accepte les deux.
const popFrac = (p) => (!isNum(p) ? 0 : p > 1 ? p / 100 : Math.max(0, p));

// Plateau : 1 entre b et c, rampes linéaires de a à b et de c à d, 0 en dehors.
function trap(x, a, b, c, d) {
  if (!isNum(x)) return 0;
  if (x <= a || x >= d) return 0;
  if (x < b) return (x - a) / (b - a);
  if (x <= c) return 1;
  return (d - x) / (d - c);
}
// 1 jusqu'à `ok`, puis décroît linéairement jusqu'à 0 à `bad`.
const below = (x, ok, bad) => (!isNum(x) || x <= ok ? 1 : x >= bad ? 0 : (bad - x) / (bad - ok));

// Angle entre la direction d'où vient le vent et la direction « vers la mer » de la plage.
// 0 = vent de mer (onshore), 180 = vent de terre (offshore).
export function shoreAngle(windFrom, shoreFacing) {
  return Math.abs(((windFrom - shoreFacing) % 360 + 540) % 360 - 180);
}

export const ACTIVITIES = [
  { id: 'bateau', label: 'Sortie bateau', emoji: '🚤', sea: true },
  { id: 'baignade', label: 'Baignade', emoji: '🏊', sea: true },
  { id: 'balade', label: 'Balade à pied', emoji: '🚶' },
  { id: 'velo', label: 'Vélo', emoji: '🚲' },
];

// Tolérances par activité. Vent en km/h (convertis en nœuds) : [plein score jusqu'à, nul à partir de].
const RULES = {
  bateau: { rain: 2, wind: [18, 37], gust: [30, 50], night: 0.2 },
  baignade: { rain: 1.5, wind: [18, 33], gust: [25, 45], night: 0.2 },
  balade: { rain: 2, wind: [25, 55], gust: [40, 75], wetGround: 0.85, night: 0.4, temp: [0, 8, 28, 36] },
  velo: { rain: 1, wind: [15, 40], gust: [30, 55], wetGround: 0.6, night: 0.4, temp: [2, 10, 27, 35] },
};

const isThunder = (h) => h?.code >= 95;
const isSnow = (h) => h && ((h.code >= 71 && h.code <= 77) || h.code === 85 || h.code === 86);

// Contexte autour d'une heure : une sortie dure 2 à 3 h, et la pluie tombée juste avant compte aussi.
// hours : toute la série ; i : indice de l'heure ; dayRain : cumul de pluie de la journée (mm).
export function hourContext(hours, i, dayRain = null) {
  const ahead = hours.slice(i, i + 3);
  const around = hours.slice(Math.max(0, i - 1), i + 3);
  const before = hours.slice(Math.max(0, i - 3), i);
  return {
    rainAhead: Math.max(0, ...ahead.map((h) => h.precip ?? 0)),
    popAhead: Math.max(0, ...ahead.slice(0, 2).map((h) => popFrac(h.pop))),
    gustAhead: Math.max(0, ...ahead.map((h) => h.gust ?? h.wind ?? 0)),
    windAhead: Math.max(0, ...ahead.map((h) => h.wind ?? 0)),
    rainBefore: before.reduce((s, h) => s + (h.precip ?? 0), 0),
    thunderNear: around.some(isThunder),
    dayRain,
  };
}

// h : heure combinée ; sea : état de la mer à la même heure ; shoreFacing : orientation de la plage (°) ;
// ctx : contexte des heures voisines (hourContext). Sans ctx, seule l'heure elle-même compte.
export function scoreHour(id, h, sea, shoreFacing, ctx = null) {
  const r = RULES[id];
  if (!r) return { score: 0, notes: [] };
  const wind = h.wind ?? 0;
  const gust = Math.max(h.gust ?? wind, ctx?.gustAhead ?? 0);
  const windMax = Math.max(wind, ctx?.windAhead ?? 0);
  const rain = Math.max(h.precip ?? 0, ctx?.rainAhead ?? 0);
  const pop = Math.max(popFrac(h.pop), ctx?.popAhead ?? 0);
  const wave = sea?.wave ?? null;
  const angle = isNum(h.dir) ? shoreAngle(h.dir, shoreFacing) : 90;
  const offshore = angle > 120; // vent de terre : dangereux pour les engins qui dérivent au large
  const temp = isNum(h.feels) ? h.feels : h.temp;
  const notes = [];
  const note = (n) => { if (!notes.includes(n)) notes.push(n); };
  let s = 1;

  // Vent moyen et rafales (pire valeur sur la durée de la sortie).
  const fw = below(windMax, kn(r.wind[0]), kn(r.wind[1]));
  const fg = below(gust, kn(r.gust[0]), kn(r.gust[1]));
  s *= fw * fg;
  if (windMax >= kn(r.wind[0] + 10)) note('vent fort');
  if (gust >= kn(r.gust[0] + 10)) note('rafales');

  switch (id) {
    case 'bateau':
      s *= wave != null ? trap(wave, -1, 0, 0.5, 1.2) : 0.8;
      if (offshore && wind > 10) { s *= 0.6; note('vent de terre'); }
      if (wave != null && wave > 0.8) note('mer agitée');
      if (h.code === 45 || h.code === 48) { s *= 0.5; note('brouillard'); }
      break;
    case 'baignade': {
      const sst = sea?.sst;
      s *= (isNum(sst) ? trap(sst, 16, 21, 30, 32) : 0.4) * trap(h.temp, 17, 23, 36, 40)
        * (wave != null ? trap(wave, -1, 0, 0.5, 1.2) : 0.8) * clamp01(1.2 - (h.cloud ?? 0) / 100);
      break;
    }
    default: {
      // Balade et vélo : température ressentie, ciel, sol mouillé, neige.
      s *= trap(temp, ...r.temp) * clamp01(1.1 - (h.cloud ?? 0) / 300);
      if (isNum(temp) && temp < r.temp[1]) note('froid');
      if (isNum(temp) && temp > r.temp[2]) note('chaleur');
      if ((ctx?.rainBefore ?? 0) >= 1) { s *= r.wetGround; note(id === 'velo' ? 'routes mouillées' : 'sol mouillé'); }
      if (isSnow(h)) { s *= 0.2; note('neige'); }
    }
  }

  // Pluie : quantité prévue (mm/h) et probabilité, sur la durée de la sortie.
  s *= below(rain, 0.1, r.rain) * (1 - 0.8 * pop);
  if (rain >= 0.5 || pop >= 0.6) note(rain >= 2 ? 'forte pluie' : 'pluie');
  else if (rain >= 0.1 || pop >= 0.3) note('averses possibles');
  // Journée très arrosée : averses entre deux accalmies, chemins et routes détrempés, eau trouble.
  const day = ctx?.dayRain ?? 0;
  if (day >= 5) {
    s *= day >= 30 ? 0.1 : day >= 15 ? 0.5 - 0.4 * (day - 15) / 15 : 1 - 0.5 * (day - 5) / 10;
    note(`journée pluvieuse (${Math.round(day)} mm)`);
  }
  if (isThunder(h)) { s *= 0.05; note('orages'); }
  else if (ctx?.thunderNear) { s *= 0.3; note('orages'); }
  if (!h.isDay) s *= r.night;
  return { score: Math.round(clamp01(s) * 100), notes };
}

// Meilleurs créneaux : heures consécutives de jour avec un bon score.
export function bestWindows(hours, scores, { min = 60, minLength = 2, max = 4 } = {}) {
  const windows = [];
  let cur = null;
  const close = () => {
    if (cur && cur.n >= minLength) windows.push(cur);
    cur = null;
  };
  hours.forEach((h, i) => {
    const sc = scores[i];
    if (sc >= min && h.isDay) {
      if (!cur) cur = { start: h.time, end: h.time, n: 0, sum: 0, peak: 0, i0: i };
      cur.end = h.time; cur.n++; cur.sum += sc; cur.peak = Math.max(cur.peak, sc);
    } else close();
  });
  close();
  return windows
    .map((w) => ({ start: w.start, end: w.end, hours: w.n, score: Math.round(w.sum / w.n), peak: w.peak, i0: w.i0 }))
    .sort((a, b) => b.score * Math.sqrt(b.hours) - a.score * Math.sqrt(a.hours))
    .slice(0, max)
    .sort((a, b) => a.start.localeCompare(b.start));
}

// Le lieu est-il au bord de la mer ? Oui s'il est déclaré comme tel (orientation de plage dans la config)
// ou si le modèle de vagues y donne des valeurs. Sinon (ville de l'intérieur), ni bateau ni baignade.
export const hasSeaData = (marine) => !!marine?.some((m) => isNum(m.wave) || isNum(m.sst));

// coastal : null = déduit des données de mer.
export function buildActivities(hours, marine, shoreFacing = 180, coastal = null) {
  const atSea = coastal ?? hasSeaData(marine);
  const seaAt = new Map((marine || []).map((m) => [m.time, m]));
  const span = hours.slice(0, 120);
  // Cumul de pluie par jour (sur les heures connues) : 55 mm dans la journée ne laissent pas de vraie fenêtre sèche.
  const dayRain = new Map();
  for (const h of hours) dayRain.set(h.time.slice(0, 10), (dayRain.get(h.time.slice(0, 10)) ?? 0) + (h.precip ?? 0));
  const ctx = span.map((h, i) => hourContext(hours, i, dayRain.get(h.time.slice(0, 10))));
  return ACTIVITIES.filter((a) => atSea || !a.sea).map((a) => {
    const rows = span.map((h, i) => scoreHour(a.id, h, seaAt.get(h.time), shoreFacing, ctx[i]));
    const scores = rows.map((r) => r.score);
    const windows = bestWindows(span, scores).map((w) => {
      const slice = span.slice(w.i0, w.i0 + w.hours);
      const wind = Math.round(slice.reduce((s, h) => s + (h.wind ?? 0), 0) / slice.length);
      const gust = Math.round(Math.max(...slice.map((h) => h.gust ?? 0)));
      const notes = [...new Set(rows.slice(w.i0, w.i0 + w.hours).flatMap((r) => r.notes))];
      const { i0, ...rest } = w;
      return { ...rest, wind, gust, dir: dirLabel(slice[Math.floor(slice.length / 2)].dir), notes };
    });
    return { ...a, scores, windows, why: windows.length ? [] : mainReasons(span, rows) };
  });
}

// Sans bon créneau : les raisons les plus fréquentes pendant les heures de jour (pluie, vent…).
function mainReasons(span, rows) {
  const count = new Map();
  rows.forEach((r, i) => {
    if (!span[i].isDay) return;
    for (const n of r.notes) {
      const k = n.startsWith('journée pluvieuse') ? 'pluie' : n === 'forte pluie' || n === 'averses possibles' ? 'pluie' : n;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  });
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
}

// Drapeau de baignade estimé (vert / jaune / rouge) d'après la mer, le vent et les orages.
// Ce n'est pas le drapeau officiel, hissé par les sauveteurs pendant la saison surveillée.
export function beachFlag(h, sea, shoreFacing = 180) {
  if (!h) return null;
  const wave = sea?.wave ?? null;
  const wind = h.wind ?? 0, gust = h.gust ?? wind;
  const offshore = isNum(h.dir) && shoreAngle(h.dir, shoreFacing) > 120;
  const why = [];
  let level = 0;
  const up = (l, reason) => { if (l >= level) { if (l > level) why.length = 0; level = l; why.push(reason); } };
  if (h.code >= 95) up(2, 'orages');
  if (wave != null && wave >= 1.5) up(2, `vagues ${wave.toFixed(1)} m`);
  else if (wave != null && wave >= 0.8) up(1, `vagues ${wave.toFixed(1)} m`);
  if (gust >= 30) up(2, 'rafales fortes');
  else if (gust >= 22 || wind >= 15) up(1, 'vent soutenu');
  if (offshore && wind >= 15) up(2, 'vent de terre fort');
  else if (offshore && wind >= 8) up(1, 'vent de terre');
  const [color, label] = [['vert', 'Baignade sans danger particulier'], ['jaune', 'Baignade dangereuse mais surveillée'], ['rouge', 'Baignade interdite']][level];
  return { level, color, label, why };
}
