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

// ── RESET ──
function resetSession() {
  if (!confirm('Reset session? All uploads and links will be cleared.')) return;
  // Remove all files
  Object.keys(FILES).forEach(id => removeFile(id));
  // Remove all links
  Object.keys(LINKS).forEach(id => removeLink(id));
  // Clear canvas
  Object.keys(_cards).forEach(id => { _cards[id].el.remove(); });
  Object.assign(_cards, {});
  _cardCounter = 0;
  document.getElementById('link-lines-svg').innerHTML = '';
  document.getElementById('canvas-subtitle').textContent = '0 elements';
  // Reset metrics
  ['m-ctx','m-dei','m-links','m-files'].forEach(id => document.getElementById(id).textContent = '0');
  _sessionSec = 0;
  showToast('↺ Session reset', '#6B6A66');
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
