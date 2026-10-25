import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combine, daily, deriveCode, leadFactor, MODELS, windguruPrior, WINDGURU_GROUP_PRIOR } from '../web/js/ensemble.js';
import { fetchAllOpenMeteo } from '../web/js/sources.js';
import { buildForecast, buildWidget, rainNextHour } from '../web/js/forecast.js';
import { parseForecast } from '../scripts/windguru.mjs';
import { archiveRun, computeSkill, mergeObs } from '../scripts/verify.mjs';

const hoursFrom = (start, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(start + ':00Z') + i * 3600000).toISOString().slice(0, 16));

function src(id, prior, temps, extra = {}) {
  const times = hoursFrom('2026-10-25T10:00', temps.length);
  const n = temps.length;
  return {
    id, label: id, prior, short: 48, lead: 240, times,
    data: { temp: temps, wind: Array(n).fill(extra.wind ?? 10), gust: Array(n).fill(extra.gust ?? 15), dir: Array(n).fill(extra.dir ?? 90), precip: Array(n).fill(extra.precip ?? 0), cloud: Array(n).fill(extra.cloud ?? 10), code: Array(n).fill(extra.code ?? 0) },
  };
}

test('moyenne pondérée selon les poids a priori', () => {
  const a = src('a', { temp: 3 }, [20, 20]);
  const b = src('b', { temp: 1 }, [16, 16]);
  const { hours, weights } = combine([a, b], { now: '2026-10-25T10:20' });
  assert.equal(hours[0].temp, 19);
  assert.equal(Math.round(weights.a * 100), 75);
});

test('les heures passées sont ignorées et les valeurs manquantes exclues', () => {
  const a = src('a', {}, [10, 11, 12]);
  const b = src('b', {}, [null, null, 14]);
  const { hours } = combine([a, b], { now: '2026-10-25T11:00' });
  assert.equal(hours[0].time, '2026-10-25T11:00');
  assert.equal(hours[0].temp, 11);
  assert.equal(hours[1].temp, 13);
});

test('direction du vent moyennée sur le cercle (350° et 10° donnent le nord)', () => {
  const a = src('a', {}, [10], { dir: 350 });
  const b = src('b', {}, [10], { dir: 10 });
  const { hours } = combine([a, b], { now: '2026-10-25T10:00' });
  assert.ok(hours[0].dir < 1 || hours[0].dir > 359);
});

test('probabilité de pluie : part des modèles mouillés mélangée à l\'ensemble', () => {
  const a = src('a', {}, [10], { precip: 1 });
  const b = src('b', {}, [10], { precip: 0 });
  const { hours } = combine([a, b], { now: '2026-10-25T10:00', ensemblePop: { '2026-10-25T10:00': 1 } });
  assert.equal(hours[0].pop, 0.6 * 0.5 + 0.4);
  assert.equal(hours[0].code, 61);
});

test('le désaccord entre modèles fait baisser la confiance', () => {
  const agree = combine([src('a', {}, [15]), src('b', {}, [15])], { now: '2026-10-25T10:00' }).hours[0];
  const split = combine([src('a', {}, [10]), src('b', {}, [20])], { now: '2026-10-25T10:00' }).hours[0];
  assert.ok(agree.confidence > split.confidence);
});

test('la vérification corrige le biais et favorise le modèle le plus juste', () => {
  const a = src('a', {}, [20]);
  const b = src('b', {}, [10]);
  const skill = { a: { temp: { factor: 3, bias: 2 } }, b: { temp: { factor: 1 } } };
  const { hours } = combine([a, b], { now: '2026-10-25T10:00', skill });
  assert.equal(hours[0].temp, (18 * 3 + 10) / 4);
});

test('échéance : poids plein puis décroissant, nul au-delà de la portée', () => {
  const m = { short: 24, lead: 48 };
  assert.equal(leadFactor(m, 10), 1);
  assert.ok(leadFactor(m, 36) < 1 && leadFactor(m, 36) > 0.25);
  assert.equal(leadFactor(m, 49), 0);
});

test('codes météo dérivés', () => {
  assert.equal(deriveCode({ precip: 0, cloud: 5 }), 0);
  assert.equal(deriveCode({ precip: 0, cloud: 95 }), 3);
  assert.equal(deriveCode({ precip: 5, cloud: 100, thunderShare: 0.7 }), 96);
  assert.equal(deriveCode({ precip: 1, cloud: 100, temp: -2 }), 73);
});

test('agrégation journalière', () => {
  const temps = Array.from({ length: 30 }, (_, i) => 10 + (i % 24));
  const { hours } = combine([src('a', {}, temps)], { now: '2026-10-25T10:00' });
  const days = daily(hours);
  assert.equal(days[0].date, '2026-10-25');
  assert.equal(days[0].max, 23);
});

test('pluie dans l\'heure', () => {
  const minutely = ['21:00', '21:15', '21:30', '21:45', '22:00'].map((t, i) => ({ time: `2026-10-25T${t}`, precip: i >= 2 ? 0.4 : 0 }));
  assert.equal(rainNextHour(minutely, '2026-10-25T21:05').text, 'Pluie vers 21h30');
  assert.equal(rainNextHour(minutely.map((m) => ({ ...m, precip: 0 })), '2026-10-25T21:05').text, 'Pas de pluie dans l\'heure');
});

test('Open-Meteo : un modèle en erreur n\'empêche pas les autres', async () => {
  const times = hoursFrom('2026-10-25T00:00', 48);
  const fakeFetch = async (url) => {
    const model = new URL(url).searchParams.get('models');
    if (model === 'icon_d2') return { ok: true, json: async () => ({ hourly: { time: times, temperature_2m: times.map(() => null) } }) };
    if (model === 'gfs_seamless') return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, json: async () => ({ hourly: { time: times, temperature_2m: times.map(() => 15), wind_speed_10m: times.map(() => 12), weather_code: times.map(() => 1) } }) };
  };
  const { sources, errors } = await fetchAllOpenMeteo(43.1, 6.4, 'Europe/Paris', fakeFetch);
  assert.equal(sources.length, MODELS.length - 2);
  assert.equal(errors.length, 2);

  const config = { place: 'Test', latitude: 43.1, longitude: 6.4, timezone: 'Europe/Paris' };
  const fc = buildForecast({ config, sources, now: new Date('2026-10-25T10:00:00Z') });
  assert.equal(fc.now, '2026-10-25T11:00');
  assert.equal(fc.hours[0].temp, 15);
  const w = buildWidget(fc);
  assert.equal(w.temp, 15);
  assert.equal(w.h.length, 6);
  assert.ok(w.d.length >= 2);
  assert.equal(w.d[0].day, 'Auj.');
});

test('Windguru : lecture des pas de 3 h et interpolation horaire', () => {
  const init = Date.UTC(2026, 9, 25, 6) / 1000;
  const json = { fcst: { initstamp: init, hours: [3, 6, 9], TMP: [12, 15, 18], WINDSPD: [6, 9, 12], GUST: [10, 14, 18], WINDDIR: [350, 10, 30], APCP: [0, 3, 0], TCDC: [0, 50, 100] } };
  const p = parseForecast(json, { name: 'GFS 13 km' }, 'Europe/Paris');
  assert.equal(p.times[0], '2026-10-25T10:00');
  assert.equal(p.times.length, 7);
  assert.equal(p.data.temp[1], 13);
  assert.equal(p.data.precip[3], 1);
  assert.ok(p.data.dir[1] > 355 && p.data.dir[2] < 5);
});

test('vérification : archivage, appariement avec les observations et scores', () => {
  const state = { runs: [], obs: {} };
  const good = src('good', {}, Array(40).fill(15), { wind: 10 });
  const bad = src('bad', {}, Array(40).fill(19), { wind: 20 });
  // 12 jours simulés : une prévision archivée toutes les 3 h.
  for (let d = 0; d < 4; d++) {
    for (let h = 0; h < 24; h += 3) {
      const nowKey = new Date(Date.parse('2026-10-20T00:00:00Z') + (d * 24 + h) * 3600000).toISOString().slice(0, 16);
      const times = hoursFrom(nowKey, 40);
      archiveRun(state, [{ ...good, times }, { ...bad, times }], nowKey);
      const obs = {};
      for (const t of times) obs[t] = { t: 14, w: 10 };
      mergeObs(state, obs, nowKey);
    }
  }
  const { scores, skill } = computeSkill(state);
  assert.ok(scores.good.temp.mae < scores.bad.temp.mae);
  assert.ok(skill.good.temp.factor > 1 && skill.bad.temp.factor < 1);
  assert.ok(skill.good.temp.bias > 0);
  assert.ok(skill.bad.wind.ratio < 1);
});

test('Windguru : le poids du groupe est partagé entre ses modèles', () => {
  const p = windguruPrior(19);
  assert.ok(Math.abs(p.wind * 19 - WINDGURU_GROUP_PRIOR.wind) < 1e-9);
  // Le groupe pèse plus lourd pour le vent que pour la température.
  assert.ok(WINDGURU_GROUP_PRIOR.wind / WINDGURU_GROUP_PRIOR.temp > 1.5);
});
