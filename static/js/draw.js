/* draw.js — Full-workspace freehand draw tool
   Strokes are drawn on #draw-overlay-svg — a fixed full-viewport SVG (z-index:40)
   that covers BOTH the viewer panel and the canvas panel, so drawing works
   seamlessly across both panels.

   The overlay SVG is pointer-events:none by default (strokes always visible).
   While draw mode is active a transparent event-capture div sits on top to
   catch mouse/touch — it passes through UI element clicks so buttons still work.
*/

// ── State ─────────────────────────────────────────────────────────────────
const _strokes   = {};
let   _strokeCnt = 0;
let   _drawing   = false;
let   _curStroke = null;
let   _curGlow   = null;
let   _curPts    = [];
let   _drawColor = '#E05A3A';
let   _drawWidth = 3;
const _DRAW_TOOL = 'draw';
let   _drawActive = false;
let   _eraserMode = false;

// ── Get the persistent stroke SVG (never hidden — strokes stay visible) ───
function _getSVG() {
  const svg = document.getElementById('draw-overlay-svg');
  if (svg) {
    svg.style.display = '';        // make sure it's visible
    svg.style.pointerEvents = 'none'; // never capture events here
  }
  return svg;
}

// ── Event-capture element (transparent div, active only in draw mode) ─────
function _getCapture() {
  let cap = document.getElementById('draw-capture');
  if (!cap) {
    cap = document.createElement('div');
    cap.id = 'draw-capture';
    cap.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'width:100vw', 'height:100vh',
      'z-index:41',         // above draw-overlay-svg (z:40)
      'pointer-events:none',
      'cursor:crosshair',
      'background:transparent',
    ].join(';');
    document.body.appendChild(cap);
  }
  return cap;
}

// ── Activate / deactivate ─────────────────────────────────────────────────
function activateDrawMode() {
  _drawActive = true;
  _getSVG();  // ensure visible
  _ensureDrawBar();
  document.getElementById('draw-toolbar').style.display = '';

  const cap = _getCapture();
  cap.style.pointerEvents = 'all';
  cap.style.cursor = _eraserMode ? 'cell' : 'crosshair';

  cap.addEventListener('mousedown',  _drawStart);
  cap.addEventListener('mousemove',  _drawMove);
  cap.addEventListener('mouseup',    _drawEnd);
  cap.addEventListener('mouseleave', _drawEnd);
  cap.addEventListener('touchstart', _drawTouchStart, { passive: false });
  cap.addEventListener('touchmove',  _drawTouchMove,  { passive: false });
  cap.addEventListener('touchend',   _drawEnd);
  document.addEventListener('keydown', _drawKeyDown);
}

function deactivateDrawMode() {
  _drawActive = false;
  _drawing    = false;
  _eraserMode = false;

  const cap = document.getElementById('draw-capture');
  if (cap) {
    cap.style.pointerEvents = 'none';
    cap.style.cursor = '';
    cap.removeEventListener('mousedown',  _drawStart);
    cap.removeEventListener('mousemove',  _drawMove);
    cap.removeEventListener('mouseup',    _drawEnd);
    cap.removeEventListener('mouseleave', _drawEnd);
    cap.removeEventListener('touchstart', _drawTouchStart);
    cap.removeEventListener('touchmove',  _drawTouchMove);
    cap.removeEventListener('touchend',   _drawEnd);
  }
  document.body.style.cursor = '';
  document.removeEventListener('keydown', _drawKeyDown);
  const bar = document.getElementById('draw-toolbar');
  if (bar) bar.style.display = 'none';
  _removeEraserCircle();
}

// ── Hook setCanvasTool ────────────────────────────────────────────────────
(function() {
  const _orig = setCanvasTool;
  setCanvasTool = function(tool) {
    if (tool !== _DRAW_TOOL) deactivateDrawMode();
    _orig(tool);
    if (tool === _DRAW_TOOL) activateDrawMode();
  };
})();

function _drawKeyDown(e) {
  if (e.key === 'Escape') setCanvasTool('select');
  if (e.key === 'e' || e.key === 'E') toggleEraser();
}

// ── Mouse / touch handlers ────────────────────────────────────────────────
function _drawStart(e) {
  if (e.button !== undefined && e.button !== 0) return;

  // Check if click is on a UI element — pass through if so
  const cap = document.getElementById('draw-capture');
  cap.style.pointerEvents = 'none';
  const under = document.elementFromPoint(e.clientX, e.clientY);
  cap.style.pointerEvents = 'all';

  if (under && (
      under.closest('button, a, input, select, textarea') ||
      under.closest('.panel-header, .pdf-toolbar, .pdf-status-bar, .nb-toolbar') ||
      under.closest('.draw-toolbar, .canvas-zoom-controls, .canvas-files-bar') ||
      under.closest('.topbar, .links-panel, .ctool, .ptab, .tbtn') ||
      under.closest('.attach-dropdown, .modal, .modal-overlay') ||
      under.closest('.c-card-live, .c-sticky, video')
  )) {
    under.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true,
      clientX: e.clientX, clientY: e.clientY,
    }));
    return;
  }

  e.preventDefault();
  _drawing = true;
  const pt = { x: e.clientX, y: e.clientY };
  _curPts  = [pt];

  if (_eraserMode) {
    _eraseAt(pt.x, pt.y);
  } else {
    _beginStroke(pt.x, pt.y);
  }
}

function _drawTouchStart(e) {
  e.preventDefault();
  const t   = e.touches[0];
  const pt  = { x: t.clientX, y: t.clientY };
  _drawing  = true;
  _curPts   = [pt];
  if (_eraserMode) { _eraseAt(pt.x, pt.y); }
  else { _beginStroke(pt.x, pt.y); }
}

function _drawMove(e) {
  if (!_drawing) return;
  const pt = { x: e.clientX, y: e.clientY };
  _curPts.push(pt);
  if (_eraserMode) {
    _eraseAt(pt.x, pt.y);
    _showEraserCircle(pt.x, pt.y);
  } else {
    _updatePath(_curStroke, _curGlow, _curPts);
  }
}

function _drawTouchMove(e) {
  if (!_drawing) return;
  e.preventDefault();
  const t  = e.touches[0];
  const pt = { x: t.clientX, y: t.clientY };
  _curPts.push(pt);
  if (_eraserMode) { _eraseAt(pt.x, pt.y); }
  else { _updatePath(_curStroke, _curGlow, _curPts); }
}

function _drawEnd() {
  if (!_drawing) return;
  _drawing = false;
  _removeEraserCircle();
  if (!_eraserMode) {
    if (_curPts.length > 1) _finalizeStroke();
    else { _curStroke?.remove(); _curGlow?.remove(); }
  }
  _curStroke = null; _curGlow = null; _curPts = [];
}

// ── SVG stroke construction (screen coordinates) ──────────────────────────
function _beginStroke(x, y) {
  const svg = _getSVG();

  _curGlow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  _curGlow.setAttribute('stroke',           _hexToRgba(_drawColor, 0.25));
  _curGlow.setAttribute('stroke-width',     String(_drawWidth + 8));
  _curGlow.setAttribute('fill',             'none');
  _curGlow.setAttribute('stroke-linecap',   'round');
  _curGlow.setAttribute('stroke-linejoin',  'round');
  _curGlow.setAttribute('filter',           'blur(4px)');
  svg.appendChild(_curGlow);

  _curStroke = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  _curStroke.setAttribute('stroke',          _drawColor);
  _curStroke.setAttribute('stroke-width',    String(_drawWidth));
  _curStroke.setAttribute('fill',            'none');
  _curStroke.setAttribute('stroke-linecap',  'round');
  _curStroke.setAttribute('stroke-linejoin', 'round');
  _curStroke.setAttribute('opacity',         '0.9');
  svg.appendChild(_curStroke);
}

function _updatePath(pathEl, glowEl, pts) {
  const d = _smooth(pts);
  if (pathEl) pathEl.setAttribute('d', d);
  if (glowEl) glowEl.setAttribute('d', d);
}

function _finalizeStroke() {
  const id = 'stroke-' + (++_strokeCnt);
  _curStroke.id = id + '-path';
  _curGlow.id   = id + '-glow';

  // Right-click on the capture div won't reach the SVG path, so we add a
  // transparent hit-area div at the stroke centroid for right-click / delete
  _addHitTarget(id, _curPts);

  const linkedAnnots = _findNearbyAnnots(_curPts);
  const linkedCards  = _findNearbyCanvasCards(_curPts);

  _strokes[id] = {
    id,
    el: _curStroke, glowEl: _curGlow,
    points: [..._curPts],          // screen coords
    color:  _drawColor, width: _drawWidth,
    linkedAnnots, linkedCards,
  };

  const n = linkedAnnots.length + linkedCards.length;
  if (n > 0) showToast(`✏ Stroke grouped with ${n} element${n>1?'s':''}`, '#1A8F6F');
}

// Small invisible hit-target at stroke centroid for right-click
function _addHitTarget(strokeId, pts) {
  if (!pts.length) return;
  const cx = pts.reduce((a,p) => a+p.x, 0) / pts.length;
  const cy = pts.reduce((a,p) => a+p.y, 0) / pts.length;
  const hit = document.createElement('div');
  hit.id = strokeId + '-hit';
  hit.style.cssText = `position:fixed;left:${cx-14}px;top:${cy-14}px;width:28px;height:28px;` +
                      `border-radius:50%;z-index:42;cursor:pointer;background:transparent;`;
  hit.title = 'Right-click to remove stroke';
  hit.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    _strokeMenu(strokeId, e.clientX, e.clientY);
  });
  hit.addEventListener('dblclick', e => {
    e.preventDefault(); e.stopPropagation();
    _strokeMenu(strokeId, e.clientX, e.clientY);
  });
  document.body.appendChild(hit);
}

// ── Catmull-Rom smooth path (screen coords) ───────────────────────────────
function _smooth(pts) {
  if (pts.length < 2) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i-1)];
    const p1 = pts[i];
    const p2 = pts[i+1];
    const p3 = pts[Math.min(pts.length-1, i+2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

// ── Eraser (screen-coord hit test) ───────────────────────────────────────
const _ERASER_R = 20;

function toggleEraser() {
  setEraserMode(!_eraserMode);
}

function setEraserMode(on) {
  _eraserMode = on;
  const cap = document.getElementById('draw-capture');
  if (cap) cap.style.cursor = on ? 'cell' : 'crosshair';
  _updateEraserBtns();
}

function _updateEraserBtns() {
  const pen    = document.getElementById('draw-pen-btn');
  const eraser = document.getElementById('draw-eraser-btn');
  if (pen)    pen.classList.toggle('active',    !_eraserMode);
  if (eraser) eraser.classList.toggle('active',  _eraserMode);
}

function _eraseAt(cx, cy) {
  Object.keys(_strokes).forEach(id => {
    const s = _strokes[id]; if (!s) return;
    const hit = s.points.some(p => Math.hypot(p.x - cx, p.y - cy) <= _ERASER_R);
    if (hit) deleteStroke(id);
  });
}

function _showEraserCircle(x, y) {
  const svg = _getSVG();
  let c = document.getElementById('eraser-circle');
  if (!c) {
    c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.id = 'eraser-circle';
    c.setAttribute('fill',             'rgba(255,255,255,0.12)');
    c.setAttribute('stroke',           '#aaa');
    c.setAttribute('stroke-width',     '1.5');
    c.setAttribute('stroke-dasharray', '4 3');
    c.setAttribute('pointer-events',   'none');
    svg.appendChild(c);
  }
  c.setAttribute('r',  String(_ERASER_R));
  c.setAttribute('cx', String(x));
  c.setAttribute('cy', String(y));
}

function _removeEraserCircle() {
  document.getElementById('eraser-circle')?.remove();
}

// ── Grouping — find nearby elements ──────────────────────────────────────
const _MARGIN = 50;

function _findNearbyAnnots(pts) {
  const ids = [];
  document.querySelectorAll('.pdf-annot-mark,[data-annot-id]').forEach(el => {
    const r = el.getBoundingClientRect();
    if (_ptsNear(pts, r) && el.dataset.annotId && !ids.includes(el.dataset.annotId))
      ids.push(el.dataset.annotId);
  });
  return ids;
}

function _findNearbyCanvasCards(pts) {
  const ids = [];
  if (typeof _cards === 'undefined') return ids;
  Object.keys(_cards).forEach(cid => {
    const card = _cards[cid]; if (!card?.el) return;
    if (_ptsNear(pts, card.el.getBoundingClientRect()) && !ids.includes(cid))
      ids.push(cid);
  });
  return ids;
}

function _ptsNear(pts, r) {
  return pts.some(p =>
    p.x >= r.left - _MARGIN && p.x <= r.right  + _MARGIN &&
    p.y >= r.top  - _MARGIN && p.y <= r.bottom + _MARGIN
  );
}

// ── Move strokes with grouped elements ────────────────────────────────────
// Called by canvas.js — dx/dy are screen-px deltas (cards move in screen space)
function moveStrokesWithCard(cardId, dx, dy) {
  Object.values(_strokes).forEach(s => {
    if (!s.linkedCards.includes(cardId)) return;
    s.points = s.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
    _updatePath(s.el, s.glowEl, s.points);
    // Move hit target too
    const hit = document.getElementById(s.id + '-hit');
    if (hit) {
      hit.style.left = (parseFloat(hit.style.left) + dx) + 'px';
      hit.style.top  = (parseFloat(hit.style.top)  + dy) + 'px';
    }
  });
}

// Called when PDF annotations move (scroll/zoom)
function moveStrokesWithAnnot(annotId, newMarkEl) {
  if (!newMarkEl) return;
  const nr = newMarkEl.getBoundingClientRect();
  const mcx = nr.left + nr.width / 2, mcy = nr.top + nr.height / 2;
  Object.values(_strokes).forEach(s => {
    if (!s.linkedAnnots.includes(annotId)) return;
    const dx = mcx - (s._lastMcx || mcx);
    const dy = mcy - (s._lastMcy || mcy);
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      s.points = s.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
      _updatePath(s.el, s.glowEl, s.points);
      const hit = document.getElementById(s.id + '-hit');
      if (hit) {
        hit.style.left = (parseFloat(hit.style.left) + dx) + 'px';
        hit.style.top  = (parseFloat(hit.style.top)  + dy) + 'px';
      }
    }
    s._lastMcx = mcx; s._lastMcy = mcy;
  });
}

// ── Draw toolbar ──────────────────────────────────────────────────────────
function _ensureDrawBar() {
  if (document.getElementById('draw-toolbar')) return;
  const bar = document.createElement('div');
  bar.id        = 'draw-toolbar';
  bar.className = 'draw-toolbar';
  bar.style.display = 'none';

  const COLORS = ['#E05A3A','#D97706','#2563EB','#7C3AED','#1A8F6F','#1C1B19','#ffffff'];
  const SIZES  = [2, 4, 8, 14];

  bar.innerHTML = `
    <div class="draw-toolbar-inner">
      <button class="draw-exit-btn" onclick="setCanvasTool('select')" title="Exit draw mode (Esc)">✕ Exit Draw</button>
      <div class="draw-vsep"></div>
      <button class="draw-mode-btn active" id="draw-pen-btn"    onclick="setEraserMode(false)" title="Pen (P)">✏ Pen</button>
      <button class="draw-mode-btn"        id="draw-eraser-btn" onclick="setEraserMode(true)"  title="Eraser — drag to erase (E)">⌫ Eraser</button>
      <div class="draw-vsep"></div>
      <span class="draw-section-label">Color</span>
      <div class="draw-colors" id="draw-colors">
        ${COLORS.map(c=>`<button class="draw-color-dot${c===_drawColor?' active':''}"
            data-color="${c}"
            style="background:${c};border-color:${c==='#ffffff'?'#bbb':c}"
            onclick="setDrawColor('${c}')" title="${c}"></button>`).join('')}
        <input type="color" id="draw-color-picker" value="${_drawColor}"
          style="width:22px;height:22px;border-radius:50%;border:1px solid #bbb;cursor:pointer;padding:0;vertical-align:middle;flex-shrink:0"
          oninput="setDrawColor(this.value)" title="Custom colour">
      </div>
      <div class="draw-vsep"></div>
      <span class="draw-section-label">Size</span>
      <div class="draw-sizes" id="draw-sizes">
        ${SIZES.map(w=>`<button class="draw-size-btn${w===_drawWidth?' active':''}" onclick="setDrawWidth(${w})"
            style="display:flex;align-items:center;justify-content:center">
            <span style="display:block;width:${Math.min(w+8,20)}px;height:${w}px;background:currentColor;border-radius:${w}px;margin:auto"></span>
          </button>`).join('')}
      </div>
      <div class="draw-vsep"></div>
      <button class="draw-act-btn" onclick="undoLastStroke()"  title="Undo last stroke">↩ Undo</button>
      <button class="draw-act-btn" onclick="clearAllStrokes()" title="Clear all strokes">🗑 Clear all</button>
      <span class="draw-hint">Right-click / double-click stroke to remove · E = eraser · Esc = exit</span>
    </div>`;

  const header = document.getElementById('canvas-panel').querySelector('.panel-header');
  header.insertAdjacentElement('afterend', bar);
}

// ── Pen color & size ──────────────────────────────────────────────────────
function setDrawColor(c) {
  _drawColor = c;
  document.querySelectorAll('.draw-color-dot').forEach(b => {
    b.classList.toggle('active', b.dataset.color === c);
  });
  const picker = document.getElementById('draw-color-picker');
  if (picker && /^#[0-9a-fA-F]{6}$/.test(c)) picker.value = c;
}

function setDrawWidth(w) {
  _drawWidth = w;
  document.querySelectorAll('.draw-size-btn').forEach((b, i) => {
    b.classList.toggle('active', [2,4,8,14][i] === w);
  });
}

// ── Stroke management ─────────────────────────────────────────────────────
function _strokeMenu(strokeId, cx, cy) {
  document.getElementById('stroke-ctx')?.remove();
  const menu = document.createElement('div');
  menu.id        = 'stroke-ctx';
  menu.className = 'cpdf-annot-ctx';
  menu.style.cssText = `left:${Math.min(cx, window.innerWidth-200)}px;top:${cy}px`;
  menu.innerHTML = `
    <div class="cpdf-ctx-item" onclick="deleteStroke('${strokeId}');document.getElementById('stroke-ctx')?.remove()">🗑 Delete stroke</div>
    <div class="cpdf-ctx-item" onclick="changeStrokeColor('${strokeId}');document.getElementById('stroke-ctx')?.remove()">🎨 Change colour</div>
    <div class="cpdf-ctx-item" onclick="unlinkStroke('${strokeId}');document.getElementById('stroke-ctx')?.remove()">🔓 Ungroup</div>`;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('mousedown', e => {
    if (!e.target.closest('#stroke-ctx')) menu.remove();
  }, { once: true }), 40);
}

function deleteStroke(id) {
  _strokes[id]?.el?.remove();
  _strokes[id]?.glowEl?.remove();
  document.getElementById(id + '-hit')?.remove();
  delete _strokes[id];
  showToast('🗑 Stroke removed', '#6B7280');
}

function changeStrokeColor(id) {
  const s = _strokes[id]; if (!s) return;
  const inp = document.createElement('input');
  inp.type = 'color'; inp.value = s.color;
  inp.style.cssText = 'position:fixed;left:-999px;top:-999px;opacity:0;width:1px;height:1px';
  document.body.appendChild(inp);
  inp.addEventListener('input', () => {
    s.color = inp.value;
    s.el?.setAttribute('stroke', inp.value);
    s.glowEl?.setAttribute('stroke', _hexToRgba(inp.value, 0.25));
  });
  inp.addEventListener('change', () => { inp.remove(); showToast('🎨 Colour updated','#1A8F6F'); });
  inp.click();
}

function unlinkStroke(id) {
  if (_strokes[id]) {
    _strokes[id].linkedAnnots = [];
    _strokes[id].linkedCards  = [];
    showToast('🔓 Stroke ungrouped','#6B7280');
  }
}

function undoLastStroke() {
  const ids = Object.keys(_strokes);
  if (!ids.length) return;
  deleteStroke(ids[ids.length - 1]);
}

function clearAllStrokes() {
  if (!Object.keys(_strokes).length) return;
  if (!confirm('Clear all drawn strokes?')) return;
  [...Object.keys(_strokes)].forEach(deleteStroke);
}

// ── Utility ───────────────────────────────────────────────────────────────
function _hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
