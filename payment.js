'use strict';
(function () {
  const qs = new URLSearchParams(window.location.search);
  const product = qs.get('product') || 'Viaa Access Code';
  const amount = qs.get('amount') || '99';
  const pageId = qs.get('pageId') || '';

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
    } catch (_) {}
  });

  const fileInput = document.getElementById('pFile');
  const dropZone = document.getElementById('dropZone');
  const preview = document.getElementById('preview');
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
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
    if (!email || !email.includes('@')) { setError('pEmail'); hasErr = true; }
    if (!phone) { setError('pPhone'); hasErr = true; }
    if (!senderNumber) { setError('pSender'); hasErr = true; }
    if (!file) { hasErr = true; }
    if (hasErr) {
      const st = document.getElementById('formStatus');
      st.textContent = 'Please fill all fields and upload your screenshot.';
      st.className = 'status e';
      return;
    }

    const btn = document.getElementById('submitBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>Submitting…';

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

      const res = await fetch('/api/submit-payment', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Submission failed');

      window.location.href = `success.html?id=${encodeURIComponent(data.id)}`;
    } catch (err) {
      const st = document.getElementById('formStatus');
      st.textContent = err.message || 'Something went wrong. Please try again.';
      st.className = 'status e';
      btn.disabled = false;
      btn.textContent = 'Submit Payment';
    }
  });
})();
