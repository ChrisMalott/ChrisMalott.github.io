(() => {
  if (window.__veilLoaded) return;
  window.__veilLoaded = true;

  const FADE_MS = 400;
  let enabled = true;
  let shown = false;
  let clockTimer = null;

  const host = document.createElement("div");
  host.id = "veil-extension-host";
  const shadow = host.attachShadow({ mode: "closed" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .veil {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
        opacity: 0;
        visibility: hidden;
        transition: opacity ${FADE_MS}ms ease, visibility 0s linear ${FADE_MS}ms;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        background: #111;
      }
      .veil.on {
        opacity: 1;
        visibility: visible;
        transition: opacity ${FADE_MS}ms ease, visibility 0s;
      }
      .gradient {
        position: absolute;
        inset: 0;
        background: linear-gradient(120deg,
          #ff6b6b, #f7b267, #ffd93d, #6bcb77, #4d96ff, #9b5de5, #f15bb5, #ff6b6b);
        background-size: 400% 400%;
        animation: drift 90s ease-in-out infinite, hue 240s linear infinite;
        animation-play-state: paused;
      }
      .veil.on .gradient { animation-play-state: running; }
      @keyframes drift {
        0%   { background-position: 0% 50%; }
        50%  { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
      }
      @keyframes hue {
        from { filter: hue-rotate(0deg) saturate(0.9); }
        to   { filter: hue-rotate(360deg) saturate(0.9); }
      }
      .clock {
        position: relative;
        font-family: "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace;
        font-variant-numeric: tabular-nums;
        font-size: clamp(48px, 14vw, 220px);
        font-weight: 200;
        letter-spacing: 0.04em;
        color: rgba(255, 255, 255, 0.92);
        text-shadow: 0 4px 30px rgba(0, 0, 0, 0.25);
        user-select: none;
        line-height: 1;
      }
      .date {
        display: block;
        margin-top: 0.6em;
        font-size: 0.14em;
        font-weight: 400;
        letter-spacing: 0.25em;
        text-align: center;
        text-transform: uppercase;
        opacity: 0.8;
      }
    </style>
    <div class="veil" aria-hidden="true">
      <div class="gradient"></div>
      <div class="clock"><span class="time"></span><span class="date"></span></div>
    </div>
  `;

  const veil = shadow.querySelector(".veil");
  const timeEl = shadow.querySelector(".time");
  const dateEl = shadow.querySelector(".date");

  const pad = (n) => String(n).padStart(2, "0");
  function tick() {
    const d = new Date();
    timeEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    dateEl.textContent = d.toLocaleDateString(undefined, {
      weekday: "long", month: "long", day: "numeric",
    });
  }

  function show() {
    if (shown || !enabled) return;
    shown = true;
    tick();
    // Align updates to the start of each second.
    clockTimer = setTimeout(function loop() {
      tick();
      clockTimer = setTimeout(loop, 1000 - (Date.now() % 1000));
    }, 1000 - (Date.now() % 1000));
    veil.classList.add("on");
  }

  function hide() {
    if (!shown) return;
    shown = false;
    clearTimeout(clockTimer);
    clockTimer = null;
    veil.classList.remove("on");
  }

  function attach() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  // Mouse leaving the viewport → cover. Mouse coming back → reveal.
  document.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget && !e.toElement) show();
  }, true);
  document.addEventListener("mouseover", hide, true);
  document.addEventListener("mousemove", hide, true);

  // Pages that replace <html> or wipe the DOM: re-attach.
  new MutationObserver(attach).observe(document, { childList: true, subtree: false });
  if (document.documentElement) attach();
  else document.addEventListener("DOMContentLoaded", attach, { once: true });

  chrome.storage.sync.get({ enabled: true }, (s) => { enabled = s.enabled; });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      if (!enabled) hide();
    }
  });
})();
