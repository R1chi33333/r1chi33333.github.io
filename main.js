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
