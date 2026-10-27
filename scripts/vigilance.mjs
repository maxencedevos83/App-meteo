// Vigilance Météo-France (ou de l'AEMET en Espagne), via le flux public MeteoAlarm (pas de clé nécessaire).
// Format défensif : en cas de changement, la vigilance est ignorée et l'erreur s'affiche dans l'appli.
const FEED = 'https://feeds.meteoalarm.org/api/v1/warnings/feeds-';
const COLORS = { 2: 'jaune', 3: 'orange', 4: 'rouge' };
const TYPES = {
  1: 'Vent', 2: 'Neige-verglas', 3: 'Orages', 4: 'Brouillard', 5: 'Canicule', 6: 'Grand froid',
  7: 'Vagues-submersion', 8: 'Feux de forêt', 9: 'Avalanches', 10: 'Pluie-inondation', 12: 'Crues', 13: 'Pluie-inondation',
};

const param = (info, name) => (info.parameter || []).find((p) => (p.valueName || '').toLowerCase() === name)?.value || '';
const frDate = (iso, timeZone) => new Date(iso).toLocaleString('fr-FR', { timeZone, weekday: 'long', hour: '2-digit', minute: '2-digit' });

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

// areaName : nom(s) de la zone tels que publiés (« Var », « Litoral norte de Tarragona »…) ; lang : langue du texte retenu.
export function parseMeteoAlarm(json, { dept = '83', areaName = 'Var', lang = 'fr', timeZone = 'Europe/Paris', now = new Date() } = {}) {
  const codes = new Set(dept ? [`FR${dept.padStart(3, '0')}`, `FR${dept}`] : []);
  const langRe = new RegExp(`^${lang}`, 'i');
  // Une ou plusieurs zones (en Espagne, la zone terrestre et sa zone côtière « Costa - … »).
  const areas = new Set([areaName].flat().map(norm));
  const out = new Map();
  for (const w of json?.warnings || []) {
    for (const info of w.alert?.info || []) {
      if (info.language && !langRe.test(info.language)) continue;
      const inArea = (info.area || []).some((a) => (a.geocode || []).some((g) => codes.has(String(g.value).toUpperCase())) || areas.has(norm(a.areaDesc)));
      if (!inArea) continue;
      const level = parseInt(param(info, 'awareness_level'), 10);
      if (!(level >= 2)) continue;
      const expires = info.expires || info.effective;
      if (expires && Date.parse(expires) < now.getTime()) continue;
      const typeNum = parseInt(param(info, 'awareness_type'), 10);
      const type = TYPES[typeNum] || (param(info, 'awareness_type').split(';')[1] || info.event || 'Météo').trim();
      const onset = info.onset || info.effective || '';
      const key = `${type}-${onset}`;
      const prev = out.get(key);
      if (prev && prev.level >= level) continue;
      out.set(key, {
        type, level, color: COLORS[level] || 'jaune', onset, expires,
        onsetLabel: onset ? frDate(onset, timeZone) : '', expiresLabel: expires ? frDate(expires, timeZone) : '',
        headline: info.headline || info.event || '',
      });
    }
  }
  return [...out.values()].sort((a, b) => b.level - a.level);
}

export async function fetchVigilance(config, now = new Date()) {
  const v = config.vigilance || { country: 'france', area: 'Var', lang: 'fr' };
  const res = await fetch(FEED + v.country, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`MeteoAlarm ${res.status}`);
  const json = await res.json();
  const list = parseMeteoAlarm(json, { dept: v.country === 'france' ? config.stations?.departement || '83' : '', areaName: v.area, lang: v.lang || 'fr', timeZone: config.timezone, now });
  // Zones publiées, pour aider à régler le nom exact quand rien ne correspond.
  const areas = [...new Set((json?.warnings || []).flatMap((w) => (w.alert?.info || []).flatMap((i) => (i.area || []).map((a) => a.areaDesc))))];
  return Object.assign(list, { areas });
}
