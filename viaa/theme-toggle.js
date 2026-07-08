'use strict';

/**
 * theme-toggle.js — shared Light/Dark control for index.html, app.html,
 * about.html.
 *
 * Persistence: localStorage key "viaa_color_scheme" = "light" | "dark".
 * No-flash: the actual attribute-setting happens in an inline <script>
 * placed before <link rel="stylesheet"> in <head> (see THEME_BOOTSTRAP_SNIPPET
 * below, already inlined per-page) — this file only wires up the button and
 * keeps state in sync afterward. Doing the first paint decision inline is
 * required: an external, deferred script would apply the theme after the
 * browser has already painted the light page once, causing a visible flash.
 */

(function () {
    var STORAGE_KEY = 'viaa_color_scheme';

    function getStored() {
        try {
            return localStorage.getItem(STORAGE_KEY);
        } catch (_) {
            return null;
        }
    }

    function setStored(value) {
        try {
            localStorage.setItem(STORAGE_KEY, value);
        } catch (_) {
            /* private-browsing / storage disabled — theme still works for
               this session via the DOM attribute, it just won't persist. */
        }
    }

    function apply(scheme) {
        document.documentElement.setAttribute('data-color-scheme', scheme);
        document.querySelectorAll('.theme-toggle').forEach(function (btn) {
            btn.setAttribute('aria-checked', scheme === 'dark' ? 'true' : 'false');
        });
    }

    function current() {
        return document.documentElement.getAttribute('data-color-scheme') === 'dark' ? 'dark' : 'light';
    }

    function toggle() {
        var next = current() === 'dark' ? 'light' : 'dark';
        apply(next);
        setStored(next);
    }

    function buildToggleMarkup() {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'theme-toggle';
        btn.setAttribute('role', 'switch');
        btn.setAttribute('aria-checked', current() === 'dark' ? 'true' : 'false');
        btn.setAttribute('aria-label', 'Toggle dark mode');
        btn.innerHTML =
            '<span class="tt-icon-sun" aria-hidden="true">\u2600\ufe0f</span>' +
            '<span class="tt-icon-moon" aria-hidden="true">\ud83c\udf19</span>' +
            '<span class="tt-thumb" aria-hidden="true"></span>';
        return btn;
    }

    function init() {
        // Sync in case the bootstrap snippet's choice differs from a
        // late system-preference change while the page was open elsewhere.
        apply(current());

        document.querySelectorAll('.nav-r').forEach(function (container) {
            if (container.querySelector('.theme-toggle')) return; // already has one
            var btn = buildToggleMarkup();
            btn.addEventListener('click', toggle);
            // Placed first in .nav-r so it reads left-to-right before
            // language/CTA controls, consistent across all three pages.
            container.insertBefore(btn, container.firstChild);
        });

        // Keep multiple open tabs in sync.
        window.addEventListener('storage', function (e) {
            if (e.key === STORAGE_KEY && e.newValue) {
                apply(e.newValue);
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
