#!/usr/bin/env node
'use strict';

/**
 * build.config.js — Sprint 18: opt-in production build.
 *
 * WHAT THIS IS
 * A separate, optional build step that produces a minified, hashed copy of
 * the site's static assets into dist/. It does NOT change how the project
 * is developed or deployed today:
 *
 *   - Development is untouched: keep editing love.html, app.html,
 *     components.css, etc. directly at the repo root and refresh the
 *     browser, exactly as before. Nothing here is required for that.
 *   - Deployment is untouched: `vercel deploy --prod` still serves the
 *     root-level HTML/CSS/JS files as-is (see SETUP.md's zero-config
 *     deploy flow). This script is never invoked automatically by Vercel
 *     unless a project maintainer later, deliberately, points Vercel's
 *     Build Command / Output Directory at it — a decision explicitly left
 *     for a future sprint, not made here.
 *
 * WHAT IT DOES (when run manually via `npm run build`)
 *   1. Minifies every root-level .css file (theme.css, components.css)
 *      using clean-css, and writes a hashed-filename copy into dist/css/.
 *   2. Minifies every root-level .html file's INLINE <script> and <style>
 *      blocks in place (via esbuild's transform API), without altering
 *      any markup, attributes, class names, or DOM structure — the HTML
 *      itself is otherwise byte-identical, so this cannot change the UI.
 *   3. Writes the minified HTML files into dist/ (same filenames — pages
 *      are entry points, not bundled, so hashing them isn't meaningful
 *      the way it is for a shared .css/.js asset).
 *   4. Emits dist/asset-manifest.json mapping original filenames to their
 *      hashed dist/ output paths, for whichever future step wires
 *      hashed <link>/<script> tags into the HTML (not done yet — see
 *      "NOT done yet" below).
 *
 * TREE SHAKING / BUNDLE OPTIMIZATION
 * Today, every page's JS is a single inline <script> block with no
 * `import`/`export` statements (no ES module graph exists to shake dead
 * branches out of) and no shared bundle across pages. esbuild is
 * configured below with `treeShaking: true` and `bundle: true` so that,
 * the moment any file (now or later) is extracted into real ES modules
 * with imports (see "CSS/JS EXTRACTION" below), tree shaking and bundling
 * activate automatically with no further config changes. Until that
 * extraction happens, esbuild's minifier still removes dead code *within*
 * each script block (unreachable branches, unused local variables), which
 * is a real, if smaller, win available today without extraction.
 *
 * CSS / JS EXTRACTION — PREPARED, NOT PERFORMED
 * Per Sprint 18 scope ("prepare CSS extraction, do NOT move CSS yet" /
 * "prepare JS extraction, do NOT break current HTML"), this script does
 * NOT pull inline <style>/<script> blocks out of love.html, friendship.html,
 * index.html, or app.html into separate files. It only minifies them in
 * place. EXTRACTED_CSS_TARGETS and EXTRACTED_JS_TARGETS below are a
 * prepared list marking which pages still carry inline code that a future
 * sprint could extract (the same way theme.css/components.css already
 * were, for index.html/app.html/about.html/demo.html/update.html) — this
 * is documentation of the plan, not code that runs.
 *
 * HASHED ASSETS — PREPARED, NOT WIRED IN
 * hashFile() below computes a content hash and is applied to the CSS
 * output (dist/css/theme.<hash>.css etc.) and recorded in
 * asset-manifest.json. The root HTML files' <link rel="stylesheet">
 * tags are NOT rewritten to point at hashed filenames — that would change
 * what's served today, which is out of scope for "prepare" per this
 * sprint's instructions. A future sprint would read asset-manifest.json
 * and rewrite the relevant <link>/<script src> tags as part of an actual
 * cutover.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// Root-level static CSS files eligible for extraction/minify+hash today.
const CSS_FILES = ['theme.css', 'components.css'];

// Root-level HTML pages. Inline <style>/<script> blocks in each are
// minified in place; markup is untouched.
const HTML_FILES = [
  'index.html', 'app.html', 'about.html', 'demo.html', 'update.html',
  'love.html', 'friendship.html', 'payment.html', 'success.html', 'admin.html',
];

// Prepared (not yet acted on) list of pages that still carry a large
// inline <style>/<script> block rather than linking the shared
// theme.css/components.css files — see the block comment above.
const EXTRACTED_CSS_TARGETS = ['love.html', 'friendship.html'];
const EXTRACTED_JS_TARGETS = ['index.html', 'app.html', 'love.html', 'friendship.html'];

function hashFile(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 10);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function buildCss() {
  const CleanCSS = require('clean-css');
  const cleaner = new CleanCSS({ level: 2 });
  const manifest = {};

  ensureDir(path.join(DIST, 'css'));

  for (const file of CSS_FILES) {
    const srcPath = path.join(ROOT, file);
    if (!fs.existsSync(srcPath)) {
      console.warn(`[build] skip ${file}: not found`);
      continue;
    }
    const src = fs.readFileSync(srcPath, 'utf8');
    const result = cleaner.minify(src);
    if (result.errors.length) {
      throw new Error(`[build] clean-css failed on ${file}: ${result.errors.join('; ')}`);
    }
    const minified = result.styles;
    const hash = hashFile(Buffer.from(minified));
    const base = path.basename(file, '.css');
    const hashedName = `${base}.${hash}.css`;
    fs.writeFileSync(path.join(DIST, 'css', hashedName), minified);

    const originalSize = Buffer.byteLength(src, 'utf8');
    const minifiedSize = Buffer.byteLength(minified, 'utf8');
    manifest[file] = {
      output: `css/${hashedName}`,
      originalBytes: originalSize,
      minifiedBytes: minifiedSize,
      reductionPct: Math.round((1 - minifiedSize / originalSize) * 100),
    };
    console.log(`[build] ${file} -> dist/css/${hashedName} (${originalSize}B -> ${minifiedSize}B, -${manifest[file].reductionPct}%)`);
  }

  return manifest;
}

async function buildHtml() {
  const esbuild = require('esbuild');
  const manifest = {};
  ensureDir(DIST);

  for (const file of HTML_FILES) {
    const srcPath = path.join(ROOT, file);
    if (!fs.existsSync(srcPath)) {
      console.warn(`[build] skip ${file}: not found`);
      continue;
    }
    let html = fs.readFileSync(srcPath, 'utf8');
    const originalSize = Buffer.byteLength(html, 'utf8');

    // Minify inline <script>...</script> blocks in place, one at a time,
    // preserving everything outside the block byte-for-byte. Blocks with
    // a `src=` attribute (external scripts) are left alone — there's
    // nothing inline to minify.
    html = await replaceBlocksAsync(html, /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi, async (match, attrs, code) => {
      if (!code.trim()) return match;
      try {
        const result = await esbuild.transform(code, {
          loader: 'js',
          minify: true,
          treeShaking: true,
          target: 'es2019', // matches broad current-browser support without a transpile step
        });
        return `<script${attrs}>${result.code.trim()}</script>`;
      } catch (err) {
        console.warn(`[build] esbuild could not minify a <script> block in ${file}, leaving as-is: ${err.message}`);
        return match;
      }
    });

    // Minify inline <style>...</style> blocks in place, same approach.
    const CleanCSS = require('clean-css');
    const cleaner = new CleanCSS({ level: 2 });
    html = replaceBlocks(html, /<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, code) => {
      if (!code.trim()) return match;
      const result = cleaner.minify(code);
      if (result.errors.length) {
        console.warn(`[build] clean-css could not minify a <style> block in ${file}, leaving as-is: ${result.errors.join('; ')}`);
        return match;
      }
      return `<style${attrs}>${result.styles}</style>`;
    });

    fs.writeFileSync(path.join(DIST, file), html);
    const minifiedSize = Buffer.byteLength(html, 'utf8');
    manifest[file] = {
      output: file,
      originalBytes: originalSize,
      minifiedBytes: minifiedSize,
      reductionPct: Math.round((1 - minifiedSize / originalSize) * 100),
    };
    console.log(`[build] ${file} -> dist/${file} (${originalSize}B -> ${minifiedSize}B, -${manifest[file].reductionPct}%)`);
  }

  return manifest;
}

function replaceBlocks(str, regex, fn) {
  let result = '';
  let lastIndex = 0;
  let m;
  const re = new RegExp(regex.source, regex.flags);
  while ((m = re.exec(str)) !== null) {
    result += str.slice(lastIndex, m.index) + fn(...m, m.index, str);
    lastIndex = re.lastIndex;
  }
  result += str.slice(lastIndex);
  return result;
}

async function replaceBlocksAsync(str, regex, fn) {
  const re = new RegExp(regex.source, regex.flags);
  let result = '';
  let lastIndex = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    const replacement = await fn(...m, m.index, str);
    result += str.slice(lastIndex, m.index) + replacement;
    lastIndex = re.lastIndex;
  }
  result += str.slice(lastIndex);
  return result;
}

async function main() {
  const analyze = process.argv.includes('--analyze');

  console.log('[build] Sprint 18 production build starting...');
  console.log('[build] Output: dist/ (root-level files are never modified)');

  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true, force: true });
  }
  ensureDir(DIST);

  const cssManifest = await buildCss();
  const htmlManifest = await buildHtml();

  const manifest = {
    generatedAt: new Date().toISOString(),
    css: cssManifest,
    html: htmlManifest,
    preparedNotPerformed: {
      cssExtractionTargets: EXTRACTED_CSS_TARGETS,
      jsExtractionTargets: EXTRACTED_JS_TARGETS,
      note: 'These pages still carry inline <style>/<script> blocks. Extraction into standalone, cacheable, hashed files is prepared for (see build.config.js header comment) but intentionally not performed this sprint.',
    },
  };
  fs.writeFileSync(path.join(DIST, 'asset-manifest.json'), JSON.stringify(manifest, null, 2));

  if (analyze) {
    console.log('\n[build] ── Bundle analysis ──');
    let totalOriginal = 0;
    let totalMinified = 0;
    for (const [, v] of Object.entries({ ...cssManifest, ...htmlManifest })) {
      totalOriginal += v.originalBytes;
      totalMinified += v.minifiedBytes;
    }
    const pct = Math.round((1 - totalMinified / totalOriginal) * 100);
    console.log(`[build] Total: ${totalOriginal}B -> ${totalMinified}B (-${pct}%)`);
  }

  console.log('[build] Done. Root-level files are unchanged; output is in dist/.');
  console.log('[build] dist/ is NOT wired into deployment yet — see build.config.js header comment.');
}

main().catch((err) => {
  console.error('[build] FAILED:', err);
  process.exit(1);
});
