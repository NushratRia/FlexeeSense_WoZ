/* app.js — global utilities, session timer, toast */

// ── SESSION TIMER ──
let _sessionSec = 0;
setInterval(() => {
  _sessionSec++;
  const m = Math.floor(_sessionSec / 60), s = _sessionSec % 60;
  document.getElementById('session-time').textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
}, 1000);

// ── TOAST ──
let _toastTimer = null;
function showToast(msg, color) {
  const t = document.getElementById('toast');
  document.getElementById('toast-dot').style.background = color || '#fff';
  document.getElementById('toast-msg').textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ── RESET ── clears client state AND server-side uploaded files
function resetSession() {
  if (!confirm('Reset session? All uploads and canvas elements will be cleared.')) return;

  // Tell server to delete uploaded files and clear room state
  fetch('/reset_session', { method: 'POST' })
    .then(r => r.json())
    .then(d => { if (!d.ok) console.warn('[reset] server error:', d.error); })
    .catch(e => console.warn('[reset] server unreachable:', e));

  // Clear client-side state
  Object.keys(typeof FILES!=='undefined'?FILES:{}).forEach(id => { try{removeFile(id);}catch(_){} });
  Object.keys(typeof LINKS!=='undefined'?LINKS:{}).forEach(id => { try{removeLink(id);}catch(_){} });
  Object.keys(typeof _cards!=='undefined'?_cards:{}).forEach(id => { _cards[id]?.el?.remove(); });
  if (typeof _cards !== 'undefined') { Object.keys(_cards).forEach(k=>delete _cards[k]); }
  if (typeof _cardCounter !== 'undefined') window._cardCounter = 0;
  const lsvg = document.getElementById('link-lines-svg');
  if (lsvg) lsvg.innerHTML = '<defs id="svg-defs"></defs>';
  const sub = document.getElementById('canvas-subtitle');
  if (sub) sub.textContent = '0 elements';
  ['m-ctx','m-dei','m-links','m-files'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = '0';
  });
  _sessionSec = 0;
  showToast('↺ Session reset — uploads cleared', '#6B6A66');
}

// ── MISC ──
function selectProj(el, name) {
  document.querySelectorAll('.proj').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
}

// close dropdowns / menus on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    cancelLink();
    closeAttachMenu();
    document.getElementById('card-modal').style.display = 'none';
    document.getElementById('upload-modal').style.display = 'none';
    document.getElementById('ctx-menu').style.display = 'none';
  }
});
