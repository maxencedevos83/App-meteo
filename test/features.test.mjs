import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreHour, shoreAngle, bestWindows, buildActivities } from '../web/js/activities.js';
import { buildAlerts, dayWord } from '../web/js/alerts.js';
import { parseMeteoAlarm } from '../scripts/vigilance.mjs';

const H = (o) => ({ time: '2026-10-26T14:00', temp: 22, wind: 18, gust: 22, dir: 150, pop: 0, cloud: 10, code: 0, isDay: true, ...o });

test('orientation de la plage : vent de mer / vent de terre', () => {
  assert.equal(shoreAngle(150, 150), 0);
  assert.equal(shoreAngle(330, 150), 180);
  assert.equal(shoreAngle(240, 150), 90);
});

test('kite : bon par vent de mer établi, mauvais par vent de terre ou rafaleux', () => {
  const good = scoreHour('kite', H({}), { wave: 0.6 }, 150).score;
  const offshore = scoreHour('kite', H({ dir: 330 }), null, 150);
  const gusty = scoreHour('kite', H({ gust: 36 }), null, 150).score;
  assert.ok(good >= 85, `bon créneau ${good}`);
  assert.ok(offshore.score < 20 && offshore.notes.includes('vent de terre'));
  assert.ok(gusty < good / 2);
});

test('baignade : eau chaude, peu de vent, soleil', () => {
  const summer = scoreHour('baignade', H({ temp: 28, wind: 5, gust: 8 }), { sst: 24, wave: 0.2 }, 150).score;
  const autumn = scoreHour('baignade', H({ temp: 18, wind: 5, gust: 8 }), { sst: 17, wave: 0.2 }, 150).score;
  assert.ok(summer > 80 && autumn < 15);
});

test('la nuit et les orages font chuter les scores', () => {
  assert.ok(scoreHour('voile', H({ wind: 12, gust: 16, isDay: false }), null, 150).score < 25);
  assert.ok(scoreHour('voile', H({ wind: 12, gust: 16, code: 95, pop: 60 }), null, 150).score < 10);
});

test('meilleurs créneaux : heures de jour consécutives', () => {
  const hours = Array.from({ length: 10 }, (_, i) => H({ time: `2026-10-26T${String(8 + i).padStart(2, '0')}:00` }));
  const scores = [10, 70, 80, 90, 20, 65, 70, 10, 10, 10];
  const w = bestWindows(hours, scores);
  assert.equal(w.length, 2);
  assert.deepEqual([w[0].start, w[0].end, w[0].hours], ['2026-10-26T09:00', '2026-10-26T11:00', 3]);
});

test('alertes : pluie dans l\'heure, coup de vent, vigilance, créneau', () => {
  const hours = Array.from({ length: 24 }, (_, i) => H({ time: new Date(Date.parse('2026-10-26T10:00:00Z') + i * 3600000).toISOString().slice(0, 16), gust: i === 3 ? 38 : 20, wind: 18 }));
  const fc = { now: '2026-10-26T10:05', hours, rain: { text: 'Pluie vers 10h30', slots: [{ time: '2026-10-26T10:00', precip: 0 }, { time: '2026-10-26T10:15', precip: 0 }, { time: '2026-10-26T10:30', precip: 0.5 }] } };
  fc.activities = buildActivities(hours, [], 150);
  const alerts = buildAlerts(fc, { gustKn: 30, vigilance: [{ type: 'Vent', level: 3, color: 'orange', onset: '2026-10-26T08:00:00+00:00', headline: 'Vent violent' }] });
  const types = alerts.map((a) => a.type);
  assert.deepEqual(types.slice(0, 3), ['vigilance', 'pluie', 'vent']);
  assert.ok(types.includes('session'));
  assert.equal(alerts.find((a) => a.type === 'pluie').title, 'Pluie vers 10h30');
  assert.ok(alerts.find((a) => a.type === 'vent').title.includes('38'));
  assert.equal(dayWord('2026-10-27T09:00', '2026-10-26T10:05'), 'demain');
});

test('MeteoAlarm : vigilance du Var, niveau et type', () => {
  const json = { warnings: [
    { alert: { info: [
      { language: 'fr-FR', event: 'Vent violent', headline: 'Vigilance orange vent', onset: '2026-10-26T06:00:00+00:00', expires: '2026-10-27T06:00:00+00:00',
        parameter: [{ valueName: 'awareness_level', value: '3; orange; Severe' }, { valueName: 'awareness_type', value: '1; Wind' }],
        area: [{ areaDesc: 'Var', geocode: [{ valueName: 'EMMA_ID', value: 'FR083' }] }] },
      { language: 'en-GB', event: 'Wind', parameter: [{ valueName: 'awareness_level', value: '3; orange; Severe' }], area: [{ areaDesc: 'Var' }] },
    ] } },
    { alert: { info: [{ language: 'fr-FR', event: 'Orages', expires: '2026-10-27T06:00:00+00:00', parameter: [{ valueName: 'awareness_level', value: '2; yellow; Moderate' }, { valueName: 'awareness_type', value: '3; Thunderstorm' }], area: [{ areaDesc: 'Bouches-du-Rhône', geocode: [{ valueName: 'EMMA_ID', value: 'FR013' }] }] }] } },
    { alert: { info: [{ language: 'fr-FR', expires: '2026-10-25T06:00:00+00:00', parameter: [{ valueName: 'awareness_level', value: '2; yellow' }], area: [{ areaDesc: 'Var' }] }] } },
  ] };
  const v = parseMeteoAlarm(json, { dept: '83', now: new Date('2026-10-26T10:00:00Z') });
  assert.equal(v.length, 1);
  assert.deepEqual([v[0].type, v[0].level, v[0].color], ['Vent', 3, 'orange']);
});
