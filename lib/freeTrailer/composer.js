/**
 * FREE TRAILER — browser-side generator (Canvas + MediaRecorder + Web Audio API).
 * No FFmpeg. No Luma. No server round-trip. Runs entirely in app.html during
 * page creation, before the user is redirected to their published page.
 *
 * Output: WebM Blob, 720x1280 @ 30fps, ~2 Mbps video / 128 kbps audio,
 * codec fallback video/webm;codecs=vp9,opus -> vp8,opus -> plain webm.
 */

const THEME_COLORS = {
    classic: { bg1: '#14082a', bg2: '#07020f', accent: '#e8739c' },
    red_roses: { bg1: '#1a0008', bg2: '#0d0003', accent: '#ff3355' },
    midnight: { bg1: '#051428', bg2: '#010818', accent: '#7b9cff' },
    sakura: { bg1: '#200c2a', bg2: '#110618', accent: '#ffb7c5' },
    golden: { bg1: '#1c1000', bg2: '#0e0800', accent: '#f5c842' },
    soft_princess: { bg1: '#220010', bg2: '#120008', accent: '#f9a8d4' },
    lavender: { bg1: '#180530', bg2: '#0d0318', accent: '#c084fc' },
    luxury: { bg1: '#0d0d0d', bg2: '#000000', accent: '#d4af37' },
    birthday: { bg1: '#2a0050', bg2: '#1a0030', accent: '#ff9de2' },
    golden_days: { bg1: '#1a1200', bg2: '#0d0800', accent: '#f5c842' },
    night_talks: { bg1: '#04061a', bg2: '#010312', accent: '#4facfe' },
    gaming: { bg1: '#051a08', bg2: '#010e04', accent: '#6bffb8' },
    food: { bg1: '#1a0a00', bg2: '#0e0500', accent: '#ff9a3c' },
    adventure: { bg1: '#001a1a', bg2: '#000d0d', accent: '#00d4aa' },
    memories: { bg1: '#0d0a04', bg2: '#060402', accent: '#c9a84c' },
    camera_roll: { bg1: '#0a0a14', bg2: '#050508', accent: '#b8c0ff' },
    music: { bg1: '#0e0018', bg2: '#07000e', accent: '#c084fc' },
    journey: { bg1: '#001018', bg2: '#00080e', accent: '#38bdf8' },
};
const DEFAULT_THEME = { bg1: '#14082a', bg2: '#07020f', accent: '#e8739c' };

const W = 720, H = 1280;

function getTheme(id) { return THEME_COLORS[id] || DEFAULT_THEME; }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Feature check: does this browser support recording canvas video at all? */
export function supportsFreeTrailer() {
    return typeof MediaRecorder !== 'undefined'
        && typeof HTMLCanvasElement !== 'undefined'
        && typeof HTMLCanvasElement.prototype.captureStream === 'function'
        && (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
            || MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
            || MediaRecorder.isTypeSupported('video/webm'));
}

function pickMimeType() {
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) return 'video/webm;codecs=vp9,opus';
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) return 'video/webm;codecs=vp8,opus';
    return 'video/webm';
}

/** 6-15 photos -> 10-20s linear, more photos extend automatically, clamped 8-60s. */
function computeDuration(n) {
    let base;
    if (n <= 1) base = 8;
    else if (n <= 6) base = 10;
    else if (n <= 15) base = 10 + (n - 6) * (10 / 9);
    else base = 20 + (n - 15) * 1.0;
    return clamp(base, 8, 60);
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load photo: ${url}`));
        img.src = url;
    });
}

async function loadAudioBuffer(url, audioCtx) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch music (${res.status}): ${url}`);
    const arr = await res.arrayBuffer();
    return await audioCtx.decodeAudioData(arr);
}

function formatDate(dateStr, lang) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr + 'T00:00:00');
        return d.toLocaleDateString(lang === 'ar' ? 'ar' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (_) { return dateStr; }
}
function daysSince(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

function drawCoverImage(ctx, img, x, y, w, h, panX, panY, scale) {
    const ir = img.width / img.height, tr = w / h;
    let sw, sh, sx, sy;
    if (ir > tr) { sh = img.height; sw = sh * tr; sy = 0; sx = (img.width - sw) / 2; }
    else { sw = img.width; sh = sw / tr; sx = 0; sy = (img.height - sh) / 2; }
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    const cx = x + w / 2 + panX, cy = y + h / 2 + panY;
    ctx.translate(cx, cy); ctx.scale(scale, scale); ctx.translate(-cx, -cy);
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    ctx.restore();
}

function wrapText(ctx, text, maxWidth) {
    const words = text.split(/\s+/); const lines = []; let cur = '';
    for (const w of words) {
        const test = cur ? cur + ' ' + w : w;
        if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = w; }
        else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
}

/**
 * @param {Object} input
 * @param {string} input.boyName
 * @param {string} input.girlName
 * @param {string} input.message
 * @param {string|null} input.startDate
 * @param {string} input.theme
 * @param {string[]} input.photoUrls
 * @param {string|null} input.musicUrl
 * @param {'love'|'friendship'} [input.edition]
 * @param {'en'|'ar'} [input.lang]
 * @param {(p:{phase:string, pct:number})=>void} [onProgress]
 * @returns {Promise<Blob>} webm blob
 */
export async function generateFreeTrailer(input, onProgress) {
    if (!supportsFreeTrailer()) throw new Error('This browser cannot record canvas video (MediaRecorder/captureStream unsupported).');

    const notify = (phase, pct) => { try { onProgress && onProgress({ phase, pct: clamp(pct, 0, 100) }); } catch (_) { } };
    const lang = input.lang === 'ar' ? 'ar' : 'en';
    const theme = getTheme(input.theme);
    const photoUrls = (input.photoUrls || []).filter(Boolean);
    if (photoUrls.length === 0) throw new Error('Free trailer requires at least one photo.');

    notify('preparing', 2);

    const images = [];
    for (let i = 0; i < photoUrls.length; i++) {
        try { images.push(await loadImage(photoUrls[i])); }
        catch (e) { console.error('[free-trailer] photo load failed, skipping:', photoUrls[i], e); }
        notify('preparing', 2 + Math.round((i + 1) / photoUrls.length * 28));
    }
    if (images.length === 0) throw new Error('None of the uploaded photos could be loaded for the trailer.');

    let audioCtx = null, audioBuffer = null;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (input.musicUrl) audioBuffer = await loadAudioBuffer(input.musicUrl, audioCtx);
    } catch (e) {
        console.error('[free-trailer] music load failed, continuing without audio:', e);
        audioBuffer = null;
    }
    notify('preparing', 35);

    const n = images.length;
    let totalDuration = computeDuration(n);
    const minSlot = 1.4;
    totalDuration = clamp(Math.max(totalDuration, n * minSlot), 8, 60);
    const slotDur = totalDuration / n;
    const transitionDur = clamp(slotDur * 0.35, 0.4, 0.9);
    const TRANSITIONS = ['fade', 'slide', 'blur', 'dissolve'];
    const slotTransitions = images.map(() => TRANSITIONS[Math.floor(Math.random() * TRANSITIONS.length)]);
    const slotKB = images.map(() => ({
        fromScale: 1.02 + Math.random() * 0.06,
        toScale: 1.14 + Math.random() * 0.08,
        panX: (Math.random() - 0.5) * 60,
        panY: (Math.random() - 0.5) * 90,
        zoomOut: Math.random() < 0.5,
    }));

    const introEnd = 2.4;
    const outroStart = totalDuration - 2.0;
    const dateStart = totalDuration * 0.38;
    const dateEnd = dateStart + 2.6;
    const msgStart = totalDuration * 0.6;
    const msgEnd = Math.min(outroStart - 0.3, msgStart + 3.4);

    // ── Weak-device detection: static heuristic up front, refined at runtime
    // by actual frame pacing. When true: particles are skipped and the
    // 'blur' transition falls back to 'fade'. Every other animation
    // (Ken Burns, slide, dissolve, all typography) is always kept.
    let lowPower = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) ||
        (navigator.deviceMemory && navigator.deviceMemory <= 2);
    const frameTimes = [];
    function updateLowPowerFromPacing(dt) {
        if (lowPower) return;
        frameTimes.push(dt);
        if (frameTimes.length > 24) frameTimes.shift();
        if (frameTimes.length === 24) {
            const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
            if (avg > 1 / 20) {
                lowPower = true;
                console.error('[free-trailer] slow device detected — disabling particles, blur -> fade');
            }
        }
    }

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    canvas.style.position = 'fixed'; canvas.style.left = '-99999px'; canvas.style.top = '0';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d', { alpha: false });

    const videoStream = canvas.captureStream(30);
    const tracks = [...videoStream.getVideoTracks()];

    let destNode = null, gainNode = null, srcNode = null;
    if (audioBuffer && audioCtx) {
        destNode = audioCtx.createMediaStreamDestination();
        gainNode = audioCtx.createGain();
        gainNode.gain.value = 1;
        srcNode = audioCtx.createBufferSource();
        srcNode.buffer = audioBuffer;
        srcNode.loop = audioBuffer.duration < totalDuration; // never leave silence if music is shorter
        srcNode.connect(gainNode).connect(destNode);
        tracks.push(...destNode.stream.getAudioTracks());
    }

    const combined = new MediaStream(tracks);
    const mimeType = pickMimeType();
    let recorder;
    try {
        recorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 128_000 });
    } catch (e) {
        document.body.removeChild(canvas);
        try { audioCtx && audioCtx.close(); } catch (_) { }
        throw new Error(`MediaRecorder could not start with mimeType "${mimeType}": ${e.message}`);
    }
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    const heartParticles = Array.from({ length: 10 }, () => ({
        x: Math.random() * W, y: H + Math.random() * H,
        size: 10 + Math.random() * 18, speed: 18 + Math.random() * 26,
        drift: (Math.random() - 0.5) * 20, opacity: 0.12 + Math.random() * 0.18,
        char: Math.random() < 0.7 ? '♥' : '✦',
    }));

    const boyName = (input.boyName || '').trim();
    const girlName = (input.girlName || '').trim();
    const namesLine = [boyName, girlName].filter(Boolean).join('  ♥  ');
    const dateFormatted = formatDate(input.startDate, lang);
    const days = daysSince(input.startDate);
    const message = (input.message || '').trim();

    function drawVignette() {
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, theme.bg1 + '55');
        g.addColorStop(0.5, 'rgba(0,0,0,0)');
        g.addColorStop(1, theme.bg2 + 'aa');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        const rg = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.75);
        rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(0,0,0,0.45)');
        ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    }

    function drawParticles(dt) {
        if (lowPower) return;
        ctx.save();
        for (const p of heartParticles) {
            p.y -= p.speed * dt; p.x += Math.sin(p.y / 80) * p.drift * dt;
            if (p.y < -30) { p.y = H + 30; p.x = Math.random() * W; }
            ctx.globalAlpha = p.opacity;
            ctx.fillStyle = theme.accent;
            ctx.font = `${p.size}px sans-serif`;
            ctx.fillText(p.char, p.x, p.y);
        }
        ctx.restore();
    }

    function drawBottomScrim(h) {
        const g = ctx.createLinearGradient(0, H - h, 0, H);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.72)');
        ctx.fillStyle = g; ctx.fillRect(0, H - h, W, h);
    }

    function drawIntro(t) {
        const fade = t < introEnd - 0.5 ? easeInOutCubic(clamp(t / 0.6, 0, 1)) : easeInOutCubic(clamp((introEnd - t) / 0.5, 0, 1));
        const scale = 0.9 + 0.1 * easeInOutCubic(clamp(t / 0.6, 0, 1));
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.textAlign = 'center';
        ctx.translate(W / 2, H / 2);
        ctx.scale(scale, scale);
        ctx.fillStyle = '#fff';
        ctx.font = '700 54px Georgia, serif';
        ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 20;
        ctx.fillText(namesLine || (lang === 'ar' ? 'قصة حب' : 'A Love Story'), 0, 0);
        ctx.restore();
    }

    function drawDateBadge(t) {
        if (!dateFormatted) return;
        const local = clamp((t - dateStart) / 0.5, 0, 1);
        const fadeOut = t > dateEnd - 0.5 ? clamp((dateEnd - t) / 0.5, 0, 1) : 1;
        const alpha = Math.min(local, fadeOut);
        if (alpha <= 0) return;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.textAlign = 'center';
        ctx.fillStyle = theme.accent;
        ctx.font = '600 26px Georgia, serif';
        ctx.fillText(lang === 'ar' ? 'معًا منذ' : 'Together since', W / 2, H * 0.16);
        ctx.fillStyle = '#fff';
        ctx.font = '700 34px Georgia, serif';
        ctx.fillText(dateFormatted, W / 2, H * 0.16 + 44);
        if (days !== null) {
            ctx.font = '400 22px Georgia, serif';
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.fillText(lang === 'ar' ? `${days} يومًا معًا` : `${days} days together`, W / 2, H * 0.16 + 78);
        }
        ctx.restore();
    }

    function drawMessage(t) {
        if (!message) return;
        const local = clamp((t - msgStart) / 0.5, 0, 1);
        const fadeOut = t > msgEnd - 0.5 ? clamp((msgEnd - t) / 0.5, 0, 1) : 1;
        const alpha = Math.min(local, fadeOut);
        if (alpha <= 0) return;
        const short = message.length > 140 ? message.slice(0, 140).trim() + '…' : message;
        ctx.save();
        ctx.globalAlpha = alpha;
        drawBottomScrim(360);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.font = '400 30px Georgia, serif';
        const lines = wrapText(ctx, short, W - 100).slice(0, 5);
        const startY = H - 40 - (lines.length - 1) * 40;
        lines.forEach((ln, i) => ctx.fillText(ln, W / 2, startY - (lines.length - 1 - i) * 40));
        ctx.restore();
    }

    function drawOutro(t) {
        if (t < outroStart) return;
        const alpha = easeInOutCubic(clamp((t - outroStart) / 0.6, 0, 1));
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.font = '700 40px Georgia, serif';
        ctx.fillText('Made with VIAA ❤️', W / 2, H / 2);
        ctx.restore();
    }

    function drawSlot(idx, tInSlot) {
        const img = images[idx];
        const kb = slotKB[idx];
        const p = easeInOutCubic(clamp(tInSlot / slotDur, 0, 1));
        const scale = kb.zoomOut ? kb.toScale - (kb.toScale - kb.fromScale) * p : kb.fromScale + (kb.toScale - kb.fromScale) * p;
        const panX = kb.panX * p, panY = kb.panY * p;
        drawCoverImage(ctx, img, 0, 0, W, H, panX, panY, scale);
    }

    function drawTransition(fromIdx, toIdx, t, type) {
        const p = easeInOutCubic(clamp(t, 0, 1));
        drawSlot(fromIdx, slotDur);
        ctx.save();
        const effectiveType = (lowPower && type === 'blur') ? 'fade' : type;
        switch (effectiveType) {
            case 'slide': {
                ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
                ctx.translate(W * (1 - p), 0);
                drawSlot(toIdx, 0);
                ctx.restore();
                break;
            }
            case 'blur': {
                ctx.filter = `blur(${(1 - p) * 14}px)`;
                ctx.globalAlpha = p;
                drawSlot(toIdx, 0);
                ctx.filter = 'none';
                break;
            }
            case 'dissolve':
            case 'fade':
            default: {
                ctx.globalAlpha = p;
                drawSlot(toIdx, 0);
                break;
            }
        }
        ctx.restore();
    }

    return new Promise((resolve, reject) => {
        recorder.onstop = () => {
            try { document.body.removeChild(canvas); } catch (_) { }
            try { audioCtx && audioCtx.close(); } catch (_) { }
            if (chunks.length === 0) { reject(new Error('Recording produced no data.')); return; }
            resolve(new Blob(chunks, { type: mimeType }));
        };
        recorder.onerror = (e) => {
            console.error('[free-trailer] MediaRecorder error:', e.error || e);
            try { document.body.removeChild(canvas); } catch (_) { }
            reject(e.error || new Error('MediaRecorder failed'));
        };

        let stopped = false, start = null, lastT = 0;

        function frame(now) {
            if (stopped) return;
            if (start === null) start = now;
            const elapsed = (now - start) / 1000;
            const dt = clamp(elapsed - lastT, 0, 0.1); lastT = elapsed;
            updateLowPowerFromPacing(dt);

            if (elapsed >= totalDuration) {
                stopped = true;
                if (srcNode) { try { srcNode.stop(); } catch (_) { } }
                recorder.stop();
                notify('finalizing', 100);
                return;
            }

            ctx.fillStyle = theme.bg2; ctx.fillRect(0, 0, W, H);

            const idx = clamp(Math.floor(elapsed / slotDur), 0, n - 1);
            const tInSlot = elapsed - idx * slotDur;
            const nextIdx = (idx + 1) % n;
            const timeToNext = slotDur - tInSlot;

            if (idx < n - 1 && timeToNext <= transitionDur) {
                drawTransition(idx, nextIdx, 1 - timeToNext / transitionDur, slotTransitions[idx]);
            } else {
                drawSlot(idx, tInSlot);
            }

            drawVignette();
            drawParticles(dt);
            if (elapsed < introEnd) drawIntro(elapsed);
            drawDateBadge(elapsed);
            drawMessage(elapsed);
            drawOutro(elapsed);

            notify('rendering', Math.round((elapsed / totalDuration) * 100));
            requestAnimationFrame(frame);
        }

        try {
            recorder.start(250);
            if (srcNode) srcNode.start(0);
            if (srcNode && audioBuffer && audioBuffer.duration > totalDuration - 1) {
                const fadeStartDelay = Math.max(0, totalDuration - 1);
                gainNode.gain.setValueAtTime(1, audioCtx.currentTime + fadeStartDelay);
                gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + totalDuration);
            }
            requestAnimationFrame(frame);
        } catch (e) {
            console.error('[free-trailer] failed to start recorder:', e);
            try { document.body.removeChild(canvas); } catch (_) { }
            reject(e);
        }
    });
}
