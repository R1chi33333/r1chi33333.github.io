(function () {
  "use strict";
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Duck moves. Buttons toggle on click or tap (always allowed, even with reduced motion);
     decorative ducks elsewhere play on hover unless reduced motion is set. */
  document.querySelectorAll("[data-anim]").forEach(function (img) {
    var still = img.getAttribute("src"), anim = img.getAttribute("data-anim");
    var btn = img.closest("button");
    if (btn) {
      btn.addEventListener("click", function () {
        var play = btn.getAttribute("aria-pressed") !== "true";
        img.src = play ? anim : still;
        btn.setAttribute("aria-pressed", String(play));
      });
    } else if (!reduced) {
      img.addEventListener("mouseenter", function () { img.src = anim; });
      img.addEventListener("mouseleave", function () { img.src = still; });
    }
  });

  /* Hero gameplay loop: paused for people who prefer less motion, with a pause button for everyone. */
  var hero = document.querySelector(".splash-video video"), toggle = document.querySelector(".video-toggle");
  if (hero && toggle) {
    var set = function (paused) { toggle.textContent = paused ? "Play" : "Pause"; toggle.setAttribute("aria-pressed", String(paused)); };
    if (reduced) { hero.removeAttribute("autoplay"); hero.pause(); set(true); }
    toggle.addEventListener("click", function () {
      if (hero.paused) { hero.play().catch(function () {}); set(false); } else { hero.pause(); set(true); }
    });
  }

  /* Video lightbox for cards with gameplay video. */
  var lb = document.getElementById("lightbox");
  if (!lb || typeof lb.showModal !== "function") return;
  var video = lb.querySelector("video"), cap = lb.querySelector(".cap");
  document.querySelectorAll("[data-video]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      video.src = btn.dataset.video; cap.textContent = btn.dataset.title || "";
      lb.showModal();
      video.play().catch(function () {});
    });
  });
  lb.addEventListener("close", function () { video.pause(); video.removeAttribute("src"); video.load(); });
  lb.addEventListener("click", function (e) { if (e.target === lb) lb.close(); });
})();
