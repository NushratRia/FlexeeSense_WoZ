/* resize.js — drag-to-resize splitters + collapse
   Fixes:
   - user-select:none on body during drag (prevents ghost white selection)
   - transition:none on panels during drag (no flash)
   - redrawLinks() called on every drag tick so connectors track the panel edge
*/
let _drag = null;

function startDrag(e, sp, axis) {
  e.preventDefault();
  sp.classList.add('dragging');

  // Prevent text-selection ghost / white flash
  document.body.style.userSelect   = 'none';
  document.body.style.webkitUserSelect = 'none';
  document.body.style.cursor       = 'col-resize';

  // Kill flex transition so no white lag during resize
  document.querySelectorAll('.panel, .viewer-panel, .canvas-panel').forEach(p => {
    p.style.transition = 'none';
  });

  const prev = sp.previousElementSibling;
  const next = sp.nextElementSibling;
  _drag = { sp, axis, prev, next, x: e.clientX, y: e.clientY };
  document.addEventListener('mousemove', _onDrag);
  document.addEventListener('mouseup',   _stopDrag);
}

function _onDrag(e) {
  if (!_drag) return;
  const { axis, prev, next } = _drag;

  if (axis === 'h') {
    const dx  = e.clientX - _drag.x;
    _drag.x   = e.clientX;
    const pw  = prev.getBoundingClientRect().width;
    const npw = Math.max(80, pw + dx);
    prev.style.flex = `0 0 ${npw}px`;
    // canvas-panel is flex:1, let it fill the rest naturally
  }

  // Redraw link lines so connectors track the viewer panel's moving right edge
  if (typeof redrawLinks === 'function') redrawLinks();
}

function _stopDrag() {
  if (_drag) {
    _drag.sp.classList.remove('dragging');
    _drag = null;
  }
  document.body.style.userSelect       = '';
  document.body.style.webkitUserSelect = '';
  document.body.style.cursor           = '';

  // Restore transitions
  document.querySelectorAll('.panel, .viewer-panel, .canvas-panel').forEach(p => {
    p.style.transition = '';
  });

  document.removeEventListener('mousemove', _onDrag);
  document.removeEventListener('mouseup',   _stopDrag);

  if (typeof redrawLinks === 'function') redrawLinks();
}

/* ── Collapse ──────────────────────────────────────────────────────────── */
const _collapseState = {};

function collapsePanel(id, axis, arrowOpen, arrowClosed) {
  const el  = document.getElementById(id);
  const btn = el.querySelector('.collapse-btn');
  const key = id + axis;
  const isOpen = !_collapseState[key];

  if (isOpen) {
    _collapseState[key + '_prev'] = el.style.flex || (el.getBoundingClientRect().width + 'px');
    el.style.flex = '0 0 42px';
    el.querySelectorAll(
      '.view-pane, .pdf-reader, .video-reader, .nb-reader, .panel-tabs, ' +
      '.canvas-surface, .canvas-files-bar, .canvas-toolbar, ' +
      '.link-indicator, .canvas-zoom-controls'
    ).forEach(c => { c._prevDisplay = c.style.display; c.style.display = 'none'; });
    if (btn) btn.textContent = arrowClosed;
    _collapseState[key] = true;
  } else {
    el.style.flex = _collapseState[key + '_prev'] || '0 0 480px';
    el.querySelectorAll(
      '.view-pane, .pdf-reader, .video-reader, .nb-reader, .panel-tabs, ' +
      '.canvas-surface, .canvas-files-bar, .canvas-toolbar, ' +
      '.link-indicator, .canvas-zoom-controls'
    ).forEach(c => { c.style.display = c._prevDisplay !== undefined ? c._prevDisplay : ''; });
    if (btn) btn.textContent = arrowOpen;
    _collapseState[key] = false;
  }

  // Redraw connectors after collapse/expand
  requestAnimationFrame(() => {
    if (typeof redrawLinks === 'function') redrawLinks();
  });
}
