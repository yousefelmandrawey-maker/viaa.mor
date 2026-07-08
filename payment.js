'use strict';
(function () {
    const qs = new URLSearchParams(window.location.search);
    const product = qs.get('product') || 'Viaa Access Code';
    const amount = qs.get('amount') || '99';
    const pageId = qs.get('pageId') || '';

    const MAX_FILE_BYTES = 8 * 1024 * 1024; // keep in sync with api/submit-payment.js
    const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
    const SUBMIT_TIMEOUT_MS = 20000; // generous — this request includes an image upload
    const MAX_RETRIES = 2;

    document.getElementById('productLabel').textContent = product;
    document.getElementById('amountLabel').textContent = `${amount} EGP`;
    document.getElementById('productTitle').textContent =
        product.toLowerCase().includes('trailer') ? 'Upgrade to Premium Trailer' : 'Complete Your Payment';

    // Prefill from query string if available (e.g. coming from the index modal)
    ['name', 'email', 'phone'].forEach((k) => {
        const v = qs.get(k);
        if (v) {
            const el = document.getElementById('p' + k[0].toUpperCase() + k.slice(1));
            if (el) el.value = v;
        }
    });

    let selectedMethod = 'vodafone_cash';
    document.querySelectorAll('.method-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.method-tab').forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            selectedMethod = tab.dataset.method;
        });
    });

    document.getElementById('copyNum').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText('01060577088');
            const el = document.getElementById('copyNum');
            const orig = el.textContent;
            el.textContent = 'Copied ✓';
            setTimeout(() => (el.textContent = orig), 1500);
        } catch (_) { }
    });

    const fileInput = document.getElementById('pFile');
    const dropZone = document.getElementById('dropZone');
    const preview = document.getElementById('preview');
    let fileError = '';

    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        fileError = '';
        if (!file) return;

        // Mirror the server's checks client-side so people find out about a bad
        // file immediately, not after a full upload attempt.
        if (file.size > MAX_FILE_BYTES) {
            fileError = 'Screenshot is too large (max 8MB). Please choose a smaller image.';
        } else if (file.type && !ALLOWED_MIME.has(file.type)) {
            fileError = 'Screenshot must be an image (jpg, png, webp, or heic).';
        }

        if (fileError) {
            const st = document.getElementById('formStatus');
            st.textContent = fileError;
            st.className = 'status e';
            dropZone.classList.remove('has-file');
            document.getElementById('dropText').textContent = 'Choose a different file';
            preview.style.display = 'none';
            fileInput.value = '';
            return;
        }

        dropZone.classList.add('has-file');
        document.getElementById('dropText').textContent = file.name;
        const reader = new FileReader();
        reader.onload = (e) => {
            preview.src = e.target.result;
            preview.style.display = 'block';
        };
        reader.readAsDataURL(file);
    });

    function setError(id, msg) {
        const el = document.getElementById(id);
        if (el) el.classList.add('err');
        const st = document.getElementById('formStatus');
        if (msg && st) { st.textContent = msg; st.className = 'status e'; }
    }

    function clearErrors() {
        document.querySelectorAll('.cinput').forEach((el) => el.classList.remove('err'));
        const st = document.getElementById('formStatus');
        st.textContent = '';
        st.className = 'status';
    }

    function isValidEmail(e) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
    }

    function isValidPhone(p) {
        return /^[0-9+\-()\s]{7,20}$/.test(p);
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Retries only on network-level failures / timeouts / 5xx / 429 — never
    // on 4xx validation errors, since resubmitting the same bad input won't
    // help and would just resubmit the file repeatedly.
    function isRetryable(status, networkError) {
        if (networkError) return true;
        return status === 429 || status >= 500;
    }

    async function submitWithRetry(fd, statusEl, btn) {
        for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
            try {
                if (attempt > 1) {
                    statusEl.textContent = `Connection hiccup — retrying (${attempt - 1}/${MAX_RETRIES})…`;
                    statusEl.className = 'status';
                }
                const res = await fetch('/api/submit-payment', { method: 'POST', body: fd, signal: controller.signal });
                clearTimeout(timer);
                const data = await res.json().catch(() => ({}));

                if (!res.ok || !data.success) {
                    const message = data.error || 'Submission failed';
                    if (isRetryable(res.status) && attempt <= MAX_RETRIES) {
                        await sleep(600 * attempt);
                        continue;
                    }
                    throw new Error(message);
                }
                return data;
            } catch (err) {
                clearTimeout(timer);
                const wasAbort = err.name === 'AbortError';
                const networkError = wasAbort || err instanceof TypeError; // fetch throws TypeError on network failure
                if (networkError && attempt <= MAX_RETRIES) {
                    await sleep(600 * attempt);
                    continue;
                }
                throw new Error(wasAbort ? 'The request took too long. Please check your connection and try again.' : err.message);
            }
        }
    }

    document.getElementById('payForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        clearErrors();

        const name = document.getElementById('pName').value.trim();
        const email = document.getElementById('pEmail').value.trim();
        const phone = document.getElementById('pPhone').value.trim();
        const senderNumber = document.getElementById('pSender').value.trim();
        const file = fileInput.files[0];

        let hasErr = false;
        if (!name) { setError('pName'); hasErr = true; }
        if (!email || !isValidEmail(email)) { setError('pEmail'); hasErr = true; }
        if (!phone || !isValidPhone(phone)) { setError('pPhone'); hasErr = true; }
        if (!senderNumber || !isValidPhone(senderNumber)) { setError('pSender'); hasErr = true; }
        if (!file) { hasErr = true; }
        if (fileError) { hasErr = true; }
        if (hasErr) {
            const st = document.getElementById('formStatus');
            st.textContent = fileError || 'Please fill all fields correctly and upload your screenshot.';
            st.className = 'status e';
            return;
        }

        const btn = document.getElementById('submitBtn');
        const st = document.getElementById('formStatus');
        btn.disabled = true;
        btn.innerHTML = '<span class="spin"></span>Submitting…';
        st.textContent = 'Uploading your payment details…';
        st.className = 'status';

        try {
            const fd = new FormData();
            fd.append('name', name);
            fd.append('email', email);
            fd.append('phone', phone);
            fd.append('product', product);
            fd.append('amount', amount);
            fd.append('method', selectedMethod);
            fd.append('senderNumber', senderNumber);
            fd.append('screenshot', file);
            if (pageId) fd.append('pageId', pageId);

            const data = await submitWithRetry(fd, st, btn);

            st.textContent = 'Submitted! Redirecting…';
            st.className = 'status';

            // Note: we deliberately do NOT touch trailer_type/trailer_status here.
            // A submitted payment is only a claim — it still needs admin approval
            // (polled for on success.html). Queuing real AI generation happens only
            // once that approval is confirmed, via POST /api/trailer/queue called
            // from success.html. Marking a page "pending" before approval would
            // leave it stuck showing "being generated" forever if the payment is
            // later rejected.

            window.location.href = `success.html?id=${encodeURIComponent(data.id)}`;
        } catch (err) {
            st.textContent = err.message || 'Something went wrong. Please try again.';
            st.className = 'status e';
            btn.disabled = false;
            btn.textContent = 'Submit Payment';
        }
    });
})();