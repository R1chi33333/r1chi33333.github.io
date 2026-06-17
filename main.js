// ─── Nav ────────────────────────────────────────────────────────────────────
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 40);
});

const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav-links a');
const navObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      navLinks.forEach(link => {
        link.classList.toggle('active', link.getAttribute('href') === '#' + entry.target.id);
      });
    }
  });
}, { rootMargin: '-40% 0px -55% 0px' });
sections.forEach(s => navObserver.observe(s));

// ─── Reduced motion check ────────────────────────────────────────────────────
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ─── 1. Particle System ──────────────────────────────────────────────────────
(function initParticles() {
  if (prefersReduced) return;
  const canvas = document.getElementById('particle-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const hero = canvas.parentElement;
  const COUNT = 80;
  const MAX_DIST = 150;
  const COLOR = '#00ff41';
  const MOUSE_R = 120;
  const MOUSE_FORCE = 0.08;
  const SPEED_CAP = 2.5;
  let particles = [];
  let animId;
  let mouse = { x: -9999, y: -9999 };

  hero.addEventListener('mousemove', e => {
    const r = canvas.getBoundingClientRect();
    mouse.x = e.clientX - r.left;
    mouse.y = e.clientY - r.top;
  });
  hero.addEventListener('mouseleave', () => { mouse.x = -9999; mouse.y = -9999; });

  function resize() {
    canvas.width = hero.offsetWidth;
    canvas.height = hero.offsetHeight;
  }

  function makeParticle() {
    return {
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.5,
      vy: (Math.random() - 0.5) * 0.5,
      r: Math.random() * 1.5 + 0.5,
    };
  }

  function init() {
    resize();
    particles = Array.from({ length: COUNT }, makeParticle);
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
      if (p.y < 0 || p.y > canvas.height) p.vy *= -1;

      // Mouse repulsion
      const pdx = p.x - mouse.x, pdy = p.y - mouse.y;
      const pdist = Math.sqrt(pdx * pdx + pdy * pdy);
      if (pdist < MOUSE_R && pdist > 0) {
        const f = (1 - pdist / MOUSE_R) * MOUSE_FORCE;
        p.vx += (pdx / pdist) * f;
        p.vy += (pdy / pdist) * f;
        const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        if (spd > SPEED_CAP) { p.vx = p.vx / spd * SPEED_CAP; p.vy = p.vy / spd * SPEED_CAP; }
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = COLOR;
      ctx.globalAlpha = 0.7;
      ctx.fill();

      for (let j = i + 1; j < particles.length; j++) {
        const q = particles[j];
        const dx = p.x - q.x, dy = p.y - q.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MAX_DIST) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.globalAlpha = (1 - dist / MAX_DIST) * 0.3;
          ctx.strokeStyle = COLOR;
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }
      }
    }

    // Mouse node connections
    if (mouse.x > -1000) {
      for (const p of particles) {
        const mdx = p.x - mouse.x, mdy = p.y - mouse.y;
        const mdist = Math.sqrt(mdx * mdx + mdy * mdy);
        if (mdist < MAX_DIST) {
          ctx.beginPath();
          ctx.moveTo(mouse.x, mouse.y);
          ctx.lineTo(p.x, p.y);
          ctx.globalAlpha = (1 - mdist / MAX_DIST) * 0.55;
          ctx.strokeStyle = COLOR;
          ctx.lineWidth = 0.9;
          ctx.stroke();
        }
      }
    }

    ctx.globalAlpha = 1;
    animId = requestAnimationFrame(draw);
  }

  init();
  draw();

  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(animId);
    init();
    draw();
  });
  ro.observe(hero);
})();

// ─── 2. Typing Animation ─────────────────────────────────────────────────────
async function runTypingSequence() {
  const prompt = document.getElementById('hero-prompt');
  const cmd    = document.getElementById('hero-cmd');
  const name   = document.getElementById('hero-name');
  const role   = document.getElementById('hero-role');
  const divider = document.getElementById('hero-divider');
  const sub1   = document.getElementById('hero-sub1');
  const sub2   = document.getElementById('hero-sub2');
  const cta    = document.getElementById('hero-cta');

  function fadeIn(el, delay = 0) {
    return new Promise(resolve => {
      setTimeout(() => {
        el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
        setTimeout(resolve, 500);
      }, delay);
    });
  }

  if (prefersReduced) {
    [prompt, cmd, name, role, divider, sub1, sub2, cta].forEach(el => {
      if (el) { el.style.opacity = '1'; el.style.visibility = 'visible'; }
    });
    startGlitch();
    return;
  }

  try {
    await new Promise(r => setTimeout(r, 300));
    prompt.style.visibility = 'visible';

    const text = ' whoami';
    for (const char of text) {
      cmd.textContent += char;
      await new Promise(r => setTimeout(r, 80));
    }

    await new Promise(r => setTimeout(r, 300));

    await fadeIn(name);
    await fadeIn(role, 50);
    await fadeIn(divider, 50);
    await fadeIn(sub1, 50);
    await fadeIn(sub2, 50);
    await fadeIn(cta, 80);

    startGlitch();
  } catch (e) {
    [prompt, cmd, name, role, divider, sub1, sub2, cta].forEach(el => {
      if (el) { el.style.opacity = '1'; el.style.visibility = 'visible'; }
    });
    startGlitch();
  }
}

runTypingSequence();

// ─── 3. Scroll Reveal ────────────────────────────────────────────────────────
(function initReveal() {
  const els = document.querySelectorAll('[data-reveal]');
  if (prefersReduced) {
    els.forEach(el => el.classList.add('revealed'));
    return;
  }
  const revealObs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        revealObs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });
  els.forEach(el => revealObs.observe(el));
})();

// ─── 4. Counter Animation ────────────────────────────────────────────────────
(function initCounters() {
  const nums = document.querySelectorAll('.stat-num[data-target]');
  if (!nums.length) return;

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function animateCounter(el) {
    if (el.dataset.counted) return;
    el.dataset.counted = '1';
    const target = parseFloat(el.dataset.target);
    const suffix = el.dataset.suffix || '';
    const duration = 1500;
    const start = performance.now();

    function tick(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const value = Math.round(easeOut(progress) * target);
      el.textContent = value + suffix;
      if (progress < 1) requestAnimationFrame(tick);
    }

    if (prefersReduced) {
      el.textContent = target + suffix;
    } else {
      requestAnimationFrame(tick);
    }
  }

  const counterObs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.querySelectorAll('.stat-num[data-target]').forEach(animateCounter);
      }
    });
  }, { threshold: 0.3 });

  const aboutSection = document.getElementById('about');
  if (aboutSection) counterObs.observe(aboutSection);
})();

// ─── 5. Glitch Effect ────────────────────────────────────────────────────────
function startGlitch() {
  if (prefersReduced) return;
  const el = document.getElementById('hero-name');
  if (!el) return;

  function trigger() {
    el.classList.add('is-glitching');
    setTimeout(() => el.classList.remove('is-glitching'), 200);
    setTimeout(trigger, 4000 + Math.random() * 4000);
  }

  setTimeout(trigger, 4000 + Math.random() * 4000);
}

// ─── 6. 3D Card Tilt ────────────────────────────────────────────────────────
(function initTilt() {
  if (prefersReduced) return;
  if (window.matchMedia('(hover: none)').matches) return;

  const cards = document.querySelectorAll('.project-card');
  const MAX_DEG = 5;

  cards.forEach(card => {
    card.addEventListener('mousemove', e => {
      const rect = card.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = (e.clientX - cx) / (rect.width / 2);
      const dy = (e.clientY - cy) / (rect.height / 2);
      card.style.transform = `perspective(800px) rotateY(${dx * MAX_DEG}deg) rotateX(${-dy * MAX_DEG}deg) scale(1.02)`;
      card.style.transition = 'transform 0.1s ease';
    });

    card.addEventListener('mouseleave', () => {
      card.style.transition = 'transform 0.4s ease';
      card.style.transform = 'perspective(800px) rotateY(0deg) rotateX(0deg) scale(1)';
    });
  });
})();

// ─── 7. Liquid Glass Shimmer ─────────────────────────────────────────────────
(function initGlassShimmer() {
  if (prefersReduced) return;
  document.querySelectorAll('.btn-primary, .btn-secondary').forEach(btn => {
    btn.addEventListener('mousemove', e => {
      const r = btn.getBoundingClientRect();
      btn.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
      btn.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
    });
  });
})();

// ─── 8. Custom Cursor ────────────────────────────────────────────────────────
(function initCursor() {
  if (prefersReduced) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  const dot = document.getElementById('cursor-dot');
  const ring = document.getElementById('cursor-ring');
  if (!dot || !ring) return;

  let mx = -100, my = -100, rx = -100, ry = -100;

  document.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; });

  function tick() {
    dot.style.left = mx + 'px';
    dot.style.top = my + 'px';
    rx += (mx - rx) * 0.12;
    ry += (my - ry) * 0.12;
    ring.style.left = rx + 'px';
    ring.style.top = ry + 'px';
    requestAnimationFrame(tick);
  }
  tick();

  document.querySelectorAll('a, button, .project-card').forEach(el => {
    el.addEventListener('mouseenter', () => document.body.classList.add('cursor-hovering'));
    el.addEventListener('mouseleave', () => document.body.classList.remove('cursor-hovering'));
  });
})();

// ─── 9. Cursor Spotlight ─────────────────────────────────────────────────────
(function initSpotlight() {
  if (prefersReduced) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  const el = document.createElement('div');
  el.id = 'cursor-spotlight';
  document.body.appendChild(el);

  document.addEventListener('mousemove', e => {
    el.style.background =
      `radial-gradient(circle 420px at ${e.clientX}px ${e.clientY}px, rgba(0,255,65,0.028) 0%, transparent 70%)`;
  });
})();

// ─── 10. Magnetic Buttons ────────────────────────────────────────────────────
(function initMagnetic() {
  if (prefersReduced) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  const RADIUS = 90, STRENGTH = 0.28;

  document.querySelectorAll('[data-magnetic]').forEach(btn => {
    document.addEventListener('mousemove', e => {
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const dx = e.clientX - cx, dy = e.clientY - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < RADIUS) {
        const pull = (1 - dist / RADIUS) * STRENGTH;
        btn.style.transform = `translate(${dx * pull}px, ${dy * pull}px)`;
        btn.style.transition = 'transform 0.1s ease';
      } else {
        btn.style.transform = 'translate(0, 0)';
        btn.style.transition = 'transform 0.5s ease';
      }
    });
  });
})();
