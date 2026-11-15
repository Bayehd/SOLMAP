/* Project Red Horizon – reveal.js deck with rocket-launch transitions */
(function () {
  document.querySelectorAll('.chart .bar').forEach((b, i) => b.style.setProperty('--i', i));
  document.getElementById('smoke').remove(); // a canvas is created per launching slide instead

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
    l.addEventListener('animationend', () => l.classList.add('gone'), { once: true });
    tick();
    return true;
  }

  function next() { if (!launchIfNeeded()) Reveal.next(); }

  Reveal.on('slidechanged', e => {
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
