// Lever et coucher du soleil et de la lune, phase de la lune (formules de SunCalc, précision ~1 min).
// Module partagé (navigateur et Node). Les heures sont rendues dans le fuseau du lieu.
import { localKey } from './ensemble.js';

const PI = Math.PI, rad = PI / 180, DAY_MS = 86400000, J1970 = 2440588, J2000 = 2451545;
const E = rad * 23.4397; // obliquité de la Terre

const toDays = (ms) => ms / DAY_MS - 0.5 + J1970 - J2000;
const fromJulian = (j) => (j + 0.5 - J1970) * DAY_MS;
const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(E) - Math.tan(b) * Math.sin(E), Math.cos(l));
const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(E) + Math.cos(b) * Math.sin(E) * Math.sin(l));
const altitude = (H, phi, dec) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;
const solarMeanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);
const eclipticLongitude = (M) => M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + PI;

function sunCoords(d) {
  const L = eclipticLongitude(solarMeanAnomaly(d));
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

function moonCoords(d) {
  const L = rad * (218.316 + 13.176396 * d), M = rad * (134.963 + 13.064993 * d), F = rad * (93.272 + 13.22935 * d);
  const l = L + rad * 6.289 * Math.sin(M), b = rad * 5.128 * Math.sin(F);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

const J0 = 0.0009;

/** Lever et coucher du soleil (ms) autour de l'instant donné. */
export function sunTimes(ms, lat, lon) {
  const lw = rad * -lon, phi = rad * lat, d = toDays(ms);
  const n = Math.round(d - J0 - lw / (2 * PI));
  const ds = J0 + lw / (2 * PI) + n;
  const M = solarMeanAnomaly(ds), L = eclipticLongitude(M), dec = declination(L, 0);
  const transit = (a) => J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const noon = transit(ds);
  const w = Math.acos((Math.sin(-0.833 * rad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
  if (Number.isNaN(w)) return { rise: null, set: null };
  const set = transit(J0 + (w + lw) / (2 * PI) + n);
  return { rise: fromJulian(noon - (set - noon)), set: fromJulian(set) };
}

function moonAltitude(ms, lat, lon) {
  const lw = rad * -lon, phi = rad * lat, d = toDays(ms), c = moonCoords(d);
  let h = altitude(siderealTime(d, lw) - c.ra, phi, c.dec);
  const hh = Math.max(h, 0);
  h += 0.0002967 / Math.tan(hh + 0.00312536 / (hh + 0.08901179)); // réfraction
  return h;
}

/** Lever et coucher de la lune (ms) pendant les 24 h qui suivent t0 (minuit local). */
export function moonTimes(t0, lat, lon) {
  const hc = 0.133 * rad, at = (hours) => moonAltitude(t0 + hours * 3600000, lat, lon) - hc;
  let h0 = at(0), rise = null, set = null;
  for (let i = 1; i <= 24; i += 2) {
    const h1 = at(i), h2 = at(i + 1);
    const a = (h0 + h2) / 2 - h1, b = (h2 - h0) / 2, xe = -b / (2 * a), ye = (a * xe + b) * xe + h1, disc = b * b - 4 * a * h1;
    let roots = 0, x1 = 0, x2 = 0;
    if (disc >= 0) {
      const dx = Math.sqrt(disc) / (Math.abs(a) * 2);
      x1 = xe - dx; x2 = xe + dx;
      if (Math.abs(x1) <= 1) roots++;
      if (Math.abs(x2) <= 1) roots++;
      if (x1 < -1) x1 = x2;
    }
    if (roots === 1) { if (h0 < 0) rise = i + x1; else set = i + x1; }
    else if (roots === 2) { rise = i + (ye < 0 ? x2 : x1); set = i + (ye < 0 ? x1 : x2); }
    if (rise != null && set != null) break;
    h0 = h2;
  }
  const toMs = (h) => (h == null ? null : t0 + h * 3600000);
  return { rise: toMs(rise), set: toMs(set) };
}

/** Phase de la lune : 0 = nouvelle, 0,5 = pleine ; fraction éclairée 0..1. */
export function moonPhase(ms) {
  const d = toDays(ms), s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return { phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / PI, fraction: (1 + Math.cos(inc)) / 2 };
}

const PHASES = [
  [0.02, '🌑', 'Nouvelle lune'], [0.23, '🌒', 'Premier croissant'], [0.27, '🌓', 'Premier quartier'], [0.48, '🌔', 'Gibbeuse croissante'],
  [0.52, '🌕', 'Pleine lune'], [0.73, '🌖', 'Gibbeuse décroissante'], [0.77, '🌗', 'Dernier quartier'], [0.98, '🌘', 'Dernier croissant'], [1.01, '🌑', 'Nouvelle lune'],
];
export function phaseInfo(phase) {
  const [, emoji, name] = PHASES.find(([max]) => phase < max);
  return { emoji, name };
}

// Minuit local (ms) d'une date AAAA-MM-JJ dans le fuseau donné.
function localMidnight(date, timeZone) {
  const guess = Date.parse(date + 'T00:00:00Z');
  const k = localKey(new Date(guess), timeZone);
  const offset = Date.parse(k + ':00Z') - guess;
  return guess - offset;
}

const hm = (ms, timeZone) => (ms == null ? null : localKey(new Date(ms), timeZone).slice(11, 16));

/** Soleil et lune d'une journée locale : heures « HH:MM » dans le fuseau du lieu. */
export function skyDay(date, lat, lon, timeZone) {
  const t0 = localMidnight(date, timeZone);
  const sun = sunTimes(t0 + 12 * 3600000, lat, lon);
  const moon = moonTimes(t0, lat, lon);
  const { phase, fraction } = moonPhase(t0 + 12 * 3600000);
  return {
    date, sunrise: hm(sun.rise, timeZone), sunset: hm(sun.set, timeZone),
    moonrise: hm(moon.rise, timeZone), moonset: hm(moon.set, timeZone),
    moonPhase: Math.round(phase * 100) / 100, moonLit: Math.round(fraction * 100), ...phaseInfo(phase),
  };
}
