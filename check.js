
const T = new URLSearchParams(location.search).get('t') || '';
const $ = s => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Setup-Token': T, ...(opts.headers || {}) }
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || 'Something went wrong. Please try again.');
  return body;
};

let step = 0, state = {};
function go(n) {
  step = n;
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', +p.dataset.p === n));
  document.querySelectorAll('#steps li').forEach(li => {
    const s = +li.dataset.s;
    li.classList.toggle('on', s === n);
    li.classList.toggle('done', s < n);
    li.querySelector('.dot').textContent = s < n ? 'o"' : s + 1;
  });
  window.scrollTo(0, 0);
}

/* ---------- step 0: checks ---------- */
const ICON = { pass: 'o"', fail: '!', warn: '!', pend: '' };
function renderChecks(rep) {
  $('#checks').innerHTML = rep.results.map(r => `
    <div class="check ${r.status}">
      <div class="ico">${ICON[r.status] || ''}</div>
      <div style="flex:1">
        <b>${r.label}</b>
        <div class="detail">${r.detail || ''}</div>
        ${r.fix ? `<div class="fixbox">${r.fix}</div>` : ''}
      </div>
    </div>`).join('');
  $('#c-next').disabled = !rep.ok;
}
let checkTimer = null;
async function runChecks() {
  $('#c-busy').innerHTML = '<span class="spin"></span> checking...';
  try {
    const rep = await api('/api/checks');
    renderChecks(rep);
    clearTimeout(checkTimer);
    if (!rep.ok) checkTimer = setTimeout(runChecks, 4000);
  } catch (e) {
    $('#checks').innerHTML = `<div class="check fail"><div class="ico">!</div><div><b>Check failed</b>
      <div class="detail">${e.message}</div></div></div>`;
  } finally { $('#c-busy').textContent = ''; }
}
$('#c-again').onclick = runChecks;
$('#c-next').onclick = () => { clearTimeout(checkTimer); go(1); initQR(); };

/* ---------- step 1: qr scan ---------- */
let pollTimer;
async function initQR() {
  try {
    const res = await api('/api/intent', { method: 'POST' });
    $('#qr-scan').src = '/api/qr?d=' + encodeURIComponent(res.intentId);
    pollTimer = setInterval(pollQR, 2000);
  } catch (e) {
    $('#q-err').textContent = e.message; $('#q-err').classList.add('show');
  }
}

async function pollQR() {
  try {
    const r = await api('/api/intent');
    if (r.approved) {
      clearInterval(pollTimer);
      $('#d-org').textContent = r.orgName || 'Connected';
      go(2); // done
    }
  } catch (e) {
    clearInterval(pollTimer);
    if (e.message !== "Intent expired") {
      $('#q-err').textContent = e.message; $('#q-err').classList.add('show');
    }
  }
}

$('#f-close').onclick = () => window.close();

/* ---------- boot ---------- */
(async () => {
  try {
    state = await api('/api/state');
    if (state.paired) { $('#d-org').textContent = state.orgName || 'Connected'; go(2); return; }
  } catch (_) { /* fall through to checks */ }
  runChecks();
})();

