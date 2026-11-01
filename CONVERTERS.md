# In-browser media converters

Static site of single-purpose converters powered by ffmpeg.wasm (single-thread core, no SharedArrayBuffer, no COOP/COEP headers). Files never leave the visitor's device.

## Layout

| Path | What it is |
|---|---|
| `tools.json` | Site settings + the list of tools (config, page text). Add a tool here. `output.preview` is `image`, `video` or `audio`. |
| `build.js` | Generator: `node build.js` writes everything to `dist/`. |
| `js/converter.js` | The shared engine + UI. Lazily loads FFmpeg on Convert. |
| `css/style.css` | Shared styles. |
| `pages/*.html` | Home, About, Privacy, Contact, Credits page bodies. |
| `vendor/` | Self-hosted `@ffmpeg/ffmpeg` (MIT) and `@ffmpeg/core` single-thread (GPL-2.0+) + licenses. |
| `scripts/vendor.js` | Refreshes `vendor/` from `node_modules` (`npm install && npm run vendor`). |
| `scripts/serve.js` | Local static server: `npm run serve` → http://localhost:8080/ |

## Build

```bash
node build.js
```

Before deploying, set `site.url`, `site.basePath` and `site.contactEmail` in `tools.json` (they currently hold placeholders). Deploy the contents of `dist/`.

## Adding a tool

Add an entry to `tools` in `tools.json` (slug, navLabel, title, description, h1, lede, converter, content) and rebuild. Every page's navigation, the home page list and `sitemap.xml` update automatically.

`converter.passes` is a list of ffmpeg argument arrays. Placeholders: `{input}`, `{output}`, `{trim}` (expands to `-ss`/`-t` or nothing), `{<settingId>}`, and any key from the chosen option's `vars`.

## Ads

Each converter page has two empty `.ad-slot` divs (above and below the tool) with an HTML comment marking where the AdSense `<ins>` snippet goes; the loader script goes in `<head>` (also marked).
