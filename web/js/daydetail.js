// Détail d'une journée de la prévision : quatre moments (nuit, matin, après-midi, soirée), tranches de 3 h
// et une phrase de résumé. Module partagé (navigateur et tests Node).
import { codeLabel, codeSeverity, dirLabel, kmh } from './ensemble.js';

export const PERIODS = [
  { name: 'Nuit', from: 0, to: 6 },
  { name: 'Matin', from: 6, to: 12 },
  { name: 'Après-midi', from: 12, to: 18 },
  { name: 'Soirée', from: 18, to: 24 },
];

const hourOf = (t) => +t.slice(11, 13);
const vals = (xs, k) => xs.map((x) => x[k]).filter((v) => v != null);
const maxOf = (xs, k) => { const v = vals(xs, k); return v.length ? Math.max(...v) : null; };
const minOf = (xs, k) => { const v = vals(xs, k); return v.length ? Math.min(...v) : null; };
const sumOf = (xs, k) => { const v = vals(xs, k); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) * 10) / 10 : null; };
const avgOf = (xs, k) => { const v = vals(xs, k); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

// Temps dominant : le code le plus marquant (orage > neige > pluie > brouillard > nuages > soleil) parmi
// ceux qui durent au moins une heure sur trois, pour qu'une averse isolée ne noircisse pas tout le moment.
function dominantCode(hs) {
  const codes = vals(hs, 'code');
  if (!codes.length) return null;
  const counts = new Map();
  for (const c of codes) counts.set(c, (counts.get(c) || 0) + 1);
  const frequent = [...counts].filter(([, n]) => n * 3 >= codes.length).map(([c]) => c);
  // Le plus grave d'abord, puis le plus marqué (ex. forte pluie avant pluie faible).
  return (frequent.length ? frequent : codes).reduce((a, b) => (codeSeverity(b) > codeSeverity(a) || (codeSeverity(b) === codeSeverity(a) && b > a) ? b : a));
}

function summarize(hs, sea) {
  if (!hs.length) return null;
  const windiest = hs.reduce((a, b) => ((b.wind ?? -1) > (a.wind ?? -1) ? b : a));
  return {
    from: hs[0].time, code: dominantCode(hs), isDay: hs.some((h) => h.isDay),
    min: minOf(hs, 'temp'), max: maxOf(hs, 'temp'), feels: avgOf(hs, 'feels'),
    precip: sumOf(hs, 'precip'), pop: maxOf(hs, 'pop'),
    wind: avgOf(hs, 'wind'), gust: maxOf(hs, 'gust'), dir: windiest.dir,
    cloud: avgOf(hs, 'cloud'), rh: avgOf(hs, 'rh'),
    confidence: avgOf(hs, 'confidence') == null ? null : Math.round(avgOf(hs, 'confidence')),
    wave: sea?.length ? maxOf(sea, 'wave') : null,
  };
}

/** Moments de la journée (nuit, matin, après-midi, soirée) d'une date AAAA-MM-JJ. */
export function dayPeriods(hours, marine, date) {
  const day = hours.filter((h) => h.time.startsWith(date));
  const sea = (marine || []).filter((m) => m.time.startsWith(date));
  return PERIODS.map((p) => {
    const inP = (x) => hourOf(x.time) >= p.from && hourOf(x.time) < p.to;
    const s = summarize(day.filter(inP), sea.filter(inP));
    return s && { ...p, ...s };
  }).filter(Boolean);
}

/** Tranches de 3 h (0h, 3h, 6h…) d'une date : chaque ligne résume les 3 heures qui la suivent. */
export function threeHourly(hours, marine, date) {
  const day = hours.filter((h) => h.time.startsWith(date));
  const sea = (marine || []).filter((m) => m.time.startsWith(date));
  const rows = [];
  for (let from = 0; from < 24; from += 3) {
    const inP = (x) => hourOf(x.time) >= from && hourOf(x.time) < from + 3;
    const hs = day.filter(inP);
    if (!hs.length) continue;
    const s = summarize(hs, sea.filter(inP));
    rows.push({ ...s, hour: from, temp: hs[0].temp ?? avgOf(hs, 'temp') });
  }
  return rows;
}

const r0 = (v) => (v == null ? '–' : Math.round(v));

function windWords(kn) {
  if (kn == null) return '';
  if (kn < 4) return 'vent faible';
  if (kn < 11) return 'petite brise';
  if (kn < 17) return 'vent modéré';
  if (kn < 22) return 'vent assez fort';
  if (kn < 28) return 'vent fort';
  return 'coup de vent';
}

// Libellés communs avec le reste de l'appli (« Pluie faible », « Averses »…), en minuscules dans la phrase.
const weatherWords = (code) => (code == null ? '' : codeLabel(code).toLowerCase());

/** Une phrase par moment de la journée, ex. « Matin : ensoleillé, 14 à 19°, petite brise d'E (raf. 30 km/h). » */
export function dayText(periods) {
  return periods.filter((p) => p.name !== 'Nuit' || periods.length === 1).map((p) => {
    const parts = [p.isDay || p.code > 3 ? weatherWords(p.code) : (p.cloud ?? 0) > 60 ? 'ciel couvert' : 'ciel dégagé'];
    parts.push(p.min === p.max || p.min == null ? `${r0(p.max)}°` : `${r0(p.min)} à ${r0(p.max)}°`);
    if (p.precip >= 0.3) parts.push(`${p.precip} mm de pluie (${p.pop ?? '?'} %)`);
    else if (p.pop >= 30) parts.push(`risque de pluie ${p.pop} %`);
    const from = dirLabel(p.dir);
    parts.push(`${windWords(p.wind)}${from ? ` ${/^[EO]/.test(from) ? "d'" : 'de '}${from}` : ''} (raf. ${r0(kmh(p.gust))} km/h)`);
    if (p.wave != null) parts.push(`mer ${p.wave.toFixed(1)} m`);
    return `${p.name} : ${parts.filter(Boolean).join(', ')}.`;
  });
}
