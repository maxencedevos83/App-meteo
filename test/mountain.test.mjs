import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMountain, nearestMassif, parseEawsRatings, applyRainSnow, mountainDays, mountainSources, mountainActivityOptions, mountainAlerts, massifBulletin, buildMountain, ringPoints } from '../web/js/mountain.js';
import { parseBraXml } from '../scripts/montagne.mjs';
import { buildActivities } from '../web/js/activities.js';
import { MODELS } from '../web/js/ensemble.js';

test('relief : montagne, vallée de montagne, mais pas une côte entourée de collines', () => {
  assert.equal(detectMountain(1035, [1100, 2500, 1300, 1050]).mountain, true); // Chamonix
  assert.equal(detectMountain(600, [650, 1400, 900]).mountain, true); // vallée au pied des sommets
  assert.equal(detectMountain(10, [5, 380, 420, 0]).mountain, false); // Le Lavandou et les Maures
  assert.equal(detectMountain(250, [300, 900]).mountain, false); // ville de plaine
  assert.equal(ringPoints(45, 6).length, 17);
});

test('massif Météo-France le plus proche', () => {
  assert.equal(nearestMassif(45.9237, 6.8694).name, 'Mont-Blanc');
  assert.equal(nearestMassif(44.387, 6.652).name, 'Ubaye');
  assert.equal(nearestMassif(43.1375, 6.3683), null); // Le Lavandou : aucun massif
});

test('risque d\'avalanche EAWS par massif', () => {
  const m = parseEawsRatings({ maxDangerRatings: { 'FR-03': 'considerable', 'FR-03:high': 'considerable', 'FR-03:low': 'moderate', 'FR-21:high': 'high', 'AT-07-01': 'low' } });
  assert.deepEqual(m.get(3), { danger: 3, high: 3, low: 2 });
  assert.equal(m.get(21).danger, 4);
  assert.equal(m.has(1), false);
});

test('bulletin Météo-France (XML BRA) : risque selon l\'altitude et météo', () => {
  const xml = `<?xml version="1.0"?><BULLETINS_NEIGE_AVALANCHE TYPEBULLETIN="BERA" ID="3" MASSIF="MONT-BLANC" DATEBULLETIN="2026-12-10T16:00:00" DATEECHEANCE="2026-12-11T18:00:00">
    <CARTOUCHERISQUE><RISQUE RISQUE1="2" LOC1="&lt;2400" ALTITUDE="2400" RISQUE2="3" LOC2="&gt;2400" RISQUEMAXI="3"/><RESUME>Plaques à vent au-dessus de 2400 m.</RESUME></CARTOUCHERISQUE>
    <METEO ALTITUDEVENT1="2000" ALTITUDEVENT2="3000"><ECHEANCE DATE="2026-12-11T00:00:00" DD1="NW" FF1="30" DD2="NW" FF2="60" ISO0="1200" PLUIENEIGE="900" ISO-10="2800"/></METEO></BULLETINS_NEIGE_AVALANCHE>`;
  const b = parseBraXml(xml);
  assert.equal(b.danger, 3);
  assert.equal(b.high, 3);
  assert.equal(b.low, 2);
  assert.equal(b.altitude, 2400);
  assert.equal(b.summary, 'Plaques à vent au-dessus de 2400 m.');
  assert.deepEqual(b.meteo[0], { date: '2026-12-11T00:00:00', iso0: 1200, rainSnow: 900, iso10: 2800, wind: [{ alt: 2000, dir: 'NW', kmh: 30 }, { alt: 3000, dir: 'NW', kmh: 60 }] });
});

const times = Array.from({ length: 48 }, (_, i) => `2026-12-10T${String(i % 24).padStart(2, '0')}:00`.replace('2026-12-10', i < 24 ? '2026-12-10' : '2026-12-11'));
const hourly = (o = {}) => ({
  times, freezing: times.map(() => 1100), snowfall: times.map(() => 0), snowDepth: times.map(() => 40),
  wind850: times.map(() => 10), dir850: times.map(() => 300), temp850: times.map(() => -2),
  wind700: times.map(() => 20), dir700: times.map(() => 300), temp700: times.map(() => -9), ...o,
});

test('pluie ou neige d\'après la limite pluie-neige et l\'altitude', () => {
  const m = { altitude: 1035, summit: 2500, hourly: hourly() };
  const hours = [{ time: times[10], precip: 1.2, temp: 2.5, code: 63 }, { time: times[11], precip: 1.2, temp: 2.5, code: 63 }];
  applyRainSnow(hours, { ...m, hourly: hourly({ freezing: times.map((_, i) => (i === 10 ? 1200 : 2400)) }) });
  assert.equal(hours[0].code, 73); // limite 900 m sous le lieu : neige
  assert.equal(hours[0].rainSnow, 900);
  assert.equal(hours[1].code, 63); // limite 2100 m : pluie
});

test('résumé par jour et bulletin du jour prioritaire', () => {
  const m = { altitude: 1035, hourly: hourly({ snowfall: times.map((_, i) => (i < 24 ? 1 : 0)) }), bulletin: { danger: 3, meteo: [{ date: '2026-12-11T00:00:00', iso0: 1500, rainSnow: 1200 }] } };
  const [d0, d1] = mountainDays(m, ['2026-12-10', '2026-12-11']);
  assert.equal(d0.snowfall, 24);
  assert.equal(d0.freezing, 1100);
  assert.equal(d0.rainSnow, 800);
  assert.equal(d1.freezing, 1500);
  assert.equal(d1.rainSnow, 1200);
  assert.equal(d1.bulletin, true);
});

test('en montagne, AROME pèse plus et GFS moins', () => {
  const src = mountainSources(MODELS.map((m) => ({ ...m })));
  const p = (id) => src.find((s) => s.id === id).prior.temp / MODELS.find((s) => s.id === id).prior.temp;
  assert.ok(p('meteofrance_arome_france_hd') > 1.4 && p('gfs_seamless') < 0.6);
});

test('randonnée et ski : vent sur les crêtes et risque d\'avalanche', () => {
  const hours = times.slice(8, 18).map((t) => ({ time: t, temp: 2, feels: 0, wind: 5, gust: 10, dir: 300, precip: 0, pop: 0, cloud: 10, code: 0, isDay: true }));
  const calm = { altitude: 1600, summit: 2800, hourly: hourly(), bulletin: { danger: 2 } };
  const acts = buildActivities(hours, null, 180, false, mountainActivityOptions(calm));
  const rando = acts.find((a) => a.id === 'balade');
  assert.equal(rando.label, 'Randonnée');
  const ski = acts.find((a) => a.id === 'ski');
  assert.ok(ski && ski.scores[0] >= 70, `ski ${ski?.scores[0]}`);
  const stormy = { ...calm, hourly: hourly({ wind700: times.map(() => 55) }), bulletin: { danger: 4 } };
  const bad = buildActivities(hours, null, 180, false, mountainActivityOptions(stormy));
  assert.ok(bad.find((a) => a.id === 'ski').scores[0] < 10);
  assert.ok(bad.find((a) => a.id === 'balade').scores[0] < rando.scores[0] / 2);
  // Pas de neige : pas de ski.
  const green = buildActivities(hours, null, 180, false, mountainActivityOptions({ ...calm, hourly: hourly({ snowDepth: times.map(() => 0) }) }));
  assert.equal(green.some((a) => a.id === 'ski'), false);
});

test('alertes montagne et bulletin trop ancien ignoré', () => {
  const fc = { now: '2026-12-10T09:00', mountain: { massif: { id: 3, name: 'Mont-Blanc' }, bulletin: { danger: 4, date: '2026-12-10', high: 4, low: 3, altitude: 2200 }, days: [{ date: '2026-12-10', snowfall: 35, rainSnow: 800, wind3000: 70 }] } };
  const a = mountainAlerts(fc);
  assert.ok(a.some((x) => x.type === 'avalanche' && x.level === 3));
  assert.ok(a.some((x) => x.type === 'neige' && x.level === 3));
  const bulletins = { date: '2026-12-01', massifs: [{ id: 3, danger: 3 }] };
  assert.equal(massifBulletin(bulletins, { id: 3 }, '2026-12-10T09:00'), null);
  assert.equal(massifBulletin(bulletins, { id: 3 }, '2026-12-02T09:00').danger, 3);
  assert.equal(buildMountain({ latitude: 43.1375, longitude: 6.3683, altitude: 10, ring: [5, 400] }), null);
});
