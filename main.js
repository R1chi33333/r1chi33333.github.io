(function(){
  "use strict";
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse  = window.matchMedia('(pointer: coarse)').matches;
  const root = document.documentElement;

  /* ---------- FOUR FORMS PALETTE ---------- */
  const FORMS = {
    swe: { rgb:[47,107,255],  hex:'#2f6bff', a2:'#7aa0ff' },
    mle: { rgb:[12,166,120],  hex:'#0ca678', a2:'#4fd1a8' },
    aie: { rgb:[124,77,255],  hex:'#7c4dff', a2:'#a78bff' },
    hci: { rgb:[230,73,128],  hex:'#e64980', a2:'#f48fb1' }
  };
  let current = FORMS.aie.rgb.slice();
  let target  = FORMS.aie.rgb.slice();
  function setForm(name){
    const f = FORMS[name] || FORMS.aie;
    target = f.rgb.slice();
    root.style.setProperty('--accent', f.hex);
    root.style.setProperty('--accent-2', f.a2);
  }
  const lerp = (a,b,t)=> a+(b-a)*t;

  /* ===========================================================
     1. AI-AGENT NETWORK BACKGROUND (canvas node-link graph)
        Nodes = agents; edges form within range; mouse + scroll reactive.
        Tuned for a LIGHT background (dark-ish coloured nodes & lines).
     =========================================================== */
  const canvas = document.getElementById('netCanvas');
  const ctx = canvas.getContext('2d');
  let W,H,DPR, nodes=[], mx=-9999, my=-9999, energy=0, pulse=0; // energy=scroll, pulse=transform flash
  const N = coarse ? 32 : 64;
  const LINK = coarse ? 150 : 175;   // connection distance (css px)

  function resize(){
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.width  = innerWidth  * DPR;
    H = canvas.height = innerHeight * DPR;
    canvas.style.width = innerWidth+'px';
    canvas.style.height = innerHeight+'px';
  }
  function build(){
    nodes = [];
    for(let i=0;i<N;i++){
      nodes.push({
        x:Math.random()*innerWidth, y:Math.random()*innerHeight,
        vx:(Math.random()-0.5)*0.28, vy:(Math.random()-0.5)*0.28,
        r:(Math.random()*1.6+1.4),
        soul:false
      });
    }
    // one "soul" node — slightly larger, the constant
    nodes[0].soul = true; nodes[0].r = 4.2;
  }
  resize(); build();

  if(!coarse){
    window.addEventListener('mousemove', e=>{ mx=e.clientX; my=e.clientY; }, {passive:true});
    window.addEventListener('mouseout', ()=>{ mx=-9999; my=-9999; }, {passive:true});
  }
  window.addEventListener('resize', ()=>{ resize(); build(); }, {passive:true});

  function frame(){
    for(let i=0;i<3;i++) current[i] = lerp(current[i], target[i], 0.06);
    const r=Math.round(current[0]), g=Math.round(current[1]), b=Math.round(current[2]);
    root.style.setProperty('--accent-rgb', `${r},${g},${b}`);

    ctx.setTransform(DPR,0,0,DPR,0,0);
    ctx.clearRect(0,0,innerWidth,innerHeight);

    pulse *= 0.94;                       // transform flash decays each frame
    const spread = 1 + energy*0.15 + pulse*0.25; // field breathes on scroll + flares on each form morph
    // update + draw nodes
    for(const n of nodes){
      n.x += n.vx*spread; n.y += n.vy*spread;
      if(n.x< -20) n.x=innerWidth+20; if(n.x>innerWidth+20) n.x=-20;
      if(n.y< -20) n.y=innerHeight+20; if(n.y>innerHeight+20) n.y=-20;
      // gentle mouse attraction
      if(mx>-9000){
        const dx=mx-n.x, dy=my-n.y, d2=dx*dx+dy*dy;
        if(d2 < 200*200){ const f=0.00018; n.vx+=dx*f; n.vy+=dy*f; }
      }
      // damping toward base speed so it never runs away
      n.vx*=0.992; n.vy*=0.992;
    }

    // edges
    for(let i=0;i<nodes.length;i++){
      for(let j=i+1;j<nodes.length;j++){
        const a=nodes[i], c=nodes[j];
        const dx=a.x-c.x, dy=a.y-c.y; const d=Math.hypot(dx,dy);
        if(d<LINK){
          const al=(1-d/LINK)*0.32;
          ctx.strokeStyle=`rgba(${r},${g},${b},${al})`;
          ctx.lineWidth = a.soul||c.soul ? 1.1 : 0.6;
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(c.x,c.y); ctx.stroke();
        }
      }
      // link to cursor
      if(mx>-9000){
        const a=nodes[i]; const d=Math.hypot(a.x-mx,a.y-my);
        if(d<LINK){ const al=(1-d/LINK)*0.4;
          ctx.strokeStyle=`rgba(${r},${g},${b},${al})`; ctx.lineWidth=0.7;
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(mx,my); ctx.stroke();
        }
      }
    }
    // nodes on top
    for(const n of nodes){
      // soft halo (flares with each transform pulse)
      ctx.fillStyle=`rgba(${r},${g},${b},${n.soul?0.18:0.10})`;
      ctx.beginPath(); ctx.arc(n.x,n.y,n.r*3.2*(1+pulse*0.6),0,Math.PI*2); ctx.fill();
      // core dot
      ctx.fillStyle=`rgba(${r},${g},${b},${n.soul?0.95:0.7})`;
      ctx.beginPath(); ctx.arc(n.x,n.y,n.r,0,Math.PI*2); ctx.fill();
    }
    requestAnimationFrame(frame);
  }
  if(!reduced){ requestAnimationFrame(frame); }
  else {
    // static single frame
    ctx.setTransform(DPR,0,0,DPR,0,0);
    const [r,g,b]=current;
    for(const n of nodes){ ctx.fillStyle=`rgba(${r},${g},${b},0.6)`; ctx.beginPath(); ctx.arc(n.x,n.y,n.r,0,Math.PI*2); ctx.fill(); }
  }

  /* ===========================================================
     2. SCROLLTRIGGER — reveals, form morph, counters, nav
     =========================================================== */
  // nav border on scroll
  const nav=document.getElementById('nav');
  window.addEventListener('scroll', ()=>{ nav.classList.toggle('scrolled', window.scrollY>40); }, {passive:true});

  if(typeof gsap!=='undefined' && typeof ScrollTrigger!=='undefined'){
    gsap.registerPlugin(ScrollTrigger);

    gsap.to('#progress', { width:'100%', ease:'none',
      scrollTrigger:{ trigger:document.body, start:'top top', end:'bottom bottom', scrub:0.3 }});

    if(!reduced){
      gsap.utils.toArray('.reveal-line > span').forEach(el=>{
        gsap.to(el, { y:'0%', duration:1.1, ease:'power4.out',
          scrollTrigger:{ trigger:el, start:'top 88%' },
          onComplete:()=>{ if(el.parentElement) el.parentElement.style.overflow='visible'; } // un-clip descenders (g, y, p)
        });
      });
      gsap.utils.toArray('.rise').forEach(el=>{
        gsap.to(el, { opacity:1, y:0, duration:1, ease:'power3.out', scrollTrigger:{ trigger:el, start:'top 92%' }});
      });
      const lit=document.querySelector('[data-light]');
      if(lit){ gsap.fromTo(lit,{opacity:.4},{opacity:1, ease:'none', scrollTrigger:{ trigger:lit, start:'top 82%', end:'bottom 62%', scrub:true }}); }

      // network energy follows scroll progress
      gsap.to({}, { scrollTrigger:{ trigger:document.body, start:'top top', end:'bottom bottom', scrub:0.6,
        onUpdate:self=>{ energy = Math.sin(self.progress*Math.PI); }}});
    } else {
      gsap.set('.reveal-line > span',{ y:'0%' });
      gsap.set('.rise',{ opacity:1, y:0 });
      document.querySelectorAll('.reveal-line').forEach(l=>l.style.overflow='visible');
    }

    // FORM MORPH — palette shifts as each section reaches mid-viewport
    gsap.utils.toArray('section[data-form]').forEach(sec=>{
      ScrollTrigger.create({ trigger:sec, start:'top 55%', end:'bottom 45%',
        onEnter:()=>setForm(sec.dataset.form), onEnterBack:()=>setForm(sec.dataset.form) });
    });

    // number counters
    gsap.utils.toArray('.num[data-count]').forEach(el=>{
      const end=parseFloat(el.dataset.count), dec=parseInt(el.dataset.dec||'0',10), o={v:0};
      gsap.to(o,{ v:end, duration:1.6, ease:'power2.out', scrollTrigger:{ trigger:el, start:'top 88%' },
        onUpdate:()=>{ el.textContent=o.v.toFixed(dec); }});
    });
  } else {
    document.querySelectorAll('.reveal-line').forEach(l=>l.style.overflow='visible');
    document.querySelectorAll('.reveal-line > span').forEach(s=>s.style.transform='none');
    document.querySelectorAll('.rise').forEach(s=>{ s.style.opacity=1; s.style.transform='none'; });
    document.querySelectorAll('.num[data-count]').forEach(el=>{ el.textContent=parseFloat(el.dataset.count).toFixed(parseInt(el.dataset.dec||'0',10)); });
  }

  /* ===========================================================
     3. SIGNATURE TRANSFORM — the headline literally takes many forms.
        "Many Forms." morphs through the four roles; the whole theme +
        agent network shift colour and flare on each morph. Runs only
        while the hero is on-screen.
     =========================================================== */
  const fw = document.getElementById('formword');
  if(fw && !reduced){
    const ROT = [
      { t:'Many Forms.',       k:null  },
      { t:'AI Engineer.',      k:'aie' },
      { t:'ML Engineer.',      k:'mle' },
      { t:'Software Engineer.',k:'swe' },
      { t:'HCI.',              k:'hci' }
    ];
    let ri=0, heroVisible=true;
    function rotStep(){
      ri = (ri+1) % ROT.length;
      const cur = ROT[ri];
      fw.classList.add('swap');                 // blur + lift out
      setTimeout(()=>{
        fw.textContent = cur.t;
        if(cur.k){ fw.classList.add('solid'); fw.style.color = FORMS[cur.k].hex; setForm(cur.k); pulse = 1; }
        else     { fw.classList.remove('solid'); fw.style.color = ''; setForm('aie'); pulse = 0.6; }
        fw.classList.remove('swap');            // settle in
      }, 340);
    }
    const timer = setInterval(()=>{ if(heroVisible) rotStep(); }, 2400);
    const heroEl = document.getElementById('hero');
    if('IntersectionObserver' in window && heroEl){
      new IntersectionObserver(es=>{ es.forEach(e=>{ heroVisible = e.isIntersecting; }); }, {threshold:0.2}).observe(heroEl);
    }
    window.addEventListener('pagehide', ()=>clearInterval(timer));
  }

  /* ===========================================================
     4. VIDEO LIGHTBOX — gameplay clips load only on click
     =========================================================== */
  const lb=document.getElementById('lightbox'), lbv=document.getElementById('lbVideo'), lbc=document.getElementById('lbCap');
  if(lb && lbv){
    const openLB=(src,cap)=>{ lbv.src=src; lbc.textContent=cap||''; lb.classList.add('open'); lb.setAttribute('aria-hidden','false'); document.body.style.overflow='hidden'; lbv.play().catch(()=>{}); };
    const closeLB=()=>{ lb.classList.remove('open'); lb.setAttribute('aria-hidden','true'); lbv.pause(); lbv.removeAttribute('src'); lbv.load(); document.body.style.overflow=''; };
    document.querySelectorAll('.gthumb').forEach(t=>t.addEventListener('click',()=>openLB(t.dataset.video, t.dataset.title)));
    const cl=lb.querySelector('.lb-close'); if(cl) cl.addEventListener('click',closeLB);
    lb.addEventListener('click', e=>{ if(e.target===lb) closeLB(); });
    window.addEventListener('keydown', e=>{ if(e.key==='Escape' && lb.classList.contains('open')) closeLB(); });
  }
})();
