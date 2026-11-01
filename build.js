#!/usr/bin/env node
/*
 * build.js — static site generator.
 *
 *   node build.js
 *
 * Reads tools.json and writes into /dist:
 *   - one page per converter   (dist/<slug>/index.html)
 *   - the home page and the About / Privacy / Contact / Credits pages (from /pages)
 *   - sitemap.xml and robots.txt
 *   - copies of /css, /js and /vendor
 * The navigation panel on every page is generated from tools.json, so adding a
 * tool there and rebuilding updates every page.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.json'), 'utf8'));
const site = data.site;
const tools = data.tools;
const BASE = (site.basePath || '/').replace(/\/?$/, '/');
const SITE_URL = site.url.replace(/\/$/, '');
const versions = readJSON(path.join(ROOT, 'vendor', 'VERSIONS.json')) || {};

/* ---------- helpers ---------- */

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const href = (p) => BASE + p.replace(/^\//, '');      // site-relative link
const absURL = (p) => SITE_URL + href(p);              // absolute URL (canonical, sitemap)
const pagePath = (slug) => (slug ? slug + '/' : '');   // clean URLs: /mp4-to-gif/

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}
function write(rel, content) {
  const file = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/* ---------- validation ---------- */

const seen = new Set();
for (const t of tools) {
  for (const k of ['slug', 'navLabel', 'title', 'description', 'h1', 'converter', 'content']) {
    if (!t[k]) throw new Error(`tools.json: tool "${t.slug || '?'}" is missing "${k}"`);
  }
  if (!/^[a-z0-9-]+$/.test(t.slug)) throw new Error(`tools.json: bad slug "${t.slug}"`);
  if (seen.has(t.slug)) throw new Error(`tools.json: duplicate slug "${t.slug}"`);
  seen.add(t.slug);
  if (t.description.length > 160) console.warn(`warn: ${t.slug} meta description is ${t.description.length} chars (>160)`);
}

/* ---------- shared template pieces ---------- */

function nav(currentSlug) {
  const groups = data.groups || [...new Set(tools.map((t) => t.group || 'Tools'))];
  const sections = groups.map((g) => {
    const items = tools.filter((t) => (t.group || 'Tools') === g);
    if (!items.length) return '';
    const lis = items.map((t) => {
      const cur = t.slug === currentSlug ? ' aria-current="page"' : '';
      return `<li><a href="${href(pagePath(t.slug))}"${cur}>${esc(t.navLabel)}</a></li>`;
    }).join('\n          ');
    return `
      <h2 class="nav-group">${esc(g)}</h2>
      <ul>
          ${lis}
      </ul>`;
  }).join('');
  return `<nav class="tools-nav" id="tools-nav" aria-label="All converters">${sections}
    </nav>`;
}

function adSlot(position) {
  return `
      <!-- AD SLOT (${position}): paste the Google AdSense <ins class="adsbygoogle"> snippet inside this div.
           Put the AdSense loader <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-XXXX"> in <head> once. -->
      <div class="ad-slot ad-slot--${position}" data-ad-slot="${position}" aria-hidden="true">
        <span class="ad-slot__label">Advertisement</span>
      </div>`;
}

function layout({ slug, title, description, body, extraHead = '', scripts = '' }) {
  const canonical = absURL(pagePath(slug));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${canonical}">
  <meta name="theme-color" content="#1f6feb">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231f6feb'/%3E%3Cpath d='M12 9l11 7-11 7z' fill='white'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="${href('css/style.css')}">
  <!-- AdSense loader script goes here later (once per page). -->${extraHead}
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="${href('')}">${esc(site.name)}</a>
    <button class="nav-toggle" type="button" aria-controls="tools-nav" aria-expanded="false">All tools</button>
  </header>
  <div class="layout">
    ${nav(slug)}
    <main id="main" class="content">${body}
    </main>
  </div>
  <footer class="site-footer">
    <nav aria-label="Site">
      <a href="${href('about/')}">About</a>
      <a href="${href('privacy/')}">Privacy Policy</a>
      <a href="${href('contact/')}">Contact</a>
      <a href="${href('credits/')}">Open-source credits</a>
    </nav>
    <p>Files are converted on your device and never uploaded. Powered by <a href="${href('credits/')}">FFmpeg</a>.</p>
  </footer>
  <script>
    (function () {
      var b = document.querySelector('.nav-toggle'), n = document.getElementById('tools-nav');
      document.documentElement.classList.add('js');
      b.addEventListener('click', function () {
        var open = n.classList.toggle('is-open');
        b.setAttribute('aria-expanded', open);
      });
    })();
  </script>${scripts}
</body>
</html>
`;
}

/* ---------- converter page ---------- */

function converterSection(tool) {
  const c = tool.converter;
  const accept = [...c.input.extensions.map((e) => '.' + e), ...(c.input.mimeTypes || [])].join(',');
  const clientCfg = {
    input: c.input,
    output: c.output,
    trim: !!c.trim,
    settings: (c.settings || []).map((s) => ({
      id: s.id,
      default: s.default,
      options: s.options.map((o) => ({ value: o.value, vars: o.vars })),
    })),
    passes: c.passes,
    passWeights: c.passWeights || (c.passes.length === 2 ? [0.3, 0.7] : undefined),
    maxFileMB: site.maxFileMB || 300,
  };
  // JSON inside <script>: escape "<" so "</script>" can never break out.
  const cfgJSON = JSON.stringify(clientCfg).replace(/</g, '\\u003c');

  const selects = (c.settings || []).map((s) => `
          <label class="field">
            <span>${esc(s.label)}</span>
            <select data-setting="${esc(s.id)}" name="${esc(s.id)}">
              ${s.options.map((o) => `<option value="${esc(o.value)}"${o.value === s.default ? ' selected' : ''}>${esc(o.label || o.value)}</option>`).join('\n              ')}
            </select>
          </label>`).join('');

  const trim = c.trim ? `
          <label class="field">
            <span>Start time</span>
            <input id="cv-start" name="start" type="text" inputmode="decimal" placeholder="0:00" autocomplete="off">
          </label>
          <label class="field">
            <span>End time</span>
            <input id="cv-end" name="end" type="text" inputmode="decimal" placeholder="end of video" autocomplete="off">
          </label>` : '';

  return `
      <section class="converter" id="converter" data-state="idle" aria-label="${esc(tool.navLabel)} converter">
        <script type="application/json" id="converter-config">${cfgJSON}</script>
        <label class="dropzone" id="cv-drop">
          <input class="visually-hidden" id="cv-file" type="file" accept="${esc(accept)}">
          <span class="dropzone__icon" aria-hidden="true">&#8682;</span>
          <span class="dropzone__title">Drop your ${esc(c.input.label)} file here</span>
          <span class="dropzone__sub">or <span class="link">choose a file</span> &middot; up to ${site.maxFileMB || 300} MB</span>
        </label>

        <div class="file-info" id="cv-file-info" hidden>
          <div>
            <strong id="cv-file-name"></strong>
            <span class="muted" id="cv-file-meta"></span>
          </div>
          <button type="button" class="btn btn--ghost" id="cv-change">Change file</button>
        </div>

        <form class="settings" id="cv-settings" hidden>${trim}${selects}
          <p class="settings__hint">${c.trim ? 'Times can be seconds (12.5) or minutes:seconds (1:05). Leave blank to use the whole video. ' : ''}${esc(c.tip || '')}</p>
        </form>

        <button type="button" class="btn btn--primary btn--big" id="cv-convert" disabled>Convert to ${esc(c.output.label)}</button>

        <div class="progress" id="cv-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-labelledby="cv-phase" hidden>
          <p class="progress__phase" id="cv-phase">Starting&hellip;</p>
          <div class="progress__track"><span class="progress__bar" id="cv-bar"></span></div>
          <div class="progress__row">
            <span class="muted" id="cv-status" aria-live="polite"></span>
            <button type="button" class="btn btn--ghost" id="cv-cancel">Cancel</button>
          </div>
        </div>

        <div class="alert" id="cv-error" role="alert" hidden>
          <p id="cv-error-msg"></p>
          <details hidden><summary>Technical details</summary><pre id="cv-error-detail"></pre></details>
        </div>

        <div class="result" id="cv-result" hidden>
          <div class="result__preview" id="cv-preview"></div>
          <p class="muted" id="cv-result-info"></p>
          <div class="result__actions">
            <a class="btn btn--primary btn--big" id="cv-download" href="#" download>Download ${esc(c.output.label)}</a>
            <button type="button" class="btn" id="cv-reset">Convert another file</button>
          </div>
        </div>

        <p class="privacy-note"><span aria-hidden="true">&#128274;</span> Your file is converted right here in your browser and is <strong>never uploaded</strong> to any server. The converter engine (about 31&nbsp;MB) downloads once when you press Convert.</p>
        <noscript><p class="alert">This converter needs JavaScript to run in your browser.</p></noscript>
      </section>`;
}

function toolPage(tool) {
  const content = tool.content.map((p) => `
        ${p.heading ? `<h2>${esc(p.heading)}</h2>` : ''}
        <p>${p.html}</p>`).join('');
  const others = tools.filter((t) => t.slug !== tool.slug);
  const related = others.length ? `
        <h2>More converters</h2>
        <ul class="related">${others.map((t) => `<li><a href="${href(pagePath(t.slug))}">${esc(t.navLabel)}</a></li>`).join('')}</ul>` : '';
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: tool.h1,
    url: absURL(pagePath(tool.slug)),
    description: tool.description,
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Any (runs in a web browser)',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  };
  const body = `
      <h1>${esc(tool.h1)}</h1>
      <p class="lede">${esc(tool.lede || tool.description)}</p>
${adSlot('top')}
${converterSection(tool)}
${adSlot('bottom')}
      <article class="info">${content}${related}
      </article>`;
  return layout({
    slug: tool.slug,
    title: tool.title,
    description: tool.description,
    body,
    extraHead: `\n  <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
    scripts: `\n  <script type="module" src="${href('js/converter.js')}"></script>`,
  });
}

/* ---------- static pages ---------- */

function fill(html) {
  return html
    .replace(/\{\{siteName\}\}/g, esc(site.name))
    .replace(/\{\{contactEmail\}\}/g, esc(site.contactEmail))
    .replace(/\{\{maxFileMB\}\}/g, String(site.maxFileMB || 300))
    .replace(/\{\{ffmpegWasmVersion\}\}/g, esc(versions['@ffmpeg/ffmpeg'] || ''))
    .replace(/\{\{coreVersion\}\}/g, esc(versions['@ffmpeg/core'] || ''))
    .replace(/\{\{base\}\}/g, BASE)
    .replace(/\{\{toolList\}\}/g, () => `<ul class="tool-grid">${tools.map((t) =>
      `<li><a href="${href(pagePath(t.slug))}"><strong>${esc(t.navLabel)}</strong><span>${esc(t.lede || t.description)}</span></a></li>`).join('')}</ul>`);
}

const staticPages = [
  { slug: '', file: 'home.html', title: `${site.name} – Free, Private Video Converters in Your Browser`,
    description: 'Free online video converters that run entirely in your browser with FFmpeg. Convert MP4 to GIF, MOV to MP4 and more – your files are never uploaded.' },
  { slug: 'about', file: 'about.html', title: `About – ${site.name}`,
    description: `What ${site.name} is, how the in-browser converters work, and why your files never leave your device.` },
  { slug: 'privacy', file: 'privacy.html', title: `Privacy Policy – ${site.name}`,
    description: `Privacy policy for ${site.name}: files are processed locally in your browser and never uploaded. Details on cookies and advertising.` },
  { slug: 'contact', file: 'contact.html', title: `Contact – ${site.name}`,
    description: `How to contact ${site.name} with questions, bug reports or converter requests.` },
  { slug: 'credits', file: 'credits.html', title: `Open-Source Credits & FFmpeg License – ${site.name}`,
    description: `${site.name} is powered by FFmpeg and ffmpeg.wasm. License notices and links to the complete source code.` },
];

/* ---------- build ---------- */

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

copyDir(path.join(ROOT, 'css'), path.join(DIST, 'css'));
copyDir(path.join(ROOT, 'js'), path.join(DIST, 'js'));
if (!fs.existsSync(path.join(ROOT, 'vendor', 'ffmpeg-core', 'ffmpeg-core.wasm'))) {
  throw new Error('vendor/ffmpeg-core is missing. Run `npm install && npm run vendor` first.');
}
copyDir(path.join(ROOT, 'vendor'), path.join(DIST, 'vendor'));

const urls = [];
for (const p of staticPages) {
  const body = fill(fs.readFileSync(path.join(ROOT, 'pages', p.file), 'utf8'));
  write(path.join(pagePath(p.slug), 'index.html'), layout({ slug: p.slug, title: p.title, description: p.description, body }));
  urls.push({ loc: absURL(pagePath(p.slug)), priority: p.slug ? '0.3' : '1.0' });
  console.log('page:', '/' + pagePath(p.slug));
}
for (const t of tools) {
  write(path.join(t.slug, 'index.html'), toolPage(t));
  urls.push({ loc: absURL(pagePath(t.slug)), priority: '0.9' });
  console.log('tool:', '/' + pagePath(t.slug));
}

const today = new Date().toISOString().slice(0, 10);
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${today}</lastmod><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`);
write('robots.txt', `User-agent: *
Allow: /

Sitemap: ${SITE_URL}${BASE}sitemap.xml
`);
write('404.html', layout({ slug: '404', title: `Page not found – ${site.name}`, description: 'Page not found.',
  body: `\n      <h1>Page not found</h1>\n      <p>That page doesn\u2019t exist. Pick a converter:</p>\n      ${fill('{{toolList}}')}` })
  .replace(/<link rel="canonical"[^>]*>\n/, '<meta name="robots" content="noindex">\n'));
console.log(`done: ${tools.length} tools, ${urls.length} URLs -> ${path.relative(ROOT, DIST)}/`);
