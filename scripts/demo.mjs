// Données fictives pour tester l'interface sans réseau : node scripts/demo.mjs
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MODELS, WINDGURU_PRIOR, localKey } from '../web/js/ensemble.js';
import { buildForecast, buildWidget } from '../web/js/forecast.js';

const root = new URL('..', import.meta.url).pathname;
const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const now = new Date();
const start = localKey(now, config.timezone).slice(0, 14) + '00';
const times = Array.from({ length: 240 }, (_, i) => new Date(Date.parse(start + ':00Z') + i * 3600000).toISOString().slice(0, 16));
const rnd = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const models = [...MODELS, { id: 'windguru_3', label: 'Windguru GFS 13 km', provider: 'Windguru', prior: WINDGURU_PRIOR, short: 48, lead: 240 }];
const sources = models.map((m, k) => {
  const r = rnd(k + 7);
  const off = (r() - 0.5) * 2;
  const data = { temp: [], feels: [], precip: [], wind: [], gust: [], dir: [], cloud: [], rh: [], pressure: [], code: [] };
  times.forEach((t, i) => {
    const hr = +t.slice(11, 13);
    const temp = 15 + off + 5 * Math.sin(((hr - 9) / 24) * 2 * Math.PI) - i / 60 + (r() - 0.5) * (i / 50);
    const rain = i > 30 && i < 42 ? Math.max(0, 1.5 * Math.sin((i - 30) / 12 * Math.PI) + (r() - 0.6)) : 0;
    const wind = 8 + 10 * Math.max(0, Math.sin(i / 14)) + off * 2 + r() * 3;
    data.temp.push(temp); data.feels.push(temp - 1.5); data.precip.push(rain);
    data.wind.push(wind); data.gust.push(wind * 1.5); data.dir.push((90 + i * 3 + off * 20) % 360);
    data.cloud.push(rain > 0 ? 95 : 30 + 30 * Math.sin(i / 9)); data.rh.push(70); data.pressure.push(1015); data.code.push(rain > 0 ? 61 : 2);
  });
  return { ...m, times, data };
});
const minutely = Array.from({ length: 12 }, (_, i) => ({ time: new Date(Date.parse(start + ':00Z') + i * 900000).toISOString().slice(0, 16), precip: i > 4 ? 0.3 : 0 }));
const sun = Array.from({ length: 10 }, (_, d) => { const date = times[d * 24].slice(0, 10); return { date, sunrise: `${date}T07:40`, sunset: `${date}T17:25`, uv: 3 }; });
const marine = times.slice(0, 72).map((t) => ({ time: t, wave: 0.6, waveDir: 120, period: 5, sst: 19.4 }));
const scores = { station: config.metar, observations: 210, runs: 40, models: models.map((m, k) => ({ id: m.id, label: m.label, temp: { n: 180, mae: 0.8 + k * 0.12, bias: 0.3 }, wind: { n: 180, mae: 2 + k * 0.2, ratio: 1 } })) };
const fc = buildForecast({ config, sources, nowcast: { minutely, sun, isDay: true }, marine, scores, now });
await mkdir(join(root, 'out', 'data'), { recursive: true });
await writeFile(join(root, 'out', 'data', 'forecast.json'), JSON.stringify(fc));
await writeFile(join(root, 'out', 'data', 'widget.json'), JSON.stringify(buildWidget(fc), null, 1));
console.log('Données de démo écrites dans out/data/');
