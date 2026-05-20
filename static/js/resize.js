/* resize.js — drag-to-resize splitters + collapse */
let _drag = null;

function startDrag(e, sp, axis) {
  e.preventDefault();
  sp.classList.add('dragging');
  const prev = sp.previousElementSibling;
  const next = sp.nextElementSibling;
  _drag = { sp, axis, prev, next, x: e.clientX, y: e.clientY };
  document.addEventListener('mousemove', _onDrag);
  document.addEventListener('mouseup', _stopDrag);
}

function _onDrag(e) {
  if (!_drag) return;
  const { axis, prev, next } = _drag;
  if (axis === 'h') {
    const dx = e.clientX - _drag.x; _drag.x = e.clientX;
    const pw = prev.getBoundingClientRect().width;
    const nw = next.getBoundingClientRect().width;
    const npw = Math.max(60, pw + dx);
    const nnw = Math.max(60, nw - dx);
    if (npw >= 60 && nnw >= 60) {
      prev.style.flex = `0 0 ${npw}px`;
      if (next.style.flex.startsWith('1')) { /* flex:1 canvas, don't touch */ }
      else next.style.flex = `0 0 ${nnw}px`;
    }
  }
}

function _stopDrag() {
  if (_drag) { _drag.sp.classList.remove('dragging'); _drag = null; }
  document.removeEventListener('mousemove', _onDrag);
  document.removeEventListener('mouseup', _stopDrag);
}

/* collapse helpers */
const _collapseState = {};

function collapsePanel(id, axis, arrowOpen, arrowClosed) {
  const el = document.getElementById(id);
  const btn = el.querySelector('.collapse-btn');
  const key = id + axis;
  const isOpen = !_collapseState[key];

  if (isOpen) {
    _collapseState[key + '_prev'] = el.style.flex || el.getBoundingClientRect().width + 'px';
    el.style.flex = '0 0 42px'; // just show header
    // hide everything below header
    el.querySelectorAll('.view-pane, .pdf-loaded, .nb-loaded, .video-loaded, .panel-tabs, .canvas-surface, .canvas-files-bar, .canvas-toolbar, .link-indicator').forEach(c => { c._prevDisplay = c.style.display; c.style.display = 'none'; });
    if (btn) btn.textContent = arrowClosed;
    _collapseState[key] = true;
  } else {
    el.style.flex = _collapseState[key + '_prev'] || '0 0 480px';
    el.querySelectorAll('.view-pane, .pdf-loaded, .nb-loaded, .video-loaded, .panel-tabs, .canvas-surface, .canvas-files-bar, .canvas-toolbar, .link-indicator').forEach(c => { c.style.display = c._prevDisplay !== undefined ? c._prevDisplay : ''; });
    if (btn) btn.textContent = arrowOpen;
    _collapseState[key] = false;
  }
}
