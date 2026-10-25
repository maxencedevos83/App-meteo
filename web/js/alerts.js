// Alertes affichées dans l'appli et envoyées en notification par le widget Android.
// Chaque alerte a un identifiant stable : le téléphone ne notifie qu'une fois la même alerte.
const hhmm = (t) => `${+t.slice(11, 13)}h${t.slice(14, 16) === '00' ? '' : t.slice(14, 16)}`;
const FR_DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

export function dayWord(time, nowKey) {
  const d = time.slice(0, 10);
  if (d === nowKey.slice(0, 10)) return "aujourd'hui";
  const tomorrow = new Date(Date.parse(nowKey.slice(0, 10) + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  if (d === tomorrow) return 'demain';
  return FR_DAYS[new Date(d + 'T12:00:00Z').getUTCDay()];
}

// opts : { gustKn, vigilance: [...], sessionMin }
export function buildAlerts(fc, { gustKn = 30, vigilance = [], sessionMin = 75 } = {}) {
  const alerts = [];
  const now = fc.now;

  for (const v of vigilance) {
    alerts.push({ id: `vig-${v.type}-${v.level}-${v.onset}`, type: 'vigilance', level: v.level, title: `Vigilance ${v.color} ${v.type.toLowerCase()}`, text: v.headline || `Du ${v.onsetLabel} au ${v.expiresLabel}`, until: v.expires });
  }

  // Pluie dans l'heure (créneaux de 15 min).
  const slots = fc.rain?.slots || [];
  const firstWet = slots.find((s) => (s.precip ?? 0) >= 0.1);
  if (firstWet) {
    const ongoing = slots[0] && (slots[0].precip ?? 0) >= 0.1;
    alerts.push({ id: `rain-${firstWet.time.slice(0, 13)}`, type: 'pluie', level: 1, title: ongoing ? 'Il pleut' : `Pluie vers ${hhmm(firstWet.time)}`, text: fc.rain.text });
  }

  // Orages et coups de vent sur les 12 prochaines heures.
  const next12 = fc.hours.slice(0, 12);
  const storm = next12.find((h) => h.code >= 95 && (h.pop ?? 0) >= 40);
  if (storm) alerts.push({ id: `orage-${storm.time.slice(0, 10)}`, type: 'orage', level: 3, title: `Risque d'orage ${dayWord(storm.time, now)} vers ${hhmm(storm.time)}`, text: `Probabilité de pluie ${storm.pop} %` });
  const windy = next12.filter((h) => (h.gust ?? 0) >= gustKn);
  if (windy.length) {
    const peak = windy.reduce((a, b) => (b.gust > a.gust ? b : a));
    alerts.push({ id: `vent-${windy[0].time.slice(0, 10)}-${gustKn}`, type: 'vent', level: peak.gust >= gustKn + 10 ? 3 : 2, title: `Coup de vent : rafales ${peak.gust} kn`, text: `Dès ${hhmm(windy[0].time)}, maximum vers ${hhmm(peak.time)} (vent moyen ${peak.wind} kn)` });
  }

  // Bons créneaux de sortie aujourd'hui et demain.
  for (const a of fc.activities || []) {
    if (a.id === 'balade' || a.id === 'baignade') continue;
    const w = a.windows.find((x) => x.score >= sessionMin && ['aujourd\'hui', 'demain'].includes(dayWord(x.start, now)) && x.end >= now.slice(0, 13) + ':00');
    if (w) alerts.push({ id: `session-${a.id}-${w.start}`, type: 'session', level: 0, title: `${a.emoji} ${a.label} : bon créneau ${dayWord(w.start, now)}`, text: `${hhmm(w.start)} à ${+w.end.slice(11, 13) + 1}h · ${w.wind} kn ${w.dir} (raf. ${w.gust})` });
  }
  return alerts;
}
