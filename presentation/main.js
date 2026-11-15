/* Project Red Horizon – reveal.js deck with rocket-launch transitions */
(function () {
  document.querySelectorAll('.chart .bar').forEach((b, i) => b.style.setProperty('--i', i));
  // ---------- full-screen smoke overlay (slide 1 -> slide 2) ----------
  const fog = { c: document.getElementById('smoke'), parts: [], cover: 0, emitting: false, fading: false, raf: 0 };
  fog.ctx = fog.c.getContext('2d');
  function fogResize() { fog.c.width = innerWidth; fog.c.height = innerHeight; }
  addEventListener('resize', fogResize); fogResize();
  function fogTick() {
    const { ctx, c } = fog, w = c.width, h = c.height, now = performance.now();
    const dt = Math.min(.1, (now - (fog.last || now)) / 1000); fog.last = now;
    if (fog.emitting) {
      fog.cover = Math.min(.97, fog.cover + dt * .55); // fully covered in ~1.8s
      for (let i = 0; i < 5; i++) fog.parts.push({
        x: Math.random() * w, y: h + 100 - Math.random() * (h + 200) * Math.min(1, fog.cover * 1.4),
        vx: (Math.random() - .5) * 1.5, vy: -1 - Math.random() * 2,
        r: (.12 + Math.random() * .2) * Math.max(w, h), life: 1, decay: .004 + Math.random() * .004 });
    }
    if (fog.fading) fog.cover = Math.max(0, fog.cover - dt * 1.4); // clears in ~1.2s
    ctx.clearRect(0, 0, w, h);
    // dense smoke rises from the ground: bottom is covered first, then the whole page
    const top = h * (1 - Math.min(1, fog.cover * 1.25));
    const bg = ctx.createLinearGradient(0, top - h * .25, 0, top + h * .15);
    bg.addColorStop(0, 'rgba(232,224,214,0)'); bg.addColorStop(1, `rgba(232,224,214,${fog.cover})`);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    for (let i = fog.parts.length - 1; i >= 0; i--) {
      const p = fog.parts[i];
      p.x += p.vx; p.y += p.vy; p.r *= 1.003; p.life -= fog.fading ? Math.max(p.decay * 6, .02) : p.decay;
      if (p.life <= 0) { fog.parts.splice(i, 1); continue; }
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      const a = .45 * Math.sin(Math.PI * p.life);
      g.addColorStop(0, `rgba(250,246,240,${a})`); g.addColorStop(.6, `rgba(215,205,195,${a * .5})`); g.addColorStop(1, 'rgba(215,205,195,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
    }
    if (fog.fading && fog.cover <= 0 && !fog.parts.length) { fog.fading = false; fog.raf = 0; return ctx.clearRect(0, 0, w, h); }
    fog.raf = requestAnimationFrame(fogTick);
  }
  function fogStart() { fog.last = 0; fog.emitting = true; fog.fading = false; if (!fog.raf) fogTick(); }
  function fogClear() { if (fog.raf) { fog.emitting = false; fog.fading = true; } }

  // ---------- smoke engine (canvas lives inside the slide, behind the rocket) ----------
  const W = 1920, H = 1080;
  const smoke = { canvas: null, ctx: null, parts: [], emitting: false, launcher: null, raf: 0, fading: false, alpha: 1 };

  function ensureCanvas(section, launcher) {
    let c = section.querySelector('canvas.smoke');
    if (!c) {
      c = document.createElement('canvas');
      c.className = 'smoke'; c.width = W; c.height = H;
      Object.assign(c.style, { position: 'absolute', left: 0, top: 0, width: W + 'px', height: H + 'px', pointerEvents: 'none' });
      section.insertBefore(c, launcher); // DOM order => drawn behind the rocket
    }
    return c;
  }

  // nozzle position of the launcher in slide coordinates (follows the CSS animation)
  function nozzle(el) {
    const sec = el.closest('section').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const s = sec.width / W;
    const fly = el.classList.contains('fly');
    return fly
      ? { x: (r.left - sec.left + r.width * 0.12) / s, y: (r.top - sec.top + r.height * 0.32) / s, fly }
      : { x: (r.left - sec.left + r.width / 2) / s, y: (r.bottom - sec.top - r.height * 0.12) / s, fly };
  }

  function spawn(x, y, opts) {
    smoke.parts.push({
      x: x + (Math.random() - .5) * opts.spread, y,
      vx: (Math.random() - .5) * opts.vx + (opts.dx || 0), vy: opts.vy + Math.random() * opts.vy * .6,
      r: opts.r * (0.6 + Math.random() * .7), grow: opts.grow, life: 1,
      decay: opts.decay * (0.7 + Math.random() * .6), hot: opts.hot
    });
  }

  function tick() {
    const { ctx } = smoke;
    if (smoke.emitting && smoke.launcher) {
      const n = nozzle(smoke.launcher);
      const airborne = n.y > -200 && n.x < W + 200;
      if (airborne) {
        for (let i = 0; i < 6; i++) spawn(n.x, n.y, n.fly
          ? { spread: 20, vx: 2, dx: -4, vy: 3, r: 26, grow: 1.4, decay: .006, hot: true }
          : { spread: 30, vx: 2.5, vy: 4, r: 30, grow: 1.5, decay: .005, hot: true });
      }
      // billowing cloud that lingers at the launch pad until the slide changes
      const pad = smoke.pad;
      for (let i = 0; i < 3; i++) spawn(pad.x, pad.y, { spread: 260, vx: 3, vy: -0.6, r: 60, grow: 0.7, decay: .0035, hot: false });
    }
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = smoke.alpha;
    for (let i = smoke.parts.length - 1; i >= 0; i--) {
      const p = smoke.parts[i];
      p.x += p.vx; p.y += p.vy; p.vx *= .985; p.vy *= .97; p.r += p.grow; p.life -= p.decay;
      if (p.life <= 0) { smoke.parts.splice(i, 1); continue; }
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      const heat = p.hot ? Math.max(0, p.life - .82) * 5 : 0; // fresh exhaust glows orange
      const c = heat > 0 ? `255,${Math.round(180 + 60 * (1 - heat))},${Math.round(120 * (1 - heat))}` : '235,228,220';
      g.addColorStop(0, `rgba(${c},${.55 * p.life})`);
      g.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    if (smoke.fading) {
      smoke.alpha -= .04;
      if (smoke.alpha <= 0) return stopSmoke();
    }
    smoke.raf = requestAnimationFrame(tick);
  }

  function stopSmoke() {
    cancelAnimationFrame(smoke.raf);
    if (smoke.ctx) smoke.ctx.clearRect(0, 0, W, H);
    Object.assign(smoke, { parts: [], emitting: false, launcher: null, fading: false, alpha: 1, raf: 0 });
  }

  // ---------- launch logic ----------
  // 1st "next" on a slide with a .launcher: rocket blasts off the top, smoke keeps billowing.
  // 2nd "next": go to the next slide (smoke fades away).
  function launchIfNeeded() {
    const slide = Reveal.getCurrentSlide();
    const l = slide && slide.querySelector('.launcher:not(.launching)');
    if (!l || Reveal.availableFragments().next) return false;
    stopSmoke();
    const c = ensureCanvas(slide, l);
    smoke.canvas = c; smoke.ctx = c.getContext('2d');
    const n = nozzle(l);
    smoke.pad = { x: n.x, y: n.y + 30 };
    smoke.launcher = l; smoke.emitting = true;
    l.classList.add('launching');
    if (slide.hasAttribute('data-smoke-fill')) setTimeout(() => { if (l.classList.contains('launching')) fogStart(); }, 900);
    l.addEventListener('animationend', () => l.classList.add('gone'), { once: true });
    tick();
    return true;
  }

  function next() { if (!launchIfNeeded()) Reveal.next(); }

  Reveal.on('slidechanged', e => {
    // tracks -> sample: push the camera forward into the previous scene while the next one fades in
    document.querySelectorAll('.slide-background.zoom-into').forEach(b => b.classList.remove('zoom-into'));
    if (e.currentSlide.hasAttribute('data-zoom-from-prev') && e.previousSlide && e.indexh > Reveal.getIndices(e.previousSlide).h) {
      const bg = Reveal.getSlideBackground(e.previousSlide);
      if (bg) bg.classList.add('zoom-into');
      const cur = Reveal.getSlideBackground(e.currentSlide);
      if (cur) { cur.classList.remove('zoom-arrive'); void cur.offsetWidth; cur.classList.add('zoom-arrive'); }
    }
    setTimeout(fogClear, 500); // new slide is revealed as the smoke clears
    if (smoke.raf) { smoke.emitting = false; smoke.fading = true; }
    // reset launchers on the slide we left so it can be replayed
    if (e.previousSlide) e.previousSlide.querySelectorAll('.launcher').forEach(l => l.classList.remove('launching', 'gone'));
    // count-up numbers
    e.currentSlide.querySelectorAll('.count').forEach(el => {
      const to = parseFloat(el.dataset.to), t0 = performance.now();
      (function step(t) {
        const k = Math.min(1, (t - t0) / 1600), v = to * (1 - Math.pow(1 - k, 3));
        el.textContent = v.toFixed(1);
        if (k < 1) requestAnimationFrame(step);
      })(t0);
    });
  });
  Reveal.on('ready', () => document.querySelectorAll('.launcher').forEach(l => l.classList.add('idle')));

  Reveal.initialize({
    width: W, height: H, margin: 0, minScale: .1, maxScale: 3,
    center: false, hash: true, controls: true, progress: true,
    transition: 'convex', transitionSpeed: 'slow', backgroundTransition: 'zoom',
    keyboard: { 39: next, 32: next, 34: next, 78: next, 40: next }
  });

  // intercept the on-screen "next" arrows and touch swipes too
  document.addEventListener('click', ev => {
    if (ev.target.closest('.navigate-right, .navigate-down')) {
      if (launchIfNeeded()) { ev.stopImmediatePropagation(); ev.preventDefault(); }
    }
  }, true);
})();
