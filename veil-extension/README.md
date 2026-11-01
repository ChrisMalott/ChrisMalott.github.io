# Veil

A browser extension that completely covers the page with a slowly shifting color
gradient and a digital clock whenever your mouse leaves the browser window. Move the
mouse back over the window and the page fades back in.

## Install (Chrome / Edge / Brave)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `veil-extension` folder.
4. Reload any tabs that were already open.

## Install (Firefox)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json` in this folder.

## Use

- Mouse out of the window → page is hidden behind the gradient + clock.
- Mouse back in → page returns.
- Click the toolbar icon to turn it on or off.

Browser-internal pages (`chrome://…`, the Web Store, new-tab page) don't allow
extensions to run, so they won't be covered.
