// inventory.js — sandbox item bar: drag an item into the room (ghost preview on the floor or a furniture top),
// or tap an item then tap the floor (phones). A trash slot, right-click and long-press remove things.
import * as THREE from "three";

export function createInventory(o) {
  const { bar, scene, items } = o;
  const st = { selected: null, drag: null, ghost: null, ghostKey: null, trash: false };
  const ghosts = new Map();
  const okCol = new THREE.Color("#30D158"), badCol = new THREE.Color("#FF453A");

  // ---- slots
  bar.innerHTML = "";
  const slots = new Map();
  for (const it of items) {
    const b = document.createElement("button");
    b.className = "slot" + (it.key === "trash" ? " trash" : "");
    b.dataset.key = it.key; b.setAttribute("aria-label", it.label); b.title = it.label;
    b.innerHTML = `<span class="ico">${it.icon}</span><span class="nm">${it.label}</span><span class="cnt"></span>`;
    bar.appendChild(b); slots.set(it.key, b);
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (it.key === "trash") { setTrash(!st.trash); return; }
      if (!it.can()) { o.onFull && o.onFull(it); return; }
      st.drag = { key: it.key, x0: e.clientX, y0: e.clientY, id: e.pointerId, moved: false, el: null };
      b.setPointerCapture(e.pointerId);
    });
    b.addEventListener("pointermove", (e) => {
      const d = st.drag; if (!d || d.id !== e.pointerId) return;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 8) {
        d.moved = true; select(null);
        d.el = document.createElement("div"); d.el.className = "drag-ico"; d.el.innerHTML = it.icon; document.body.appendChild(d.el);
      }
      if (d.moved) { d.el.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; preview(d.key, e.clientX, e.clientY); }
    });
    const end = (e) => {
      const d = st.drag; if (!d || d.id !== e.pointerId) return;
      st.drag = null; if (d.el) d.el.remove();
      if (!d.moved) { select(st.selected === it.key ? null : it.key); return; }
      const over = document.elementFromPoint(e.clientX, e.clientY);
      const hit = (over && over.closest && over.closest("#bar")) ? null : o.pick(e.clientX, e.clientY, d.key);
      hideGhost();
      if (e.type === "pointerup" && hit && hit.ok) o.onPlace(d.key, hit);
      refresh();
    };
    b.addEventListener("pointerup", end); b.addEventListener("pointercancel", end);
  }

  function select(key) {
    st.selected = key; if (key) setTrash(false);
    for (const [k, b] of slots) b.setAttribute("aria-pressed", String(k === key || (k === "trash" && st.trash)));
    o.onSelect && o.onSelect(key);
    if (!key) hideGhost();
  }
  function setTrash(on) {
    st.trash = on; if (on) { st.selected = null; hideGhost(); }
    for (const [k, b] of slots) b.setAttribute("aria-pressed", String(k === "trash" ? on : k === st.selected));
    o.onTrash && o.onTrash(on);
  }

  // ---- ghost preview
  function ghostFor(key) {
    if (ghosts.has(key)) return ghosts.get(key);
    const g = new THREE.Group(); g.name = "ghost_" + key;
    const src = o.ghostObject(key);
    if (src) {
      src.traverse(m => {
        if (!m.isMesh) return;
        const mm = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.45, depthWrite: false });
        m.material = mm; m.castShadow = false; m.receiveShadow = false;
      });
      g.add(src);
    }
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.036, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: okCol, transparent: true, opacity: 0.9, depthWrite: false }));
    ring.position.y = 0.0015; g.add(ring); g.userData.ring = ring;
    g.traverse(m => { m.userData.lookFX = true; m.userData.lookNoContact = true; m.raycast = () => {}; });
    g.visible = false; scene.add(g); ghosts.set(key, g);
    return g;
  }
  function preview(key, x, y) {
    const hit = o.pick(x, y, key);
    const g = ghostFor(key);
    if (st.ghost && st.ghost !== g) st.ghost.visible = false;
    st.ghost = g;
    if (!hit) { g.visible = false; return null; }
    g.visible = true; g.position.copy(hit.point);
    if (hit.yaw != null) g.rotation.y = hit.yaw;
    g.userData.ring.material.color.copy(hit.ok ? okCol : badCol);
    g.children.forEach(c => { if (c !== g.userData.ring) c.traverse(m => { if (m.material) m.material.color.copy(hit.ok ? new THREE.Color("#ffffff") : badCol); }); });
    return hit;
  }
  function hideGhost() { if (st.ghost) st.ghost.visible = false; }

  function refresh() {
    for (const it of items) {
      const b = slots.get(it.key); const c = b.querySelector(".cnt");
      if (it.key === "trash") { c.textContent = ""; continue; }
      const n = it.count(), cap = it.cap();
      c.textContent = cap ? `${n}/${cap}` : "";
      b.classList.toggle("full", !it.can());
    }
  }
  refresh();

  return {
    get selected() { return st.selected; }, get trash() { return st.trash; },
    select, setTrash, refresh, preview, hideGhost,
    /** canvas hover with an item selected (desktop) */
    hover(x, y) { if (st.selected) preview(st.selected, x, y); },
    /** canvas tap: place the selected item, or delete in trash mode. returns true if it consumed the tap */
    tap(x, y) {
      if (st.trash) { const obj = o.pickObject(x, y); if (obj) { o.onDelete(obj); refresh(); } return true; }
      if (!st.selected) return false;
      const it = items.find(i => i.key === st.selected);
      const hit = o.pick(x, y, st.selected);
      if (hit && hit.ok && it.can()) { o.onPlace(st.selected, hit); refresh(); if (!it.can()) select(null); }
      return true;
    },
    // test hook: simulate a drag from the bar to a screen point (keeps the ghost visible when hold=true)
    dragTo(key, x, y, hold) {
      const it = items.find(i => i.key === key); if (!it) return null;
      const hit = preview(key, x, y);
      if (!hold) { hideGhost(); if (hit && hit.ok && it.can()) o.onPlace(key, hit); refresh(); }
      return hit;
    },
  };
}
