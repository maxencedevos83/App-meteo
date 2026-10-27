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

test('sortie bateau : mer calme et vent modéré, pas par coup de vent ni mer formée', () => {
  const calm = scoreHour('bateau', H({ wind: 6, gust: 9 }), { wave: 0.3 }, 150).score;
  const windy = scoreHour('bateau', H({ wind: 18, gust: 26 }), { wave: 0.6 }, 150).score;
  const rough = scoreHour('bateau', H({ wind: 6, gust: 9 }), { wave: 1.1 }, 150);
  assert.ok(calm >= 85, `bon créneau ${calm}`);
  assert.ok(windy < 20, `vent fort ${windy}`);
  assert.ok(rough.score < 30 && rough.notes.includes('mer agitée'));
});

test('baignade : eau chaude, peu de vent, soleil', () => {
  const summer = scoreHour('baignade', H({ temp: 28, wind: 5, gust: 8 }), { sst: 24, wave: 0.2 }, 150).score;
  const autumn = scoreHour('baignade', H({ temp: 18, wind: 5, gust: 8 }), { sst: 17, wave: 0.2 }, 150).score;
  assert.ok(summer > 80 && autumn < 15);
});

test('la nuit et les orages font chuter les scores', () => {
  assert.ok(scoreHour('bateau', H({ wind: 6, gust: 9, isDay: false }), null, 150).score < 25);
  assert.ok(scoreHour('bateau', H({ wind: 6, gust: 9, code: 95, pop: 60 }), null, 150).score < 10);
});

test('meilleurs créneaux : heures de jour consécutives', () => {
  const hours = Array.from({ length: 10 }, (_, i) => H({ time: `2026-10-26T${String(8 + i).padStart(2, '0')}:00` }));
  const scores = [10, 70, 80, 90, 20, 65, 70, 10, 10, 10];
  const w = bestWindows(hours, scores);
  assert.equal(w.length, 2);
  assert.deepEqual([w[0].start, w[0].end, w[0].hours], ['2026-10-26T09:00', '2026-10-26T11:00', 3]);
});

test('alertes : pluie dans l\'heure, coup de vent, vigilance, créneau', () => {
  const hours = Array.from({ length: 24 }, (_, i) => H({ time: new Date(Date.parse('2026-10-26T10:00:00Z') + i * 3600000).toISOString().slice(0, 16), gust: i === 3 ? 38 : i < 5 ? 20 : 8, wind: i < 5 ? 18 : 5 }));
  const fc = { now: '2026-10-26T10:05', hours, rain: { text: 'Pluie vers 10h30', slots: [{ time: '2026-10-26T10:00', precip: 0 }, { time: '2026-10-26T10:15', precip: 0 }, { time: '2026-10-26T10:30', precip: 0.5 }] } };
  fc.activities = buildActivities(hours, [], 150);
  const alerts = buildAlerts(fc, { gustKn: 30, vigilance: [{ type: 'Vent', level: 3, color: 'orange', onset: '2026-10-26T08:00:00+00:00', headline: 'Vent violent' }] });
  const types = alerts.map((a) => a.type);
  assert.deepEqual(types.slice(0, 3), ['vigilance', 'pluie', 'vent']);
  assert.ok(types.includes('session'));
  assert.equal(alerts.find((a) => a.type === 'pluie').title, 'Pluie vers 10h30');
  assert.ok(alerts.find((a) => a.type === 'vent').title.includes('70 km/h'));
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

test('soleil et lune au Lavandou', async () => {
  const { skyDay } = await import('../web/js/astro.js');
  const d = skyDay('2026-10-27', 43.1375, 6.3683, 'Europe/Paris');
  assert.equal(d.sunrise, '07:03');
  assert.equal(d.sunset, '17:35');
  assert.ok(d.moonrise && d.moonset);
  assert.ok(d.moonLit > 90); // pleine lune le 26 octobre 2026
});

test('prévision recalée sur l\'heure actuelle : plus de nuit à 8 h', async () => {
  const { freshen } = await import('../web/js/forecast.js');
  const hours = Array.from({ length: 12 }, (_, i) => ({ time: `2026-10-27T${String(3 + i).padStart(2, '0')}:00`, isDay: 3 + i >= 8 }));
  const fc = { timezone: 'Europe/Paris', now: '2026-10-27T03:21', generatedAt: '2026-10-27T02:21:00Z', hours, days: [{ date: '2026-10-27' }], activities: [{ scores: hours.map((_, i) => i), windows: [] }] };
  const f = freshen(fc, new Date('2026-10-27T07:10:00Z'));
  assert.equal(f.hours[0].time, '2026-10-27T08:00');
  assert.equal(f.hours[0].isDay, true);
  assert.equal(f.activities[0].scores[0], 5);
});

test('drapeau estimé : vert par mer calme, jaune ou rouge par vagues et vent de terre', async () => {
  const { beachFlag } = await import('../web/js/activities.js');
  assert.equal(beachFlag(H({ wind: 5, gust: 8 }), { wave: 0.3 }, 150).color, 'vert');
  assert.equal(beachFlag(H({ wind: 5, gust: 8 }), { wave: 1 }, 150).color, 'jaune');
  assert.equal(beachFlag(H({ wind: 18, gust: 26, dir: 330 }), { wave: 0.3 }, 150).color, 'rouge');
  assert.equal(beachFlag(H({ wind: 5, gust: 8, code: 95 }), { wave: 0.3 }, 150).color, 'rouge');
});

test('vigilance espagnole : zone par son nom', async () => {
  const { parseMeteoAlarm } = await import('../scripts/vigilance.mjs');
  const json = { warnings: [{ alert: { info: [
    { language: 'es-ES', event: 'Aviso amarillo por costeros', headline: 'Aviso amarillo', onset: '2026-10-27T06:00:00+00:00', expires: '2026-10-28T06:00:00+00:00',
      parameter: [{ valueName: 'awareness_level', value: '2; yellow; Moderate' }, { valueName: 'awareness_type', value: '7; coastalevent' }],
      area: [{ areaDesc: 'Costa - Litoral norte de Tarragona' }] },
  ] } }] };
  const list = parseMeteoAlarm(json, { dept: '', areaName: ['Litoral norte de Tarragona', 'Costa - Litoral norte de Tarragona'], lang: 'es', timeZone: 'Europe/Madrid', now: new Date('2026-10-27T08:00:00Z') });
  assert.equal(list.length, 1);
  assert.equal(list[0].type, 'Vagues-submersion');
});

test('Meteocat : mesures regroupées par heure locale', async () => {
  const { hourlyObs } = await import('../scripts/meteocat.mjs');
  const rows = [
    { codi_estacio: 'A', codi_variable: '32', data_lectura: '2026-10-27T06:00:00.000', valor_lectura: '15.2' },
    { codi_estacio: 'A', codi_variable: '30', data_lectura: '2026-10-27T06:00:00.000', valor_lectura: '5' },
    { codi_estacio: 'A', codi_variable: '35', data_lectura: '2026-10-27T05:30:00.000', valor_lectura: '0.4' },
    { codi_estacio: 'A', codi_variable: '35', data_lectura: '2026-10-27T06:00:00.000', valor_lectura: '0.2' },
  ];
  const obs = hourlyObs(rows, [{ id: 'A', km: 3 }], 'Europe/Madrid');
  assert.equal(obs['2026-10-27T07:00'].t, 15.2);
  assert.equal(obs['2026-10-27T07:00'].w, 9.7);
  assert.equal(obs['2026-10-27T07:00'].p, 0.6);
});
