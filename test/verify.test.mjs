import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveRun, computeSkill, mergeObs, history, BLEND_ID } from '../scripts/verify.mjs';
import { parseStationsCsv, aggregateHour } from '../scripts/stations.mjs';

const hoursFrom = (start, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(start + ':00Z') + i * 3600000).toISOString().slice(0, 16));

function src(id, n, { temp = 15, wind = 10, gust = 15, precip = 0, dir = 270 } = {}) {
  return { id, times: [], data: { temp: Array(n).fill(temp), wind: Array(n).fill(wind), gust: Array(n).fill(gust), precip: Array(n).fill(precip), dir: Array(n).fill(dir) } };
}

// Simule 4 jours : une prévision archivée toutes les 3 h, et des observations à chaque heure.
function simulate(sources, obsAt) {
  const state = { runs: [], obs: {} };
  let nowKey;
  for (let k = 0; k < 32; k++) {
    nowKey = new Date(Date.parse('2026-10-20T00:00:00Z') + k * 3 * 3600000).toISOString().slice(0, 16);
    const times = hoursFrom(nowKey, 40);
    archiveRun(state, sources.map((s) => ({ ...s, times })), nowKey);
    const obs = {};
    for (const t of times.slice(0, 3)) obs[t] = obsAt(t);
    mergeObs(state, obs, nowKey, { priority: true });
  }
  return { state, nowKey };
}

test('pluie : le modèle qui voit juste la pluie gagne du poids', () => {
  const rainyHour = (t) => +t.slice(11, 13) % 4 === 0;
  const { state } = simulate([src('dry', 40, { precip: 0 }), src('wet', 40, { precip: 2 })], (t) => ({ t: 15, w: 10, p: rainyHour(t) ? 1 : 0 }));
  const { scores, skill } = computeSkill(state);
  assert.ok(scores.dry.precip.accuracy > scores.wet.precip.accuracy);
  assert.ok(skill.dry.precip.factor > skill.wet.precip.factor);
});

test('rafales et secteurs : corrections apprises', () => {
  const { state } = simulate([src('a', 40, { temp: 17, wind: 10, gust: 15, dir: 290 }), src('b', 40, { temp: 15, wind: 14, gust: 20, dir: 290 })], () => ({ t: 15, w: 12, g: 24, d: 290 }));
  const { scores, skill } = computeSkill(state);
  assert.ok(scores.a.gust.ratio > 1.5);
  assert.ok(skill.a.wind.gustRatio > 1);
  assert.ok(skill.a.sectors.O.bias > 0);
  assert.equal(scores.a.sectors.O.n >= 24, true);
});

test('les stations Météo-France priment sur l\'aéroport', () => {
  const state = { obs: {} };
  mergeObs(state, { '2026-10-25T10:00': { t: 20, w: 5 } }, '2026-10-25T12:00', { priority: true });
  mergeObs(state, { '2026-10-25T10:00': { t: 22, w: 9, g: 15 } }, '2026-10-25T12:00');
  assert.deepEqual(state.obs['2026-10-25T10:00'], { t: 20, w: 5, g: 15, src: 'mf' });
});

test('historique : prévision combinée 3 à 12 h avant, face à l\'observé', () => {
  const state = { runs: [], obs: {} };
  const times = hoursFrom('2026-10-25T00:00', 40);
  archiveRun(state, [], '2026-10-25T00:00', [{ id: BLEND_ID, times, data: { temp: Array(40).fill(14), wind: Array(40).fill(8) } }]);
  mergeObs(state, { '2026-10-25T06:00': { t: 15, w: 9 } }, '2026-10-25T07:00', { priority: true });
  const h = history(state, '2026-10-25T07:00');
  assert.equal(h.length, 1);
  assert.equal(h[0].fc.t, 14);
  assert.equal(h[0].obs.t, 15);
});

test('CSV horaire Météo-France : stations proches, unités et heure locale', async () => {
  const lines = [
    'NUM_POSTE;NOM_USUEL;LAT;LON;ALTI;AAAAMMJJHH;RR1;QRR1;FF;QFF;DD;QDD;FXI;QFXI;T;QT',
    '83069001;HYERES;43.0973;6.1460;3;2026102509;0;1;5;1;290;1;9;1;18.2;1',
    '83070001;LE LAVANDOU;43.1380;6.3700;10;2026102509;0.4;1;6;1;300;1;12;1;17.5;1',
    '83137001;LOIN;43.60;5.90;400;2026102509;0;1;2;1;100;1;4;1;12;1',
    '83070001;LE LAVANDOU;43.1380;6.3700;10;2026101009;0;1;6;1;300;1;12;1;17.5;1',
  ];
  async function* gen() { yield* lines; }
  const { stations, byHour } = await parseStationsCsv(gen(), { lat: 43.1375, lon: 6.3683, radiusKm: 25, maxStations: 4, since: '2026102000', timeZone: 'Europe/Paris' });
  assert.deepEqual(stations.map((s) => s.name), ['LE LAVANDOU', 'HYERES']);
  const recs = byHour['2026-10-25T10:00'];
  assert.equal(recs.length, 2);
  const o = aggregateHour(recs, stations);
  assert.ok(o.t >= 17.5 && o.t < 17.7, `température pondérée vers la station proche : ${o.t}`);
  assert.equal(o.d, 300);
  assert.ok(o.w > 11 && o.w < 12);
});

test('CSV horaire Météo-France : liste de stations imposée', async () => {
  const lines = [
    'NUM_POSTE;NOM_USUEL;LAT;LON;ALTI;AAAAMMJJHH;FF;T',
    '83031001;COLLOBRIERES_SAPC;43.2400;6.3100;150;2026102509;1;9.0',
    '83019001;BORMES LES MIMOSAS;43.1500;6.3400;60;2026102509;5;16.0',
  ];
  async function* gen() { yield* lines; }
  const { stations } = await parseStationsCsv(gen(), { lat: 43.1375, lon: 6.3683, radiusKm: 20, maxStations: 4, since: '2026102000', timeZone: 'Europe/Paris', only: ['Bormes les Mimosas'] });
  assert.deepEqual(stations.map((s) => s.name), ['BORMES LES MIMOSAS']);
});
