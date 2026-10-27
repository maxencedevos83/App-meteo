// Score des sorties (bateau, baignade, balade), heure par heure, et meilleurs créneaux.
// Module partagé (navigateur et Node). Les seuils sont des réglages de départ raisonnables, modifiables ici.
import { dirLabel } from './ensemble.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Plateau : 1 entre b et c, rampes linéaires de a à b et de c à d, 0 en dehors.
function trap(x, a, b, c, d) {
  if (!isNum(x)) return 0;
  if (x <= a || x >= d) return 0;
  if (x < b) return (x - a) / (b - a);
  if (x <= c) return 1;
  return (d - x) / (d - c);
}

// Angle entre la direction d'où vient le vent et la direction « vers la mer » de la plage.
// 0 = vent de mer (onshore), 180 = vent de terre (offshore).
export function shoreAngle(windFrom, shoreFacing) {
  return Math.abs(((windFrom - shoreFacing) % 360 + 540) % 360 - 180);
}

export const ACTIVITIES = [
  { id: 'bateau', label: 'Sortie bateau', emoji: '🚤' },
  { id: 'baignade', label: 'Baignade', emoji: '🏊' },
  { id: 'balade', label: 'Balade / vélo', emoji: '🚶' },
];

// h : heure combinée ; sea : état de la mer à la même heure ; shoreFacing : orientation de la plage (°).
export function scoreHour(id, h, sea, shoreFacing) {
  const wind = h.wind ?? 0, gust = h.gust ?? wind;
  const gustiness = wind > 3 ? gust / wind : 1;
  const wet = (h.pop ?? 0) / 100;
  const thunder = h.code >= 95;
  const wave = sea?.wave ?? null;
  const angle = isNum(h.dir) ? shoreAngle(h.dir, shoreFacing) : 90;
  const offshore = angle > 120; // vent de terre : dangereux pour les engins qui dérivent au large
  const notes = [];
  let s;

  switch (id) {
    case 'bateau': {
      // Mer calme et vent modéré : au-delà de 25 km/h (≈ 14 nœuds) ou 0,8 m de vagues, la sortie devient inconfortable.
      s = trap(wind, -1, 0, 10, 20) * trap(gust, -1, 0, 16, 27) * (wave != null ? trap(wave, -1, 0, 0.5, 1.2) : 0.8)
        * (offshore && wind > 10 ? 0.6 : 1);
      if (offshore && wind > 10) notes.push('vent de terre');
      if (wave != null && wave > 0.8) notes.push('mer agitée');
      if (gust > 20) notes.push('rafales');
      break;
    }
    case 'baignade': {
      const sst = sea?.sst;
      s = (isNum(sst) ? trap(sst, 16, 21, 30, 32) : 0.4) * trap(h.temp, 17, 23, 36, 40)
        * trap(wind, -1, 0, 10, 18) * (wave != null ? trap(wave, -1, 0, 0.5, 1.2) : 0.8) * clamp01(1.2 - (h.cloud ?? 0) / 100);
      break;
    }
    case 'balade': {
      s = trap(h.temp, 4, 12, 26, 34) * trap(gust, -1, 0, 25, 40) * clamp01(1.1 - (h.cloud ?? 0) / 300);
      break;
    }
    default: s = 0;
  }
  s *= clamp01(1 - wet * 0.9);
  if (thunder) { s *= 0.1; notes.push('orages'); }
  if (wet > 0.5) notes.push('pluie');
  if (!h.isDay && id !== 'balade') s *= 0.2;
  if (!h.isDay && id === 'balade') s *= 0.5;
  return { score: Math.round(s * 100), notes };
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

export function buildActivities(hours, marine, shoreFacing = 180) {
  const seaAt = new Map((marine || []).map((m) => [m.time, m]));
  const span = hours.slice(0, 120);
  return ACTIVITIES.map((a) => {
    const rows = span.map((h) => scoreHour(a.id, h, seaAt.get(h.time), shoreFacing));
    const scores = rows.map((r) => r.score);
    const windows = bestWindows(span, scores).map((w) => {
      const slice = span.slice(w.i0, w.i0 + w.hours);
      const wind = Math.round(slice.reduce((s, h) => s + (h.wind ?? 0), 0) / slice.length);
      const gust = Math.round(Math.max(...slice.map((h) => h.gust ?? 0)));
      const notes = [...new Set(rows.slice(w.i0, w.i0 + w.hours).flatMap((r) => r.notes))];
      const { i0, ...rest } = w;
      return { ...rest, wind, gust, dir: dirLabel(slice[Math.floor(slice.length / 2)].dir), notes };
    });
    return { ...a, scores, windows };
  });
}
