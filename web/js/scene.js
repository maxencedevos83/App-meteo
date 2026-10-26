// Scène animée derrière le bandeau principal : ciel, soleil, lune et étoiles, nuages, pluie, neige, éclairs, vent.
// Même logique que les icônes animées du widget Android (WeatherArt.kt).

export function skyKind(code) {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2) return 'partly';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloudy';
}

let running = null;

// anchor : élément du bandeau où placer le soleil ou la lune (à la place de l'icône).
export function startScene(host, { code, isDay, wind = 0, gust = 0, anchor = null }) {
  running?.stop();
  const kind = skyKind(code);
  host.dataset.sky = `${kind}-${isDay ? 'day' : 'night'}`;
  const canvas = document.createElement('canvas');
  canvas.className = 'hero-scene';
  canvas.setAttribute('aria-hidden', 'true');
  host.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const windy = gust >= 30 || wind >= 18;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rand = mulberry32(code * 97 + (isDay ? 1 : 2));
  let W = 0, H = 0, dpr = 1;

  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = host.clientWidth; H = host.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
  };
  resize();

  // Particules créées une fois, puis déplacées à chaque image.
  const n = kind === 'rain' ? 90 : kind === 'storm' ? 110 : kind === 'drizzle' ? 45 : kind === 'snow' ? 60 : 0;
  const drops = Array.from({ length: n }, () => ({ x: rand(), y: rand(), v: 0.6 + rand() * 0.6, s: rand() }));
  const stars = !isDay && (kind === 'clear' || kind === 'partly') ? Array.from({ length: 40 }, () => ({ x: rand(), y: rand() * 0.7, r: 0.5 + rand() * 1.3, p: rand() * 6 })) : [];
  const cloudCount = { clear: 0, partly: 2, cloudy: 4, fog: 3, drizzle: 3, rain: 4, snow: 3, storm: 4 }[kind];
  const clouds = Array.from({ length: cloudCount }, (_, i) => ({ x: rand(), y: 0.08 + rand() * 0.35, s: 0.7 + rand() * 0.7, v: 0.004 + rand() * 0.006, i }));
  const streaks = windy ? Array.from({ length: 7 }, () => ({ x: rand(), y: 0.1 + rand() * 0.8, l: 0.15 + rand() * 0.2, v: 0.25 + rand() * 0.2 })) : [];
  let flash = 0, nextFlash = 2;

  const cloudColor = kind === 'storm' ? [90, 92, 118] : kind === 'rain' ? [150, 160, 176] : [240, 244, 250];

  function frame(now) {
    const t = now / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    for (const s of stars) {
      ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.8 + s.p));
      ctx.fillStyle = '#fffbe6';
      ctx.beginPath(); ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (kind === 'clear' || kind === 'partly' || (kind === 'drizzle' && isDay)) {
      const a = anchor?.getBoundingClientRect(), hb = host.getBoundingClientRect();
      const cx = a ? a.left - hb.left + a.width / 2 : W * 0.15;
      const cy = a ? a.top - hb.top + a.height / 2 : H * 0.2;
      const r = a ? a.width * 0.3 : 26;
      if (isDay) sun(ctx, cx, cy, r, t); else moon(ctx, cx, cy, r);
    }

    for (const c of clouds) {
      const x = ((c.x + t * c.v) % 1.4) - 0.2;
      cloud(ctx, x * W, c.y * H, c.s * Math.min(70, W * 0.16), cloudColor, kind === 'fog' ? 0.4 : kind === 'storm' || kind === 'rain' ? 0.6 : 0.45);
    }

    if (kind === 'fog') {
      for (let i = 0; i < 4; i++) {
        const y = H * (0.35 + i * 0.16), dx = Math.sin(t * 0.3 + i) * 30;
        ctx.fillStyle = 'rgba(235,240,245,0.16)';
        roundRect(ctx, -40 + dx, y, W + 80, 18, 9); ctx.fill();
      }
    }

    // Pluie ou neige.
    const slant = windy ? 0.35 : 0.08;
    for (const d of drops) {
      if (kind === 'snow') {
        d.y += 0.0012 * d.v; d.x += Math.sin(t + d.s * 6) * 0.0006;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath(); ctx.arc((d.x % 1) * W, d.y * H, 1.5 + d.s * 2, 0, Math.PI * 2); ctx.fill();
      } else {
        d.y += 0.016 * d.v; d.x -= 0.016 * d.v * slant * (H / W);
        const x = (((d.x % 1) + 1) % 1) * W, y = d.y * H, len = kind === 'drizzle' ? 6 : 13;
        ctx.strokeStyle = `rgba(170,210,255,${0.35 + d.s * 0.4})`;
        ctx.lineWidth = kind === 'drizzle' ? 1 : 1.4;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - len * slant, y + len); ctx.stroke();
      }
      if (d.y > 1.05) { d.y = -0.05; d.x = rand(); }
    }

    // Orage : éclairs à intervalle irrégulier.
    if (kind === 'storm') {
      if (t > nextFlash) { flash = 1; nextFlash = t + 2.5 + rand() * 4; boltAt = rand(); }
      if (flash > 0) {
        ctx.fillStyle = `rgba(255,250,220,${flash * 0.35})`;
        ctx.fillRect(0, 0, W, H);
        if (flash > 0.6) bolt(ctx, W * (0.2 + boltAt * 0.6), H * 0.15, H * 0.7);
        flash -= 0.06;
      }
    }

    for (const s of streaks) {
      const x = ((s.x + t * s.v) % 1.5) - 0.3;
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x * W, s.y * H);
      ctx.bezierCurveTo((x + s.l * 0.3) * W, s.y * H - 6, (x + s.l * 0.6) * W, s.y * H + 6, (x + s.l) * W, s.y * H);
      ctx.stroke();
    }
  }
  let boltAt = 0.5;

  let raf = 0, alive = true;
  const loop = (now) => { if (!alive) return; frame(now); raf = requestAnimationFrame(loop); };
  if (reduced) frame(0); else raf = requestAnimationFrame(loop);
  const onVis = () => { if (document.hidden) cancelAnimationFrame(raf); else if (!reduced && alive) raf = requestAnimationFrame(loop); };
  document.addEventListener('visibilitychange', onVis);
  const ro = new ResizeObserver(() => { resize(); if (reduced) frame(0); });
  ro.observe(host);
  running = {
    stop() { alive = false; cancelAnimationFrame(raf); ro.disconnect(); document.removeEventListener('visibilitychange', onVis); canvas.remove(); },
  };
  return running;
}

function sun(ctx, cx, cy, r, t) {
  const g = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 2.6 * (1 + 0.06 * Math.sin(t * 1.5)));
  g.addColorStop(0, 'rgba(255,220,120,0.55)'); g.addColorStop(1, 'rgba(255,220,120,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 2.8, 0, Math.PI * 2); ctx.fill();
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(t * 0.25);
  ctx.strokeStyle = 'rgba(255,205,70,0.85)'; ctx.lineWidth = r * 0.14; ctx.lineCap = 'round';
  for (let i = 0; i < 12; i++) {
    ctx.rotate(Math.PI / 6);
    ctx.beginPath(); ctx.moveTo(r * 1.3, 0); ctx.lineTo(r * (i % 2 ? 1.6 : 1.85), 0); ctx.stroke();
  }
  ctx.restore();
  const b = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 1, cx, cy, r * 1.2);
  b.addColorStop(0, '#fff2a0'); b.addColorStop(1, '#ffa516');
  ctx.fillStyle = b; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
}

function moon(ctx, cx, cy, r) {
  ctx.fillStyle = 'rgba(255,245,210,0.12)';
  ctx.beginPath(); ctx.arc(cx, cy, r * 1.9, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#f8efc8'; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.arc(cx + r * 0.55, cy - r * 0.35, r * 0.85, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function cloud(ctx, x, y, s, [r, g, b], alpha) {
  ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
  ctx.beginPath();
  ctx.arc(x - s * 0.55, y + s * 0.1, s * 0.42, 0, Math.PI * 2);
  ctx.arc(x, y - s * 0.15, s * 0.6, 0, Math.PI * 2);
  ctx.arc(x + s * 0.6, y + s * 0.05, s * 0.45, 0, Math.PI * 2);
  ctx.fill();
  roundRect(ctx, x - s * 0.95, y + s * 0.05, s * 1.95, s * 0.45, s * 0.22); ctx.fill();
}

function bolt(ctx, x, y, h) {
  const k = h / 100;
  ctx.fillStyle = '#ffe14a';
  ctx.beginPath();
  ctx.moveTo(x + 8 * k, y); ctx.lineTo(x - 6 * k, y + 40 * k); ctx.lineTo(x + 4 * k, y + 40 * k);
  ctx.lineTo(x - 4 * k, y + 100 * k); ctx.lineTo(x + 18 * k, y + 30 * k); ctx.lineTo(x + 8 * k, y + 30 * k);
  ctx.lineTo(x + 16 * k, y); ctx.closePath(); ctx.fill();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// Petit générateur pseudo-aléatoire reproductible.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
