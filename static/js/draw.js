/* draw.js — Full-workspace freehand draw tool
   Strokes are drawn on a fixed SVG overlay (#draw-overlay-svg) that covers
   the entire viewport — so you can draw across the left PDF/video/notebook
   panel AND the canvas panel seamlessly.

   When a stroke is completed near a PDF annotation mark or canvas card,
   it is "grouped" with those elements so it moves when they move
   (cards drag → strokes follow; PDF scroll → stroke positions redraw).
*/

// ── State ─────────────────────────────────────────────────────────────────
const _strokes    = {};
let   _strokeCnt  = 0;
let   _drawing    = false;
let   _curStroke  = null;
let   _curGlow    = null;
let   _curPts     = [];
let   _drawColor  = '#E05A3A';
let   _drawWidth  = 3;
const _DRAW_TOOL  = 'draw';
let   _drawActive = false;
let   _eraserMode = false;   // true = eraser, false = pen

// ── Activate / deactivate ─────────────────────────────────────────────────
function activateDrawMode() {
  _drawActive = true;
  const svg = document.getElementById('draw-overlay-svg');
  svg.style.display       = '';
  svg.style.pointerEvents = 'all';
  _updateCursor();
  _ensureDrawBar();
  document.getElementById('draw-toolbar').style.display = '';

  svg.addEventListener('mousedown',  _drawStart);
  svg.addEventListener('mousemove',  _drawMove);
  svg.addEventListener('mouseup',    _drawEnd);
  svg.addEventListener('mouseleave', _drawEnd);
  svg.addEventListener('touchstart', _drawTouchStart, { passive: false });
  svg.addEventListener('touchmove',  _drawTouchMove,  { passive: false });
  svg.addEventListener('touchend',   _drawEnd);
  document.addEventListener('keydown', _drawKeyDown);
}

function deactivateDrawMode() {
  _drawActive = false;
  _drawing    = false;
  _eraserMode = false;
  const svg = document.getElementById('draw-overlay-svg');
  if (svg) {
    svg.style.pointerEvents = 'none';
    svg.style.display = 'none';
    svg.removeEventListener('mousedown',  _drawStart);
    svg.removeEventListener('mousemove',  _drawMove);
    svg.removeEventListener('mouseup',    _drawEnd);
    svg.removeEventListener('mouseleave', _drawEnd);
    svg.removeEventListener('touchstart', _drawTouchStart);
    svg.removeEventListener('touchmove',  _drawTouchMove);
    svg.removeEventListener('touchend',   _drawEnd);
  }
  document.body.style.cursor = '';
  document.removeEventListener('keydown', _drawKeyDown);
  const bar = document.getElementById('draw-toolbar');
  if (bar) bar.style.display = 'none';
}

function _updateCursor() {
  document.body.style.cursor = _eraserMode ? 'cell' : 'crosshair';
}

// ── Hook setCanvasTool ────────────────────────────────────────────────────
(function() {
  const _orig = setCanvasTool;
  setCanvasTool = function(tool) {
    if (tool !== _DRAW_TOOL) {
      deactivateDrawMode();
    }
    _orig(tool);
    if (tool === _DRAW_TOOL) {
      activateDrawMode();
    }
  };
})();

function _drawKeyDown(e) {
  if (e.key === 'Escape') setCanvasTool('select');
  if (e.key === 'e' || e.key === 'E') toggleEraser();
}

// ── Mouse/touch handlers ──────────────────────────────────────────────────
function _drawStart(e) {
  if (e.button !== undefined && e.button !== 0) return;

  // Pass through clicks on UI elements (toolbar buttons, cards, etc.)
  const svg = document.getElementById('draw-overlay-svg');
  svg.style.pointerEvents = 'none';
  const under = document.elementFromPoint(e.clientX, e.clientY);
  svg.style.pointerEvents = 'all';

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
      clientX: e.clientX, clientY: e.clientY
    }));
    return;
  }

  e.preventDefault();
  _drawing = true;
  const _sp0 = _screenToWorld(e.clientX, e.clientY);
  _curPts  = [_sp0];

  if (_eraserMode) {
    _eraseAtWorld(_sp0.x, _sp0.y);
  } else {
    _beginStroke(e.clientX, e.clientY);
  }
}

function _drawTouchStart(e) {
  e.preventDefault();
  const t = e.touches[0];
  _drawing = true;
  const _tp0 = _screenToWorld(t.clientX, t.clientY);
  _curPts  = [_tp0];
  if (_eraserMode) {
    _eraseAtWorld(_tp0.x, _tp0.y);
  } else {
    _beginStroke(t.clientX, t.clientY);
  }
}

function _drawMove(e) {
  if (!_drawing) return;
  const pt = _screenToWorld(e.clientX, e.clientY);
  _curPts.push(pt);
  if (_eraserMode) {
    _eraseAtWorld(pt.x, pt.y);
    _showEraserCircle(e.clientX, e.clientY);  // eraser circle stays in screen coords (overlay)
  } else {
    _updateStrokePath(_curStroke, _curGlow, _curPts);
  }
}

function _drawTouchMove(e) {
  if (!_drawing) return;
  e.preventDefault();
  const t = e.touches[0];
  const pt = _screenToWorld(t.clientX, t.clientY);
  _curPts.push(pt);
  if (_eraserMode) {
    _eraseAtWorld(pt.x, pt.y);
  } else {
    _updateStrokePath(_curStroke, _curGlow, _curPts);
  }
}

function _drawEnd() {
  if (!_drawing) return;
  _drawing = false;
  _removeEraserCircle();
  if (!_eraserMode) {
    if (_curPts.length > 1) {
      _finalizeStroke();
    } else {
      _curStroke?.remove(); _curGlow?.remove();
    }
  }
  _curStroke = null; _curGlow = null; _curPts = [];
}

// ── World-coordinate SVG (inside canvas-world, so it pans/zooms with canvas) ──
function _getCanvasSVG() {
  let svg = document.getElementById('draw-canvas-svg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'draw-canvas-svg';
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;pointer-events:none';
    const world = document.getElementById('canvas-world');
    if (world) world.appendChild(svg);
  }
  return svg;
}

// Convert screen px → canvas-world coordinates
function _screenToWorld(sx, sy) {
  // _panX, _panY, _zoom are globals from canvas.js
  const px = (typeof _panX !== 'undefined') ? _panX : 0;
  const py = (typeof _panY !== 'undefined') ? _panY : 0;
  const z  = (typeof _zoom !== 'undefined') ? _zoom : 1;
  const surface = document.getElementById('canvas-surface');
  const r = surface ? surface.getBoundingClientRect() : { left:0, top:0 };
  return {
    x: (sx - r.left - px) / z,
    y: (sy - r.top  - py) / z,
  };
}

// ── SVG path construction ─────────────────────────────────────────────────
function _beginStroke(x, y) {
  const svg = _getCanvasSVG();  // draw inside canvas-world

  _curGlow = document.createElementNS('http://www.w3.org/2000/svg','path');
  _curGlow.setAttribute('stroke', _hexToRgba(_drawColor, 0.25));
  _curGlow.setAttribute('stroke-width', _drawWidth + 8);
  _curGlow.setAttribute('fill','none');
  _curGlow.setAttribute('stroke-linecap','round');
  _curGlow.setAttribute('stroke-linejoin','round');
  _curGlow.setAttribute('filter', 'blur(4px)');
  svg.appendChild(_curGlow);

  _curStroke = document.createElementNS('http://www.w3.org/2000/svg','path');
  _curStroke.setAttribute('stroke',          _drawColor);
  _curStroke.setAttribute('stroke-width',    _drawWidth);
  _curStroke.setAttribute('fill',            'none');
  _curStroke.setAttribute('stroke-linecap',  'round');
  _curStroke.setAttribute('stroke-linejoin', 'round');
  _curStroke.setAttribute('opacity',         '0.9');
  svg.appendChild(_curStroke);
}

function _updateStrokePath(pathEl, glowEl, pts) {
  const d = _ptsToPath(pts);
  if (pathEl) pathEl.setAttribute('d', d);
  if (glowEl) glowEl.setAttribute('d', d);
}

function _finalizeStroke() {
  const id = 'stroke-' + (++_strokeCnt);
  _curStroke.id = id + '-path';
  _curGlow.id   = id + '-glow';

  _curStroke.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    _showStrokeMenu(id, e.clientX, e.clientY);
  });

  const linkedAnnots = _findNearbyAnnots(_curPts);
  const linkedCards  = _findNearbyCanvasCards(_curPts);

  _strokes[id] = {
    id, el: _curStroke, glowEl: _curGlow,
    points: [..._curPts],
    color: _drawColor, width: _drawWidth,
    linkedAnnots, linkedCards,
  };

  const groups = linkedAnnots.length + linkedCards.length;
  if (groups > 0) showToast(`✏ Stroke grouped with ${groups} element${groups>1?'s':''}`, '#1A8F6F');
}

// ── Catmull-Rom smooth path ────────────────────────────────────────────────
function _ptsToPath(pts) {
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
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

// ── Eraser ────────────────────────────────────────────────────────────────
const _ERASER_R = 20;  // eraser radius in px

function toggleEraser() {
  _eraserMode = !_eraserMode;
  _updateCursor();
  _updateEraserBtn();
}

function setEraserMode(on) {
  _eraserMode = on;
  _updateCursor();
  _updateEraserBtn();
}

function _updateEraserBtn() {
  const penBtn    = document.getElementById('draw-pen-btn');
  const eraserBtn = document.getElementById('draw-eraser-btn');
  if (penBtn)    penBtn.classList.toggle('active',    !_eraserMode);
  if (eraserBtn) eraserBtn.classList.toggle('active',  _eraserMode);
}

// Erase strokes whose world-coord path passes within eraser radius (in world units)
function _eraseAtWorld(wx, wy) {
  // Convert eraser radius from screen px to world units
  const z   = (typeof _zoom !== 'undefined' && _zoom > 0) ? _zoom : 1;
  const r_w = _ERASER_R / z;
  Object.keys(_strokes).forEach(id => {
    const s = _strokes[id];
    if (!s || !s.el) return;
    const hit = s.points.some(p => Math.hypot(p.x - wx, p.y - wy) <= r_w);
    if (hit) {
      s.el?.remove();
      s.glowEl?.remove();
      delete _strokes[id];
    }
  });
}

// Visual eraser circle that follows the cursor
function _showEraserCircle(x, y) {
  let circle = document.getElementById('eraser-circle');
  if (!circle) {
    circle = document.createElementNS('http://www.w3.org/2000/svg','circle');
    circle.id = 'eraser-circle';
    circle.setAttribute('r',           _ERASER_R);
    circle.setAttribute('fill',        'rgba(255,255,255,0.15)');
    circle.setAttribute('stroke',      '#999');
    circle.setAttribute('stroke-width','1.5');
    circle.setAttribute('stroke-dasharray','4 3');
    circle.setAttribute('pointer-events','none');
    document.getElementById('draw-overlay-svg').appendChild(circle);
  }
  circle.setAttribute('cx', x);
  circle.setAttribute('cy', y);
}

function _removeEraserCircle() {
  document.getElementById('eraser-circle')?.remove();
}

// ── Find nearby elements ──────────────────────────────────────────────────
const _MARGIN = 50;

function _findNearbyAnnots(pts) {
  const annotEls = document.querySelectorAll('.pdf-annot-mark, .annot-highlight, .annot-link, .annot-comment');
  const ids = [];
  annotEls.forEach(el => {
    const r = el.getBoundingClientRect();
    if (_ptsNearRect(pts, r, _MARGIN)) {
      const aid = el.dataset.annotId || el.id?.replace('-mark','')?.replace('annot-','');
      if (aid && !ids.includes(aid)) ids.push(aid);
    }
  });
  return ids;
}

function _findNearbyCanvasCards(pts) {
  const ids = [];
  Object.keys(_cards).forEach(cid => {
    const card = _cards[cid]; if (!card) return;
    const r = card.el.getBoundingClientRect();
    if (_ptsNearRect(pts, r, _MARGIN) && !ids.includes(cid)) ids.push(cid);
  });
  return ids;
}

function _ptsNearRect(pts, r, margin) {
  return pts.some(p =>
    p.x >= r.left - margin && p.x <= r.right  + margin &&
    p.y >= r.top  - margin && p.y <= r.bottom + margin
  );
}

// ── Move strokes with grouped elements ────────────────────────────────────
function moveStrokesWithCard(cardId, dx, dy) {
  // dx/dy come in as screen-px deltas; convert to world units
  const z  = (typeof _zoom !== 'undefined' && _zoom > 0) ? _zoom : 1;
  const wx = dx / z, wy = dy / z;
  Object.values(_strokes).forEach(s => {
    if (!s.linkedCards.includes(cardId)) return;
    s.points = s.points.map(p => ({ x: p.x + wx, y: p.y + wy }));
    _updateStrokePath(s.el, s.glowEl, s.points);
  });
}

function moveStrokesWithAnnot(annotId, newMarkEl) {
  if (!newMarkEl) return;
  const nr = newMarkEl.getBoundingClientRect();
  const z  = (typeof _zoom !== 'undefined' && _zoom > 0) ? _zoom : 1;
  Object.values(_strokes).forEach(s => {
    if (!s.linkedAnnots.includes(annotId)) return;
    const markCx = nr.left + nr.width/2;
    const markCy = nr.top  + nr.height/2;
    const dxScreen = markCx - (s._lastMarkCx || markCx);
    const dyScreen = markCy - (s._lastMarkCy || markCy);
    if (Math.abs(dxScreen) > 0.5 || Math.abs(dyScreen) > 0.5) {
      const dx = dxScreen / z, dy = dyScreen / z;
      s.points = s.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
      _updateStrokePath(s.el, s.glowEl, s.points);
    }
    s._lastMarkCx = markCx; s._lastMarkCy = markCy;
  });
}

// ── Draw toolbar ──────────────────────────────────────────────────────────
function _ensureDrawBar() {
  if (document.getElementById('draw-toolbar')) return;
  const bar = document.createElement('div');
  bar.id = 'draw-toolbar';
  bar.className = 'draw-toolbar';
  bar.style.display = 'none';

  const colors = ['#E05A3A','#D97706','#2563EB','#7C3AED','#1A8F6F','#1C1B19','#ffffff'];
  const sizes  = [2, 4, 8, 14];

  bar.innerHTML = `
    <div class="draw-toolbar-inner">

      <button class="draw-exit-btn" onclick="setCanvasTool('select')" title="Exit draw mode (Esc)">
        ✕ Exit Draw
      </button>

      <div class="draw-vsep"></div>

      <button class="draw-mode-btn active" id="draw-pen-btn"
        onclick="setEraserMode(false)" title="Pen tool">
        ✏ Pen
      </button>
      <button class="draw-mode-btn" id="draw-eraser-btn"
        onclick="setEraserMode(true)" title="Eraser tool — drag over strokes to erase (E)">
        ◻ Eraser
      </button>

      <div class="draw-vsep"></div>

      <span class="draw-section-label">Color</span>
      <div class="draw-colors" id="draw-colors">
        ${colors.map(c => `<button class="draw-color-dot ${c===_drawColor?'active':''}"
            data-color="${c}"
            style="background:${c};border-color:${c==='#ffffff'?'#bbb':c}"
            onclick="setDrawColor('${c}')" title="${c}"></button>`).join('')}
        <input type="color" id="draw-color-picker" value="${_drawColor}"
          style="width:22px;height:22px;border-radius:50%;border:1px solid #bbb;
                 cursor:pointer;padding:0;vertical-align:middle;flex-shrink:0"
          oninput="setDrawColor(this.value)" title="Custom colour">
      </div>

      <div class="draw-vsep"></div>

      <span class="draw-section-label">Size</span>
      <div class="draw-sizes" id="draw-sizes">
        ${sizes.map(w => `<button class="draw-size-btn ${w===_drawWidth?'active':''}"
            onclick="setDrawWidth(${w})"
            style="display:flex;align-items:center;justify-content:center">
            <span style="display:block;width:${Math.min(w+8,20)}px;height:${w}px;
                         background:currentColor;border-radius:${w}px;margin:auto"></span>
          </button>`).join('')}
      </div>

      <div class="draw-vsep"></div>

      <button class="draw-act-btn" onclick="undoLastStroke()" title="Undo last stroke">↩ Undo</button>
      <button class="draw-act-btn" onclick="clearAllStrokes()" title="Clear all strokes">🗑 Clear all</button>

      <span class="draw-hint">Right-click stroke to remove · E = eraser · Esc to exit</span>
    </div>`;

  const cp     = document.getElementById('canvas-panel');
  const header = cp.querySelector('.panel-header');
  header.insertAdjacentElement('afterend', bar);
}

// ── Pen color & size controls ─────────────────────────────────────────────
function setDrawColor(c) {
  _drawColor = c;
  document.querySelectorAll('.draw-color-dot').forEach(b => {
    b.classList.toggle('active', b.dataset.color === c);
  });
  const picker = document.getElementById('draw-color-picker');
  if (picker && c.startsWith('#') && c.length === 7) picker.value = c;
}

function setDrawWidth(w) {
  _drawWidth = w;
  document.querySelectorAll('.draw-size-btn').forEach((b, i) => {
    b.classList.toggle('active', [2,4,8,14][i] === w);
  });
}

// ── Stroke management ─────────────────────────────────────────────────────
function _showStrokeMenu(strokeId, cx, cy) {
  document.getElementById('stroke-ctx')?.remove();
  const menu = document.createElement('div');
  menu.id = 'stroke-ctx';
  menu.className = 'cpdf-annot-ctx';
  menu.style.cssText = `left:${cx}px;top:${cy}px`;
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
  delete _strokes[id];
  showToast('🗑 Stroke removed', '#6B7280');
}

function changeStrokeColor(id) {
  const s = _strokes[id]; if (!s) return;
  const inp = document.createElement('input');
  inp.type = 'color';
  inp.value = s.color;
  inp.style.cssText = 'position:fixed;left:-999px;top:-999px;opacity:0;width:1px;height:1px';
  document.body.appendChild(inp);
  inp.addEventListener('input', () => {
    s.color = inp.value;
    if (s.el)     s.el.setAttribute('stroke', inp.value);
    if (s.glowEl) s.glowEl.setAttribute('stroke', _hexToRgba(inp.value, 0.25));
  });
  inp.addEventListener('change', () => { inp.remove(); showToast('🎨 Colour updated', '#1A8F6F'); });
  inp.click();
}

function unlinkStroke(id) {
  if (_strokes[id]) {
    _strokes[id].linkedAnnots = [];
    _strokes[id].linkedCards  = [];
    showToast('🔓 Stroke ungrouped', '#6B7280');
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
  Object.keys(_strokes).forEach(deleteStroke);
}

// ── Utility ───────────────────────────────────────────────────────────────
function _hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
