import { codeEmoji, codeLabel, dirLabel } from './ensemble.js';
import { fetchAllOpenMeteo, fetchEnsemblePop, fetchNowcast, fetchMarine, geocode } from './sources.js';
import { buildForecast } from './forecast.js';

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

async function loadHome() {
  const res = await fetch(`data/forecast.json?t=${Date.now()}`, { cache: 'no-store' });
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
  return fc;
}

async function load() {
  const btn = $('#refresh');
  btn.classList.add('spin');
  const other = store.get('place');
  try {
    let fc;
    if (other) fc = await loadPlace(other);
    else {
      try { fc = await loadHome(); }
      catch (e) {
        // Pas encore de données serveur (première installation) : calcul direct dans le navigateur.
        const cfg = await fetch('config.json').then((r) => r.json()).catch(() => ({ place: 'Le Lavandou', latitude: 43.1375, longitude: 6.3683, timezone: 'Europe/Paris' }));
        fc = await loadPlace({ name: cfg.place, ...cfg });
      }
    }
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
  renderHero(fc);
  renderChart(fc.hours.slice(0, 48));
  renderHourly(fc.hours.slice(0, 48));
  renderWind(fc.hours.slice(0, 30));
  renderDays(fc.days);
  renderSea(fc.marine);
  renderSources(fc);
  radar.center(fc.latitude, fc.longitude);
}

function renderHero(fc) {
  const h = fc.hours[0];
  const d = fc.days[0] || {};
  const bars = (fc.rain?.slots || []).map((s) => `<span style="height:${Math.min(22, 2 + (s.precip || 0) * 10)}px" title="${s.time.slice(11)} : ${s.precip} mm"></span>`).join('');
  const banner = fc.local ? '<div class="banner" style="margin-bottom:12px;color:var(--ink)">Lieu secondaire : modèles Open-Meteo seulement (Windguru et vérification locale sont réservés au lieu principal).</div>' : '';
  $('#hero').innerHTML = `${banner}
    <div class="hero-main">
      <div class="hero-icon">${codeEmoji(h.code, h.isDay)}</div>
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
      <div class="stat"><small>Vent</small><b>${arrow(h.dir)} ${r0(h.wind)} kn</b><small>${dirLabel(h.dir)} · raf. ${r0(h.gust)}</small></div>
      <div class="stat"><small>Pluie</small><b>${h.pop ?? 0} %</b><small>${h.precip ?? 0} mm/h</small></div>
      <div class="stat"><small>Fiabilité</small><b class="conf"><i style="background:${confColor(h.confidence)}"></i>${h.confidence} %</b><small>${h.n} modèles</small></div>
    </div>`;
}

function renderChart(hours) {
  if (!hours.length) return;
  const W = Math.max(280, $('#chart').clientWidth || 600), H = 160, padL = 26, padR = 8, padT = 12, padB = 20;
  const temps = hours.flatMap((h) => [h.temp - (h.tempSpread || 0), h.temp + (h.tempSpread || 0)]).filter((v) => !Number.isNaN(v));
  const lo = Math.floor(Math.min(...temps) - 1), hi = Math.ceil(Math.max(...temps) + 1);
  const x = (i) => padL + (i / (hours.length - 1)) * (W - padL - padR);
  const y = (t) => padT + (1 - (t - lo) / (hi - lo || 1)) * (H - padT - padB);
  const maxP = Math.max(2, ...hours.map((h) => h.precip || 0));
  const bw = (W - padL - padR) / hours.length;
  const bars = hours.map((h, i) => {
    const bh = ((h.precip || 0) / maxP) * (H - padT - padB) * 0.6;
    const op = 0.25 + 0.75 * ((h.pop ?? 0) / 100);
    return bh > 0.5 ? `<rect x="${x(i) - bw / 2 + 1}" y="${H - padB - bh}" width="${bw - 2}" height="${bh}" fill="var(--rain)" opacity="${op.toFixed(2)}"/>` : '';
  }).join('');
  const up = hours.map((h, i) => `${x(i)},${y(h.temp + (h.tempSpread || 0))}`);
  const down = hours.map((h, i) => `${x(i)},${y(h.temp - (h.tempSpread || 0))}`).reverse();
  const line = hours.map((h, i) => `${i ? 'L' : 'M'}${x(i)},${y(h.temp)}`).join('');
  const grid = [];
  for (let t = Math.ceil(lo / 2) * 2; t <= hi; t += Math.max(2, Math.round((hi - lo) / 4 / 2) * 2)) {
    grid.push(`<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)"/><text x="${padL - 4}" y="${y(t) + 3}" text-anchor="end">${t}°</text>`);
  }
  const labels = hours.map((h, i) => {
    const hr = +h.time.slice(11, 13);
    if (hr === 0) return `<line x1="${x(i)}" x2="${x(i)}" y1="${padT}" y2="${H - padB}" stroke="var(--line)" stroke-dasharray="3 3"/><text x="${x(i) + 3}" y="${H - 6}">${FR_DAYS[new Date(h.time.slice(0, 10) + 'T12:00Z').getUTCDay()]}</text>`;
    return hr % 6 === 0 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${hr}h</text>` : '';
  }).join('');
  $('#chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Température et pluie sur 48 heures">
    ${grid.join('')}${bars}
    <polygon points="${[...up, ...down].join(' ')}" fill="var(--warm)" opacity="0.15"/>
    <path d="${line}" fill="none" stroke="var(--warm)" stroke-width="2.2"/>
    ${labels}
  </svg>`;
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
  const cell = (v) => `<td style="background:${windColor(v)};color:#111">${r0(v)}</td>`;
  $('#wind').innerHTML = `<table>
    <tr><th>Heure</th>${hours.map((h) => `<td>${+h.time.slice(11, 13)}h</td>`).join('')}</tr>
    <tr><th>Vent</th>${hours.map((h) => cell(h.wind)).join('')}</tr>
    <tr><th>Rafales</th>${hours.map((h) => cell(h.gust)).join('')}</tr>
    <tr><th>Dir.</th>${hours.map((h) => `<td title="${dirLabel(h.dir)}">${arrow(h.dir)}</td>`).join('')}</tr>
    <tr><th>Écart</th>${hours.map((h) => `<td style="color:var(--muted)">±${r0(h.windSpread)}</td>`).join('')}</tr>
  </table>`;
}

function renderDays(days) {
  const all = days.filter((d) => d.min != null);
  const lo = Math.min(...all.map((d) => d.min)), hi = Math.max(...all.map((d) => d.max));
  $('#days').innerHTML = all.map((d, i) => {
    const date = new Date(d.date + 'T12:00Z');
    const name = i === 0 ? 'Auj.' : i === 1 ? 'Dem.' : FR_DAYS[date.getUTCDay()];
    const left = ((d.min - lo) / (hi - lo || 1)) * 100, width = ((d.max - d.min) / (hi - lo || 1)) * 100;
    return `<div class="day">
      <div class="name">${name}<small>${date.getUTCDate()}/${date.getUTCMonth() + 1}</small></div>
      <div class="e">${codeEmoji(d.code, true)}</div>
      <div class="range"><span style="left:${left}%;width:${Math.max(width, 3)}%"></span></div>
      <div class="temps"><span class="lo">${r0(d.min)}°</span><span>${r0(d.max)}°</span></div>
      <div class="meta">
        <span class="${d.pop >= 30 ? 'wet' : ''}">💧 ${d.pop} %${d.precip >= 0.5 ? ` · ${d.precip} mm` : ''}</span>
        <span>${arrow(d.dir)} ${d.wind} kn (${d.gust})</span>
        <span class="conf"><i style="background:${confColor(d.confidence)}"></i>${d.confidence} %</span>
      </div>
    </div>`;
  }).join('');
}

function renderSea(marine) {
  const m = marine?.find((x) => x.wave != null || x.sst != null);
  $('#sea-card').hidden = !m;
  if (!m) return;
  const maxWave = Math.max(...marine.slice(0, 24).map((x) => x.wave || 0));
  $('#sea').innerHTML = `
    <div class="stat"><small>Eau</small><b>${m.sst != null ? `${m.sst.toFixed(1)}°` : '–'}</b></div>
    <div class="stat"><small>Vagues</small><b>${m.wave != null ? `${m.wave.toFixed(1)} m` : '–'}</b><small>${m.period ? `${Math.round(m.period)} s · ` : ''}${dirLabel(m.waveDir)}</small></div>
    <div class="stat"><small>Max 24 h</small><b>${maxWave.toFixed(1)} m</b></div>`;
}

function renderSources(fc) {
  const scores = Object.fromEntries((fc.scores?.models || []).map((m) => [m.id, m]));
  const maxW = Math.max(...fc.models.map((m) => m.weight || 0), 1);
  const verif = fc.scores
    ? ` Les modèles sont comparés en continu aux observations de la station ${esc(fc.scores.station)} (${fc.scores.observations} relevés) : ceux qui se trompent le moins chez toi gagnent du poids, et leurs biais sont corrigés.`
    : '';
  $('#explain').innerHTML = `Chaque valeur est une moyenne pondérée de ${fc.models.length} modèles. Les modèles fins de Météo-France (AROME) pèsent le plus à courte échéance, ECMWF à plus long terme, et Windguru compte double pour le vent.${verif}`;
  const fmt = (s, k, unit) => (s?.[k] ? `${s[k].mae.toFixed(1)} ${unit}<small>${s[k].n} comp.</small>` : '<small>en cours</small>');
  $('#sources').innerHTML = `<table>
    <tr><th>Modèle</th><th>Poids</th><th class="num">Erreur temp.</th><th class="num">Erreur vent</th></tr>
    ${fc.models.map((m) => `<tr>
      <td>${esc(m.label)}<small>${esc(m.provider || '')}</small></td>
      <td style="width:22%"><div class="wbar" style="width:${(m.weight / maxW) * 100}%"></div><small>${m.weight} %</small></td>
      <td class="num">${fc.local ? '–' : fmt(scores[m.id], 'temp', '°')}</td>
      <td class="num">${fc.local ? '–' : fmt(scores[m.id], 'wind', 'kn')}</td>
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
  center(lat, lon) {
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
    $('#radar-time').textContent = `${t}${f.future ? ' (prévision)' : ''}`;
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
setupSearch();
radar.init();
load();
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15 * 60000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
