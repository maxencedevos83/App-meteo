// Bulletins de montagne Météo-France pour tous les massifs, publiés dans data/montagne.json :
// l'appli y prend celui du massif le plus proche quand le lieu affiché est en montagne.
//
// 1. Sans clé : risque d'avalanche du jour par massif, tel que Météo-France le transmet au réseau européen EAWS
//    (fichier public des niveaux de risque, celui de la carte avalanches.org).
// 2. Avec la clé gratuite du portail des API Météo-France (secret METEOFRANCE_API_KEY, API « Bulletins neige et
//    avalanche ») : le bulletin complet de chaque massif, avec en plus la partie météo (isotherme 0 °C,
//    limite pluie-neige, vent à 2 000 et 3 000 m), le résumé et l'enneigement. Gardé 3 h en cache.
// Les bulletins ne paraissent qu'en saison (environ de décembre à avril) : hors saison, le fichier est vide.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MASSIFS, parseEawsRatings, DANGER } from '../web/js/mountain.js';

const EAWS = (date) => `https://static.avalanche.report/eaws_bulletins/${date}/${date}.ratings.json`;
const BRA_API = 'https://public-api.meteofrance.fr/public/DPBRA/v1';
const BRA_CACHE_MS = 3 * 3600000;

const parisDate = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

// Niveaux de risque du jour (à défaut, ceux de la veille).
export async function fetchEawsRatings(now = new Date(), fetchImpl = fetch) {
  const tried = [];
  // Le bulletin du lendemain paraît vers 16-17 h : il ne compte qu'à partir de là.
  const evening = +now.toLocaleString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }) >= 17;
  for (const offset of evening ? [1, 0] : [0, -1]) {
    const date = parisDate(new Date(now.getTime() + offset * 86400000));
    const res = await fetchImpl(EAWS(date)).catch((e) => ({ ok: false, status: e.message }));
    tried.push(`${date} : ${res.status}`);
    if (!res.ok) continue;
    const json = await res.json();
    const ratings = json?.maxDangerRatings || json || {};
    const keys = Object.keys(ratings);
    return { date, massifs: parseEawsRatings(json), keys: keys.length, france: keys.filter((k) => k.startsWith('FR')).length, sample: (keys.some((k) => k.startsWith('FR')) ? keys.filter((k) => k.startsWith('FR')) : keys).slice(0, 6) };
  }
  throw new Error(`EAWS : aucun fichier (${tried.join(', ')})`);
}

// --- Bulletin complet (API Météo-France, clé requise) ---

const attrs = (tag) => Object.fromEntries([...String(tag || '').matchAll(/([A-Za-z0-9_-]+)="([^"]*)"/g)].map((m) => [m[1].toUpperCase(), m[2]]));
const tagOf = (xml, name) => xml.match(new RegExp(`<${name}\\b[^>]*>`, 'i'))?.[0] || null;
const textOf = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || null : null;
};
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : null; };

// Lecture défensive du bulletin XML (format BRA de Météo-France) : un champ manquant reste vide.
export function parseBraXml(xml) {
  const root = attrs(tagOf(xml, 'BULLETINS_NEIGE_AVALANCHE'));
  const r = attrs(tagOf(xml, 'RISQUE'));
  // RISQUE1 / LOC1 et RISQUE2 / LOC2 : risque de part et d'autre de l'altitude limite (LOC1 « <2400 » = en dessous).
  const swap = /^\s*>/.test(decode(r.LOC1 || ''));
  const risk1 = num(swap ? r.RISQUE2 : r.RISQUE1), risk2 = num(swap ? r.RISQUE1 : r.RISQUE2);
  const altitude = num(r.ALTITUDE);
  const danger = num(r.RISQUEMAXI) ?? (Math.max(risk1 ?? 0, risk2 ?? 0) || null);
  const meteoTag = attrs(tagOf(xml, 'METEO'));
  const meteoXml = xml.match(/<METEO\b[\s\S]*?<\/METEO>/i)?.[0] || '';
  const meteo = [...meteoXml.matchAll(/<ECHEANCE\b[^>]*>/gi)].map((m) => {
    const e = attrs(m[0]);
    const kmhOf = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : null; };
    return {
      date: e.DATE || null,
      iso0: num(e.ISO0),
      rainSnow: num(e.PLUIENEIGE),
      iso10: num(e['ISO-10']),
      wind: [
        { alt: num(meteoTag.ALTITUDEVENT1), dir: e.DD1 || null, kmh: kmhOf(e.FF1) },
        { alt: num(meteoTag.ALTITUDEVENT2), dir: e.DD2 || null, kmh: kmhOf(e.FF2) },
      ].filter((w) => w.kmh != null),
    };
  }).filter((e) => e.date);
  return {
    date: root.DATEBULLETIN || root.DATEECHEANCE || null,
    until: root.DATEVALIDITE || root.DATEECHEANCE || null,
    danger,
    low: altitude && risk2 != null ? risk1 : null,
    high: altitude && risk2 != null ? risk2 : null,
    altitude: altitude && risk2 != null ? altitude : null,
    summary: textOf(xml, 'RESUME'),
    stability: textOf(xml, 'STABILITE'),
    snow: textOf(xml, 'QUALITE'),
    weather: meteoTag.COMMENTAIRE ? decode(meteoTag.COMMENTAIRE) : null,
    meteo,
  };
}

async function fetchBra(id, key, fetchImpl) {
  const res = await fetchImpl(`${BRA_API}/massif/BRA?id-massif=${id}&format=xml`, { headers: { apikey: key, accept: '*/*' } });
  if (res.status === 404 || res.status === 204) return null; // pas de bulletin (hors saison)
  if (!res.ok) throw new Error(`${res.status}`);
  return parseBraXml(await res.text());
}

async function fetchAllBra(key, fetchImpl) {
  const out = new Map();
  const errors = [];
  const queue = [...MASSIFS];
  // 4 à la fois : l'API gratuite limite le nombre d'appels par minute.
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      try { const b = await fetchBra(m.id, key, fetchImpl); if (b?.danger) out.set(m.id, b); }
      catch (e) { errors.push(`${m.name} ${e.message}`); }
    }
  }));
  return { massifs: out, errors };
}

// Assemble data/montagne.json. stateDir : cache des bulletins complets.
export async function buildMontagne({ now = new Date(), stateDir, key = process.env.METEOFRANCE_API_KEY, fetchImpl = fetch } = {}) {
  const log = [];
  const eaws = await fetchEawsRatings(now, fetchImpl).catch((e) => { log.push(e.message); return null; });
  if (eaws) log.push(`EAWS ${eaws.date} : ${eaws.keys} régions dont ${eaws.france} françaises, ${eaws.massifs.size} massifs reconnus (ex. ${eaws.sample.join(', ')})`);

  let bra = null;
  if (key) {
    const cachePath = join(stateDir, 'montagne-bra.json');
    const cache = await readFile(cachePath, 'utf8').then(JSON.parse).catch(() => null);
    if (cache && now - Date.parse(cache.fetchedAt) < BRA_CACHE_MS) {
      bra = new Map(cache.massifs);
      log.push(`Bulletins Météo-France : ${bra.size} massifs (cache)`);
    } else {
      const res = await fetchAllBra(key, fetchImpl);
      bra = res.massifs;
      log.push(`Bulletins Météo-France : ${bra.size} massifs${res.errors.length ? ` (erreurs : ${res.errors.slice(0, 4).join(', ')})` : ''}`);
      if (bra.size || !res.errors.length) await writeFile(cachePath, JSON.stringify({ fetchedAt: now.toISOString(), massifs: [...bra] }));
    }
  } else {
    log.push('Bulletins Météo-France complets : pas de clé METEOFRANCE_API_KEY (risque d\'avalanche seul, via EAWS)');
  }

  const massifs = MASSIFS.map((m) => {
    const full = bra?.get(m.id);
    const e = eaws?.massifs.get(m.id);
    if (full) return { id: m.id, name: m.name, source: 'Météo-France', ...full, date: (full.date || eaws?.date || '').slice(0, 10) };
    if (e) return { id: m.id, name: m.name, source: 'Météo-France via EAWS', date: eaws.date, danger: e.danger, high: e.high, low: e.low };
    return null;
  }).filter(Boolean);
  const top = massifs.filter((m) => m.danger >= 3).map((m) => `${m.name} ${m.danger} (${DANGER[m.danger].label})`);
  log.push(`Massifs avec bulletin : ${massifs.length}${top.length ? ` · risque marqué ou plus : ${top.join(', ')}` : ''}`);
  return { json: { updated: now.toISOString(), date: eaws?.date || null, massifs }, log };
}
