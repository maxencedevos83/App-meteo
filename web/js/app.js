import { codeEmoji, codeLabel, dirLabel, kmh, KMH } from './ensemble.js';
import { fetchAllOpenMeteo, fetchEnsemblePop, fetchNowcast, fetchMarine, fetchAgri, geocode, reverseGeocode, distanceKm } from './sources.js';
import { buildForecast, freshen } from './forecast.js';
import { skyDay } from './astro.js';
import { buildAlerts, dayWord } from './alerts.js';
import { startScene, skyKind } from './scene.js';
import { beachFlag } from './activities.js';
import { dayPeriods, threeHourly, dayText } from './daydetail.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r0 = (v) => (v == null ? '–' : Math.round(v));
const FR_DAYS = ['Dim.', 'Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.'];

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};

let current = null;

// ---------- Chargement ----------

// Lieux suivis par le serveur (prévision complète : Windguru, stations, vigilance).
let placesCache = null;
async function trackedPlaces() {
  if (!placesCache) placesCache = await fetch(`data/places.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  return placesCache;
}

async function loadHome(path = 'data/') {
  const res = await fetch(`${path}forecast.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('prévision du serveur indisponible');
  return res.json();
}

// Calcul dans le navigateur pour un autre lieu (sans Windguru ni vérification locale).
async function loadPlace(place) {
  const { latitude: lat, longitude: lon, timezone: tz } = place;
  const [om, pop, nowcast, marine] = await Promise.all([
    fetchAllOpenMeteo(lat, lon, tz),
    fetchEnsemblePop(lat, lon, tz).catch(() => ({})),
    fetchNowcast(lat, lon, tz).catch(() => null),
    fetchMarine(lat, lon, tz).catch(() => null),
  ]);
  if (!om.sources.length) throw new Error('aucun modèle disponible pour ce lieu');
  const fc = buildForecast({ config: { place: place.name, latitude: lat, longitude: lon, timezone: tz }, sources: om.sources, ensemblePop: pop, nowcast, marine, errors: om.errors });
  fc.local = true;
  fc.alerts = buildAlerts(fc);
  return fc;
}

// Autour du lieu principal, la prévision complète (Windguru, stations) reste la meilleure.
const HOME_RADIUS_KM = 15;

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('localisation indisponible'));
    // Précision de la ville : pas besoin du GPS fin.
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, maximumAge: 30 * 60000, timeout: 15000 });
  });
}

// Mode « ma position » : ville où l'on se trouve, ou lieu principal si l'on est tout près.
async function gpsPlace() {
  const pos = await currentPosition();
  const here = { latitude: +pos.coords.latitude.toFixed(3), longitude: +pos.coords.longitude.toFixed(3) };
  // Près d'un lieu suivi (Le Lavandou, Cambrils…) : sa prévision complète.
  const near = (await trackedPlaces()).find((p) => distanceKm(here, p) <= HOME_RADIUS_KM);
  if (near) return { tracked: near.path };
  const cfg = await fetch('config.json').then((r) => r.json()).catch(() => null);
  if (cfg && distanceKm(here, cfg) <= HOME_RADIUS_KM) return null;
  const last = store.get('gpsName');
  const name = last && distanceKm(here, last) < 3 ? last.name : await reverseGeocode(here.latitude, here.longitude).catch(() => 'Ma position');
  store.set('gpsName', { ...here, name });
  return { name: `📍 ${name}`, ...here, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

async function load() {
  const btn = $('#refresh');
  btn.classList.add('spin');
  let other = store.get('place');
  try {
    let fc;
    if (other?.gps) other = await gpsPlace().catch(() => store.get('gpsName') && { name: `📍 ${store.get('gpsName').name}`, ...store.get('gpsName'), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (other?.tracked) fc = await loadHome(other.tracked);
    else if (other) fc = await loadPlace(other);
    else {
      try { fc = await loadHome(); }
      catch (e) {
        // Pas encore de données serveur (première installation) : calcul direct dans le navigateur.
        const cfg = await fetch('config.json').then((r) => r.json()).catch(() => ({ place: 'Le Lavandou', latitude: 43.1375, longitude: 6.3683, timezone: 'Europe/Paris' }));
        fc = await loadPlace({ name: cfg.place, ...cfg });
      }
    }
    // Recalée sur l'heure actuelle si la dernière mise à jour du serveur date un peu.
    fc = freshen(fc);
    current = fc;
    render(fc);
  } catch (e) {
    $('#hero').innerHTML = `<div class="skeleton">Impossible de charger la météo : ${esc(e.message)}</div>`;
  } finally {
    btn.classList.remove('spin');
  }
}

// ---------- Rendu ----------

function confColor(c) { return c >= 75 ? 'var(--good)' : c >= 50 ? 'var(--mid)' : 'var(--bad)'; }

function arrow(deg) {
  // La flèche indique où va le vent (direction d'origine + 180°).
  return deg == null ? '' : `<span class="arrow" style="transform:rotate(${(deg + 180) % 360}deg)">↑</span>`;
}

function render(fc) {
  $('#place-name').textContent = fc.place;
  const age = Math.round((Date.now() - Date.parse(fc.generatedAt)) / 60000);
  $('#updated').textContent = age < 1 ? 'à l\'instant' : age < 60 ? `il y a ${age} min` : `il y a ${Math.round(age / 60)} h`;
  renderAlerts(fc.alerts || []);
  renderHero(fc);
  renderHourly(fc.hours.slice(0, 48));
  renderWind(fc.hours.slice(0, 30));
  renderSessions(fc);
  renderModels(fc);
  renderDays(fc);
  renderLinks(fc);
  renderSea(fc.marine);
  renderFlag(fc);
  renderHistory(fc);
  renderSources(fc);
  radar.center(fc.latitude, fc.longitude);
  window.MeteoApp?.ready?.(fc.place, fc.days.length);
}

function renderHero(fc) {
  const h = fc.hours[0];
  // Tard le soir, min/max des 24 h à venir plutôt que de la fin de journée.
  const today = fc.hours.filter((x) => x.time.slice(0, 10) === fc.now.slice(0, 10));
  const span = (today.length < 8 ? fc.hours.slice(0, 24) : today).map((x) => x.temp).filter((t) => t != null);
  const d = { min: Math.min(...span), max: Math.max(...span) };
  const bars = (fc.rain?.slots || []).map((s) => `<span style="height:${Math.min(22, 2 + (s.precip || 0) * 10)}px" title="${s.time.slice(11)} : ${s.precip} mm"></span>`).join('');
  const banner = fc.local ? '<div class="banner" style="margin-bottom:12px;color:var(--ink)">Lieu secondaire : modèles Open-Meteo seulement (Windguru et vérification locale sont réservés au lieu principal).</div>' : '';
  $('#hero').innerHTML = `${banner}
    <div class="hero-main">
      <div class="hero-icon" aria-label="${codeLabel(h.code, h.isDay)}">${['clear', 'partly'].includes(skyKind(h.code)) ? '' : codeEmoji(h.code, h.isDay)}</div>
      <div>
        <div class="hero-temp">${r0(h.temp)}°</div>
      </div>
      <div style="margin-left:auto;text-align:right">
        <div class="hero-cond">${codeLabel(h.code, h.isDay)}</div>
        <div class="hero-sub">Ressenti ${r0(h.feels)}°</div>
        <div class="hero-sub">${r0(d.min)}° / ${r0(d.max)}°</div>
      </div>
    </div>
    ${fc.rain?.text ? `<div class="hero-rain">💧 ${esc(fc.rain.text)}<div class="rain-bars">${bars}</div></div>` : ''}
    <div class="hero-stats">
      <div class="stat"><small>Vent</small><b>${arrow(h.dir)} ${r0(kmh(h.wind))} km/h</b><small>${dirLabel(h.dir)} · raf. ${r0(kmh(h.gust))}</small></div>
      <div class="stat"><small>Pluie</small><b>${h.pop ?? 0} %</b><small>${h.precip ?? 0} mm/h</small></div>
      <div class="stat"><small>Fiabilité</small><b class="conf"><i style="background:${confColor(h.confidence)}"></i>${h.confidence} %</b><small>${h.n} modèles</small></div>
    </div>
    ${skyLine(skyDay(fc.now.slice(0, 10), fc.latitude, fc.longitude, fc.timezone))}`;
  // Ciel animé selon le temps qu'il fait : soleil, nuages, pluie, neige, éclairs, vent.
  startScene($('#hero'), { code: h.code, isDay: h.isDay, wind: h.wind, gust: h.gust, anchor: $('#hero .hero-icon') });
}

const hh = (t) => (t ? t.replace(/^0/, '').replace(':', 'h') : '–');

function skyLine(k) {
  return `<div class="hero-sky">
    <span>☀️ Lever <b>${hh(k.sunrise)}</b> · coucher <b>${hh(k.sunset)}</b></span>
    <span>${k.emoji} Lune : lever <b>${hh(k.moonrise)}</b> · coucher <b>${hh(k.moonset)}</b> · ${k.name.toLowerCase()} (${k.moonLit} %)</span>
  </div>`;
}

function renderHourly(hours) {
  $('#hourly').innerHTML = hours.map((h) => `
    <div class="hour ${h.isDay ? '' : 'night'}">
      <div class="h">${+h.time.slice(11, 13)}h</div>
      <div class="e">${codeEmoji(h.code, h.isDay)}</div>
      <div class="t">${r0(h.temp)}°</div>
      <div class="p">${h.pop >= 15 ? `${h.pop} %` : ''}</div>
    </div>`).join('');
}

// Échelle de couleurs proche de Windguru (nœuds).
function windColor(kn) {
  const stops = [[0, [255, 255, 255]], [5, [200, 245, 255]], [9, [120, 230, 160]], [13, [170, 240, 70]], [17, [255, 240, 60]], [21, [255, 170, 40]], [25, [255, 80, 60]], [30, [230, 40, 160]], [38, [150, 60, 220]]];
  if (kn == null) return 'transparent';
  let i = stops.findIndex(([k]) => k > kn);
  if (i === -1) return `rgb(${stops.at(-1)[1]})`;
  if (i === 0) i = 1;
  const [k0, c0] = stops[i - 1], [k1, c1] = stops[i];
  const f = (kn - k0) / (k1 - k0);
  return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * f)).join(',')})`;
}

function renderWind(hours) {
  const cell = (v) => `<td style="background:${windColor(v)};color:#111">${r0(kmh(v))}</td>`;
  $('#wind').innerHTML = `<table>
    <tr><th>Heure</th>${hours.map((h) => `<td>${+h.time.slice(11, 13)}h</td>`).join('')}</tr>
    <tr><th>Vent</th>${hours.map((h) => cell(h.wind)).join('')}</tr>
    <tr><th>Rafales</th>${hours.map((h) => cell(h.gust)).join('')}</tr>
    <tr><th>Dir.</th>${hours.map((h) => `<td title="${dirLabel(h.dir)}">${arrow(h.dir)}</td>`).join('')}</tr>
    <tr><th>Écart</th>${hours.map((h) => `<td style="color:var(--muted)">±${r0(kmh(h.windSpread))}</td>`).join('')}</tr>
  </table>`;
}

function renderDays(fc) {
  const all = fc.days.filter((d) => d.min != null);
  const lo = Math.min(...all.map((d) => d.min)), hi = Math.max(...all.map((d) => d.max));
  const open = new Set([...document.querySelectorAll('#days details[open]')].map((e) => e.dataset.date));
  $('#days').innerHTML = all.map((d, i) => {
    const date = new Date(d.date + 'T12:00Z');
    const name = i === 0 ? 'Auj.' : i === 1 ? 'Dem.' : FR_DAYS[date.getUTCDay()];
    const left = ((d.min - lo) / (hi - lo || 1)) * 100, width = ((d.max - d.min) / (hi - lo || 1)) * 100;
    return `<details class="day-wrap" data-date="${d.date}"${open.has(d.date) ? ' open' : ''}><summary class="day">
      <div class="name">${name}<small>${date.getUTCDate()}/${date.getUTCMonth() + 1}</small></div>
      <div class="e">${codeEmoji(d.code, true)}</div>
      <div class="range"><span style="left:${left}%;width:${Math.max(width, 3)}%"></span></div>
      <div class="temps"><span class="lo">${r0(d.min)}°</span><span>${r0(d.max)}°</span></div>
      <div class="meta">
        <span class="${d.pop >= 30 ? 'wet' : ''}">💧 ${d.pop} %${d.precip >= 0.5 ? ` · ${d.precip} mm` : ''}</span>
        <span>${arrow(d.dir)} ${r0(kmh(d.wind))} km/h (${r0(kmh(d.gust))})</span>
        <span class="conf"><i style="background:${confColor(d.confidence)}"></i>${d.confidence} %</span>
        ${d.sunrise ? `<span class="sky">☀️ ${hh(d.sunrise)}–${hh(d.sunset)} · ${d.emoji}</span>` : ''}
        <span class="more">détail ▾</span>
      </div>
    </summary><div class="day-detail">${dayDetail(fc, d.date)}</div></details>`;
  }).join('');
  agri.load(fc);
}

// Détail d'un jour : résumé par moment, tableau toutes les 3 h, données agricoles (remplies à part).
function dayDetail(fc, date) {
  const periods = dayPeriods(fc.hours, fc.marine, date);
  const rows = threeHourly(fc.hours, fc.marine, date);
  if (!rows.length) return '<p class="explain">Pas de détail horaire pour ce jour.</p>';
  const sea = rows.some((r) => r.wave != null);
  const cell = (v) => `<td style="background:${windColor(v)};color:#111">${r0(kmh(v))}</td>`;
  return `<ul class="day-text">${dayText(periods).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <div class="wind-table"><table>
      <tr><th>Heure</th>${rows.map((r) => `<td>${r.hour}h</td>`).join('')}</tr>
      <tr><th>Temps</th>${rows.map((r) => `<td class="e">${codeEmoji(r.code, r.isDay)}</td>`).join('')}</tr>
      <tr><th>Temp.</th>${rows.map((r) => `<td><b>${r0(r.temp)}°</b></td>`).join('')}</tr>
      <tr><th>Ressenti</th>${rows.map((r) => `<td style="color:var(--muted)">${r0(r.feels)}°</td>`).join('')}</tr>
      <tr><th>Pluie mm</th>${rows.map((r) => `<td class="${r.precip >= 0.3 ? 'wet' : ''}">${r.precip ? r.precip : '–'}</td>`).join('')}</tr>
      <tr><th>Risque %</th>${rows.map((r) => `<td class="${r.pop >= 30 ? 'wet' : ''}">${r.pop ?? '–'}</td>`).join('')}</tr>
      <tr><th>Vent</th>${rows.map((r) => cell(r.wind)).join('')}</tr>
      <tr><th>Rafales</th>${rows.map((r) => cell(r.gust)).join('')}</tr>
      <tr><th>Dir.</th>${rows.map((r) => `<td title="${dirLabel(r.dir)}">${arrow(r.dir)}<small>${dirLabel(r.dir)}</small></td>`).join('')}</tr>
      ${sea ? `<tr><th>Vagues</th>${rows.map((r) => `<td>${r.wave == null ? '–' : r.wave.toFixed(1)}</td>`).join('')}</tr>` : ''}
      <tr><th>Nuages %</th>${rows.map((r) => `<td>${r.cloud == null ? '–' : r0(r.cloud)}</td>`).join('')}</tr>
      <tr><th>Humidité %</th>${rows.map((r) => `<td>${r.rh == null ? '–' : r0(r.rh)}</td>`).join('')}</tr>
      <tr><th>Fiabilité</th>${rows.map((r) => `<td><i class="dot" style="background:${confColor(r.confidence)}"></i>${r.confidence ?? '–'}</td>`).join('')}</tr>
    </table></div>
    <div class="agri" data-agri="${date}"></div>`;
}

// Données agricoles (Open-Meteo) : ensoleillement, évapotranspiration, UV, sol. Chargées une fois par lieu.
const agri = {
  key: null, data: null,
  async load(fc) {
    const key = `${fc.latitude},${fc.longitude}`;
    if (this.key !== key) {
      this.key = key; this.data = null;
      try { this.data = await fetchAgri(fc.latitude, fc.longitude, fc.timezone); } catch { this.data = {}; }
      if (this.key !== key) return;
    }
    if (!this.data) return;
    document.querySelectorAll('[data-agri]').forEach((el) => {
      const a = this.data[el.dataset.agri];
      if (!a) return;
      const parts = [
        a.sun != null && `☀️ ${a.sun} h de soleil`,
        a.rainHours != null && a.rainHours > 0 && `🌧 ${a.rainHours} h de pluie`,
        a.et0 != null && `💦 évapotranspiration ${a.et0.toFixed(1)} mm`,
        a.uv != null && `UV ${Math.round(a.uv)}`,
        a.soil != null && `🌱 sol ${Math.round(a.soil * 100)} % d'eau`,
        a.soilTemp != null && `sol ${Math.round(a.soilTemp)}°`,
      ].filter(Boolean);
      el.innerHTML = parts.length ? `<small>Agricole</small> ${parts.map((p) => `<span>${p}</span>`).join('')}` : '';
    });
  },
};

// Bulletins officiels et cartes utiles autour du lieu affiché.
function renderLinks(fc) {
  const lat = fc.latitude.toFixed(3), lon = fc.longitude.toFixed(3);
  const spain = fc.timezone === 'Europe/Madrid';
  const groups = [
    ['🌊 Mer', [
      spain
        ? ['Bulletin maritime AEMET', 'https://www.aemet.es/es/eltiempo/prediccion/maritima']
        : ['Météo marine Météo-France (bulletins côtiers)', 'https://meteofrance.com/meteo-marine'],
      !spain && ['Bulletin détaillé de Toulon (Météo Consult)', 'https://marine.meteoconsult.fr/meteo-marine/bulletin-detaille/port-62/previsions-meteo-toulon-aujourdhui'],
      fc.windguru?.spotId && [`Windguru${fc.windguru.spotName ? ` – ${fc.windguru.spotName}` : ''}`, `https://www.windguru.cz/${fc.windguru.spotId}`],
      ['Vagues et houle (Windy)', `https://www.windy.com/?waves,${lat},${lon},9`],
    ]],
    ['🌧 Radars', [
      spain ? ['Radar Meteocat (Catalogne)', 'https://www.meteo.cat/observacions/radar'] : ['Pluie en direct (Météo-France)', 'https://meteofrance.com/images-radar'],
      spain && ['Radar AEMET', 'https://www.aemet.es/es/eltiempo/observacion/radar'],
      ['Orages et éclairs (Blitzortung)', `https://map.blitzortung.org/#8/${lat}/${lon}`],
      ['Vent animé (Windy)', `https://www.windy.com/?wind,${lat},${lon},9`],
    ]],
    ['🌱 Agricole', [
      ['Météo agricole (Terre-net, une partie réservée aux abonnés)', 'https://www.terre-net.fr/meteo-agricole'],
    ]],
  ];
  const note = '<p class="explain">Ensoleillement, évapotranspiration, UV et humidité du sol sont aussi dans le détail de chaque jour (10 jours).</p>';
  $('#links').innerHTML = groups.map(([title, items]) => `<div class="link-group"><h3 class="sub">${title}</h3>
    ${items.filter(Boolean).map(([label, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`).join('')}</div>`).join('') + note;
}

function renderAlerts(alerts) {
  $('#alerts').hidden = !alerts.length;
  $('#alerts').innerHTML = alerts.map((a) => `<div class="alert l${a.level}"><b>${esc(a.title)}</b><small>${esc(a.text || '')}</small></div>`).join('');
}

function scoreColor(sc) {
  if (sc >= 75) return 'var(--good)';
  if (sc >= 50) return 'var(--mid)';
  if (sc >= 25) return 'color-mix(in srgb, var(--mid) 35%, var(--line))';
  return 'var(--line)';
}

function renderSessions(fc) {
  const acts = fc.activities || [];
  $('#sessions-card').hidden = !acts.length;
  $('#sessions').innerHTML = acts.map((a) => {
    const wins = a.windows.map((w) => `<span class="win ${w.score < 75 ? 'mid' : ''}">${dayWord(w.start, fc.now)} ${+w.start.slice(11, 13)}h–${+w.end.slice(11, 13) + 1}h
      <small>· ${a.id === 'baignade' || a.id === 'balade' ? `${w.score}/100` : `${r0(kmh(w.wind))} km/h ${w.dir}`}${w.notes.length ? ` · ${esc(w.notes.join(', '))}` : ''}</small></span>`).join('');
    // Bandeau 5 jours : une case par heure, couleur selon le score.
    const strip = a.scores.slice(0, 120).map((sc, i) => `<i style="background:${scoreColor(sc)}" title="${fc.hours[i]?.time.slice(5, 13).replace('T', ' ')}h : ${sc}"></i>`).join('');
    return `<div class="act"><div class="ico">${a.emoji}</div><div class="name">${a.label}</div>
      <div class="strip">${strip}</div>
      <div class="wins">${wins || '<span class="none">Pas de bon créneau dans les 5 jours</span>'}</div></div>`;
  }).join('');
}

function renderModels(fc) {
  // Les modèles Windguru sont regroupés par famille (GFS, ICON…) pour rester lisibles : on garde les mieux pondérés.
  const models = fc.models.filter((m) => m.wind?.length).slice(0, 12);
  const idx = [];
  for (let i = 0; i < Math.min(48, fc.hours.length); i += 3) idx.push(i);
  const head = idx.map((i) => {
    const t = fc.hours[i].time;
    return `<td>${+t.slice(11, 13) === 0 || i === 0 ? `<b>${dayWord(t, fc.now).slice(0, 3)}</b> ` : ''}${+t.slice(11, 13)}h</td>`;
  }).join('');
  const row = (label, vals) => `<tr><th>${esc(label)}</th>${idx.map((i) => {
    const v = vals[i];
    return `<td style="background:${windColor(v)};color:#111">${r0(kmh(v))}</td>`;
  }).join('')}</tr>`;
  $('#models-cmp').innerHTML = `<table><tr><th></th>${head}</tr>
    ${row('Combiné', fc.hours.map((h) => h.wind))}
    ${models.map((m) => row(m.label.replace('Windguru ', 'WG '), m.wind)).join('')}
  </table>`;
}

function renderFlag(fc) {
  const f = beachFlag(fc.hours[0], fc.marine?.[0], fc.shoreFacing);
  $('#flag').hidden = !f || !fc.marine?.length;
  if (!f) return;
  $('#flag').className = `flag f${f.level}`;
  $('#flag').innerHTML = `<i></i><div><b>Drapeau estimé : ${f.color}</b> · ${f.label}${f.why.length ? ` (${esc(f.why.join(', '))})` : ''}
    <small>Estimation d'après la mer et le vent, pas le drapeau officiel des sauveteurs.</small></div>`;
}

function renderSea(marine) {
  const m = marine?.find((x) => x.wave != null || x.sst != null);
  $('#sea-card').hidden = !m;
  if (!m) return;
  const maxWave = Math.max(...marine.slice(0, 24).map((x) => x.wave || 0));
  $('#sea').innerHTML = `
    <div class="stat"><small>Eau</small><b>${m.sst != null ? `${m.sst.toFixed(1)}°` : '–'}</b></div>
    <div class="stat"><small>Vagues</small><b>${m.wave != null ? `${m.wave.toFixed(1)} m` : '–'}</b><small>${m.period ? `${Math.round(m.period)} s · ` : ''}${dirLabel(m.waveDir)}</small></div>
    <div class="stat"><small>Houle</small><b>${m.swell != null ? `${m.swell.toFixed(1)} m` : '–'}</b><small>${m.swellPeriod ? `${Math.round(m.swellPeriod)} s · ` : ''}${dirLabel(m.swellDir)} · max 24 h ${maxWave.toFixed(1)} m</small></div>`;
  // Par jour : vagues max, houle, température de l'eau.
  const byDay = new Map();
  for (const x of marine) {
    const d = x.time.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(x);
  }
  const days = [...byDay.entries()].slice(0, 6);
  const max = (xs, k) => Math.max(...xs.map((x) => x[k] ?? 0));
  const avg = (xs, k) => { const v = xs.map((x) => x[k]).filter((y) => y != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const cell = (v, d = 1) => `<td>${v == null ? '–' : v.toFixed(d)}</td>`;
  $('#sea-days').innerHTML = `<table>
    <tr><th></th>${days.map(([d]) => `<td><b>${FR_DAYS[new Date(d + 'T12:00Z').getUTCDay()]}</b></td>`).join('')}</tr>
    <tr><th>Vagues max</th>${days.map(([, xs]) => cell(max(xs, 'wave'))).join('')}</tr>
    <tr><th>Houle max</th>${days.map(([, xs]) => cell(max(xs, 'swell'))).join('')}</tr>
    <tr><th>Eau</th>${days.map(([, xs]) => cell(avg(xs, 'sst'))).join('')}</tr>
  </table>`;
}

// Deux courbes (prévu / mesuré) pour une grandeur sur les dernières heures.
function lineChart(points, key, unit) {
  const pts = points.filter((p) => p.obs[key] != null || p.fc?.[key] != null);
  if (pts.length < 2) return '';
  const W = Math.max(280, $('#history').clientWidth || 600), H = 110, padL = 30, padR = 8, padT = 14, padB = 18;
  const vals = pts.flatMap((p) => [p.obs[key], p.fc?.[key]]).filter((v) => v != null);
  const lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1);
  const t0 = Date.parse(pts[0].time + ':00Z'), t1 = Date.parse(pts.at(-1).time + ':00Z');
  const x = (p) => padL + ((Date.parse(p.time + ':00Z') - t0) / (t1 - t0 || 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const path = (get) => {
    let d = '', pen = false;
    for (const p of pts) {
      const v = get(p);
      if (v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(p).toFixed(1)},${y(v).toFixed(1)}`; pen = true;
    }
    return d;
  };
  const ticks = pts.filter((p) => +p.time.slice(11, 13) % 12 === 0).map((p) => `<text x="${x(p)}" y="${H - 4}" text-anchor="middle">${+p.time.slice(11, 13)}h</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${unit} prévu et mesuré">
    <text x="2" y="10">${unit}</text>
    <line x1="${padL}" x2="${W - padR}" y1="${y(lo + 1)}" y2="${y(lo + 1)}" stroke="var(--line)"/><text x="${padL - 4}" y="${y(lo + 1) + 3}" text-anchor="end">${lo + 1}</text>
    <line x1="${padL}" x2="${W - padR}" y1="${y(hi - 1)}" y2="${y(hi - 1)}" stroke="var(--line)"/><text x="${padL - 4}" y="${y(hi - 1) + 3}" text-anchor="end">${hi - 1}</text>
    <path d="${path((p) => p.fc?.[key])}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 4"/>
    <path d="${path((p) => p.obs[key])}" fill="none" stroke="var(--warm)" stroke-width="2.2"/>
    ${ticks}
  </svg>`;
}

function renderHistory(fc) {
  const hist = fc.history || [];
  const hasPairs = hist.some((p) => p.fc);
  $('#history-card').hidden = fc.local || !hist.length;
  if (fc.local || !hist.length) return;
  const b = fc.scores?.blend;
  const models = (fc.scores?.models || []).filter((m) => m.temp?.n >= 10);
  const best = (k) => models.reduce((m, x) => (x[k] && (!m || x[k].mae < m[k].mae) ? x : m), null);
  const bt = best('temp'), bw = best('wind');
  const stat = (label, val, sub) => `<div class="stat"><small>${label}</small><b>${val}</b><small>${sub}</small></div>`;
  $('#history-stats').innerHTML = [
    stat('Erreur temp.', b?.temp ? `±${b.temp.mae.toFixed(1)}°` : '…', bt ? `meilleur : ${esc(bt.label)} ±${bt.temp.mae.toFixed(1)}°` : 'en cours de mesure'),
    stat('Erreur vent', b?.wind ? `±${(b.wind.mae * KMH).toFixed(1)} km/h` : '…', bw ? `meilleur : ${esc(bw.label)} ±${(bw.wind.mae * KMH).toFixed(1)}` : 'en cours de mesure'),
    stat('Pluie', b?.precip ? `${Math.round(b.precip.accuracy * 100)} %` : '…', b?.precip ? 'heures bien prévues' : 'en cours de mesure'),
  ].join('');
  $('#history').innerHTML = (hasPairs ? '' : '<p class="explain">Les premières comparaisons apparaîtront quelques heures après la mise en route.</p>')
    + lineChart(hist, 't', '°C') + lineChart(hist.map((p) => ({ ...p, obs: { ...p.obs, w: kmh(p.obs.w) }, fc: p.fc && { ...p.fc, w: kmh(p.fc.w) } })), 'w', 'Vent km/h');
  const st = fc.scores?.stations || [];
  $('#history-src').textContent = st.length
    ? `Mesures : stations ${fc.scores.network || 'Météo-France'} ${st.map((s) => `${s.name.toLowerCase().replace(/(^|[\s-])\S/g, (c) => c.toUpperCase())} (${s.km} km)`).join(', ')}, complétées par l'aéroport ${fc.scores.station}.`
    : `Mesures : aéroport ${fc.scores?.station ?? ''}.`;
}

function renderSources(fc) {
  const scores = Object.fromEntries((fc.scores?.models || []).map((m) => [m.id, m]));
  const maxW = Math.max(...fc.models.map((m) => m.weight || 0), 1);
  const verif = fc.scores
    ? ` Les modèles sont comparés en continu aux mesures des stations proches (${fc.scores.observations} relevés) : ceux qui se trompent le moins chez toi gagnent du poids, et leurs biais sont corrigés, y compris selon le régime de vent (mistral, vent d'est…). Colonnes : erreur moyenne mesurée, et part des heures où la pluie était bien prévue.`
    : '';
  $('#explain').innerHTML = `Chaque valeur est une moyenne pondérée de ${fc.models.length} modèles. Les modèles fins de Météo-France (AROME) pèsent le plus à courte échéance, ECMWF à plus long terme, et les modèles Windguru pèsent environ 40 % du vent.${verif}`;
  const fmt = (s, k, unit, scale = 1) => (s?.[k] ? `${(s[k].mae * scale).toFixed(1)} ${unit}<small>${s[k].n} comp.</small>` : '<small>en cours</small>');
  $('#sources').innerHTML = `<table>
    <tr><th>Modèle</th><th>Poids</th><th class="num">Temp.</th><th class="num">Vent</th><th class="num">Pluie</th></tr>
    ${fc.models.map((m) => `<tr>
      <td>${esc(m.label)}<small>${esc(m.provider || '')}</small></td>
      <td style="width:22%"><div class="wbar" style="width:${(m.weight / maxW) * 100}%"></div><small>${m.weight} %</small></td>
      <td class="num">${fc.local ? '–' : fmt(scores[m.id], 'temp', '°')}</td>
      <td class="num">${fc.local ? '–' : fmt(scores[m.id], 'wind', 'km/h', KMH)}</td>
      <td class="num">${fc.local || !scores[m.id]?.precip ? '–' : `${Math.round(scores[m.id].precip.accuracy * 100)} %`}</td>
    </tr>`).join('')}
  </table>`;
  const errs = fc.errors || [];
  $('#errors').hidden = !errs.length;
  $('#errors ul').innerHTML = errs.map((e) => `<li>${esc(e)}</li>`).join('');
}

// ---------- Radar RainViewer ----------

const radar = {
  map: null, layers: [], frames: [], idx: 0, timer: null,
  async init() {
    if (!window.L) return;
    this.map = L.map('radar', { zoomControl: true, attributionControl: true }).setView([43.14, 6.37], 8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, attribution: '© OpenStreetMap' }).addTo(this.map);
    this.marker = L.circleMarker([43.14, 6.37], { radius: 6, color: '#fff', weight: 2, fillColor: '#e8590c', fillOpacity: 1 }).addTo(this.map);
    try {
      const data = await fetch('https://api.rainviewer.com/public/weather-maps.json').then((r) => r.json());
      this.frames = [...(data.radar?.past || []), ...(data.radar?.nowcast || [])].map((f) => ({ ...f, future: (data.radar?.nowcast || []).includes(f) }));
      this.layers = this.frames.map((f) => L.tileLayer(`${data.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: 0, maxNativeZoom: 7, maxZoom: 12, attribution: 'RainViewer' }));
      const pastCount = data.radar?.past?.length || this.frames.length;
      this.layers.forEach((l) => l.addTo(this.map));
      const slider = $('#radar-slider');
      slider.max = String(this.frames.length - 1);
      slider.oninput = () => this.show(+slider.value);
      $('#radar-play').onclick = () => this.toggle();
      this.show(pastCount - 1);
    } catch {
      $('#radar-time').textContent = 'radar indisponible';
    }
  },
  // Onglets vent et vagues : cartes animées Windy (modèle ECMWF), chargées seulement à la demande.
  tab(kind) {
    this.kind = kind;
    const map = kind !== 'rain';
    for (const k of ['rain', 'wind', 'waves']) { $(`#tab-${k}`).classList.toggle('on', k === kind); $(`#tab-${k}`).setAttribute('aria-selected', String(k === kind)); }
    $('#radar').hidden = map; $('#radar-controls').hidden = map; $('#wind-map').hidden = !map;
    $('#radar-time').textContent = kind === 'wind' ? 'vent en km/h (Windy)' : kind === 'waves' ? 'vagues en m (Windy)' : this.timeLabel || '';
    if (map && $('#wind-map').dataset.kind !== kind) {
      const lat = this.lat ?? 43.14, lon = this.lon ?? 6.37;
      const overlay = kind === 'waves' ? 'waves' : 'wind';
      $('#wind-map').dataset.kind = kind;
      $('#wind-map').innerHTML = `<iframe title="Carte ${kind === 'waves' ? 'des vagues' : 'du vent'}" loading="lazy" src="https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=°C&metricWind=km/h&zoom=8&overlay=${overlay}&product=ecmwf&level=surface&lat=${lat}&lon=${lon}&detailLat=${lat}&detailLon=${lon}&marker=true"></iframe>`;
    }
    if (!map) this.map?.invalidateSize();
  },
  center(lat, lon) {
    if (this.lat !== lat || this.lon !== lon) { this.lat = lat; this.lon = lon; $('#wind-map').innerHTML = ''; delete $('#wind-map').dataset.kind; if (!$('#wind-map').hidden) this.tab(this.kind); }
    if (!this.map) return;
    this.map.setView([lat, lon], this.map.getZoom());
    this.marker.setLatLng([lat, lon]);
  },
  show(i) {
    if (!this.layers.length) return;
    this.layers[this.idx]?.setOpacity(0);
    this.idx = i;
    this.layers[i].setOpacity(0.75);
    $('#radar-slider').value = String(i);
    const f = this.frames[i];
    const t = new Date(f.time * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    this.timeLabel = `${t}${f.future ? ' (prévision)' : ''}`;
    if ($('#wind-map').hidden) $('#radar-time').textContent = this.timeLabel;
  },
  toggle() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; $('#radar-play').textContent = '▶ Animer'; return; }
    $('#radar-play').textContent = '⏸ Pause';
    this.timer = setInterval(() => this.show((this.idx + 1) % this.layers.length), 600);
  },
};

// ---------- Choix du lieu ----------

function setupSearch() {
  const dlg = $('#place-dialog');
  const input = $('#search-input');
  const list = $('#search-results');
  let timer;
  $('#place-btn').onclick = () => { dlg.showModal(); input.focus(); };
  $('#home-btn').onclick = () => { store.set('place', null); dlg.close(); load(); };
  $('#gps-btn').onclick = () => { store.set('place', { gps: true }); dlg.close(); load(); };
  trackedPlaces().then((places) => {
    $('#tracked').innerHTML = places.map((p, i) => `<li><button type="button" data-i="${i}">⭐ ${esc(p.place)}<small>prévision complète</small></button></li>`).join('');
    $('#tracked').querySelectorAll('button').forEach((b) => (b.onclick = () => {
      const p = places[+b.dataset.i];
      store.set('place', p.path === 'data/' ? null : { tracked: p.path });
      dlg.close();
      load();
    }));
  });
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (input.value.trim().length < 2) { list.innerHTML = ''; return; }
      const results = await geocode(input.value.trim()).catch(() => []);
      list.innerHTML = results.map((r, i) => `<li><button type="button" data-i="${i}">${esc(r.name)}<small>${esc(r.admin)}</small></button></li>`).join('') || '<li><small>Aucun résultat</small></li>';
      list.querySelectorAll('button').forEach((b) => (b.onclick = () => {
        store.set('place', results[+b.dataset.i]);
        dlg.close();
        load();
      }));
    }, 250);
  };
}

$('#refresh').onclick = load;
$('#tab-rain').onclick = () => radar.tab('rain');
$('#tab-wind').onclick = () => radar.tab('wind');
$('#tab-waves').onclick = () => radar.tab('waves');
setupSearch();
radar.init();
load();
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15 * 60000);

// Dans l'appli Android, le téléphone garde lui-même les données hors ligne : pas de service worker,
// et un bouton ouvre les réglages du widget.
if (window.MeteoApp) {
  const b = document.createElement('button');
  b.className = 'icon-btn'; b.id = 'settings'; b.setAttribute('aria-label', 'Réglages du widget et des alertes'); b.textContent = '⚙️';
  b.onclick = () => window.MeteoApp.openSettings();
  $('#refresh').after(b);
  document.documentElement.classList.add('in-app');
} else if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
