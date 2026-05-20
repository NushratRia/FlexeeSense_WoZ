/* canvas.js — infinite pan/zoom canvas with live PDF/Video/Notebook cards */

// ─── Canvas transform state ───────────────────────────────────────────────
let _zoom    = 1.0;       // current scale
let _panX    = 0;         // translate X (in screen px)
let _panY    = 0;         // translate Y (in screen px)
let _panning = false;
let _panStartX = 0, _panStartY = 0, _panOriginX = 0, _panOriginY = 0;
let _spaceDown = false;

// ─── Card state ───────────────────────────────────────────────────────────
let _cards       = {};
let _canvasTool  = 'select';
let _dragCard    = null;
let _dragOffX    = 0, _dragOffY    = 0;
let _resizing    = null;
let _selectedCardId = null;
let _cardCounter = 0;

const CARD_DEFAULTS = {
  pdf:      { w: 400, h: 520 },
  video:    { w: 420, h: 280 },
  notebook: { w: 380, h: 420 },
  sticky:   { w: 200, h: 160 },
  link:     { w: 260, h: 140 },
};
const STRIP_COLORS = {
  pdf: '#E05A3A', video: '#D4850A', notebook: '#6B4FBB',
  link: '#2B6CB0', sticky: '#F0C040', note: '#1A8F6F',
};

// ─── Bootstrap ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const surface  = document.getElementById('canvas-surface');
  const world    = document.getElementById('canvas-world');

  // ── Wheel zoom (pinch or Ctrl+wheel) ──
  surface.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.ctrlKey ? 0.005 : 0.001;
    const delta  = -e.deltaY * factor;
    const newZoom = Math.max(0.05, Math.min(8, _zoom * Math.exp(delta * 5)));
    // Zoom towards the cursor
    const rect = surface.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;
    _panX = mx - (mx - _panX) * (newZoom / _zoom);
    _panY = my - (my - _panY) * (newZoom / _zoom);
    _zoom = newZoom;
    applyTransform();
    redrawLinks();
  }, { passive: false });

  // ── Pan: middle-mouse or Space+drag ──
  surface.addEventListener('mousedown', e => {
    if (e.button === 1 || (e.button === 0 && _spaceDown)) {
      e.preventDefault();
      _panning    = true;
      _panStartX  = e.clientX;
      _panStartY  = e.clientY;
      _panOriginX = _panX;
      _panOriginY = _panY;
      surface.style.cursor = 'grabbing';
    }
  });

  document.addEventListener('mousemove', e => {
    if (_panning) {
      _panX = _panOriginX + (e.clientX - _panStartX);
      _panY = _panOriginY + (e.clientY - _panStartY);
      applyTransform();
      redrawLinks();
    } else if (_resizing) {
      doResize(e);
    } else if (_dragCard) {
      doDragCard(e);
    }
  });

  document.addEventListener('mouseup', e => {
    if (_panning) {
      _panning = false;
      surface.style.cursor = _spaceDown ? 'grab' : '';
    }
    if (_dragCard) { _dragCard.style.zIndex = ''; _dragCard = null; redrawLinks(); }
    if (_resizing) { _resizing = null; document.body.style.cursor = ''; document.body.style.userSelect = ''; }
  });

  // Space key for pan mode
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.target.isContentEditable && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
      _spaceDown = true;
      surface.style.cursor = 'grab';
      e.preventDefault();
    }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space') {
      _spaceDown = false;
      surface.style.cursor = '';
    }
  });

  // Zoom controls
  document.getElementById('canvas-zoom-in')?.addEventListener('click',  () => canvasZoomBtn(1.25));
  document.getElementById('canvas-zoom-out')?.addEventListener('click', () => canvasZoomBtn(0.8));
  document.getElementById('canvas-zoom-reset')?.addEventListener('click', () => {
    _zoom = 1; _panX = 0; _panY = 0;
    applyTransform(); redrawLinks();
    updateZoomLabel();
  });

  // Redraw links when canvas scrolls (if overflow is still used)
  surface.addEventListener('scroll', redrawLinks);
  window.addEventListener('resize', redrawLinks);
});

function applyTransform() {
  const world = document.getElementById('canvas-world');
  if (world) world.style.transform = `translate(${_panX}px, ${_panY}px) scale(${_zoom})`;
  updateZoomLabel();
}

function canvasZoomBtn(factor) {
  const surface = document.getElementById('canvas-surface');
  const rect    = surface.getBoundingClientRect();
  const cx      = rect.width  / 2;
  const cy      = rect.height / 2;
  const newZoom = Math.max(0.05, Math.min(8, _zoom * factor));
  _panX = cx - (cx - _panX) * (newZoom / _zoom);
  _panY = cy - (cy - _panY) * (newZoom / _zoom);
  _zoom = newZoom;
  applyTransform();
  redrawLinks();
}

function updateZoomLabel() {
  const el = document.getElementById('canvas-zoom-label');
  if (el) el.textContent = Math.round(_zoom * 100) + '%';
}

// ─── Convert screen point → world coords ─────────────────────────────────
function screenToWorld(sx, sy) {
  const surface = document.getElementById('canvas-surface');
  const rect    = surface.getBoundingClientRect();
  return {
    x: (sx - rect.left - _panX) / _zoom,
    y: (sy - rect.top  - _panY) / _zoom,
  };
}

// Convert world coords → screen point (absolute, not relative to surface)
function worldToScreen(wx, wy) {
  const surface = document.getElementById('canvas-surface');
  const rect    = surface.getBoundingClientRect();
  return {
    x: wx * _zoom + _panX + rect.left,
    y: wy * _zoom + _panY + rect.top,
  };
}

// ─── Tool selection ───────────────────────────────────────────────────────
function setCanvasTool(tool) {
  _canvasTool = tool;
  document.querySelectorAll('.ctool').forEach(b => b.classList.remove('on'));
  const btn = document.getElementById('tool-' + tool);
  if (btn) btn.classList.add('on');
  closeAttachMenu();
}
function toggleAttachMenu() { document.getElementById('attach-dropdown').classList.toggle('open'); }
function closeAttachMenu()  { document.getElementById('attach-dropdown').classList.remove('open'); }
document.addEventListener('click', e => { if (!e.target.closest('.canvas-attach-menu')) closeAttachMenu(); });

// ─── Canvas click ─────────────────────────────────────────────────────────
function canvasClick(e) {
  if (e.target.closest('.c-card-live, .c-sticky')) return;
  if (_panning) return;
  deselectAll();
  if (_canvasTool === 'sticky') {
    const wp = screenToWorld(e.clientX, e.clientY);
    createStickyCard(wp.x, wp.y);
    setCanvasTool('select');
  }
}

// ─── Attach files to canvas ───────────────────────────────────────────────
function attachToCanvas(type) {
  closeAttachMenu();
  if (type === 'link') { spawnLinkCard(); return; }
  const matching = Object.values(FILES).filter(f => f.type === type);
  if (!matching.length) {
    showToast('⚠ Upload a ' + type + ' file first', '#D4850A');
    openUploadPicker();
    return;
  }
  matching.forEach((f, i) => createLiveCard(f, 80 + i * 30, 80 + i * 20));
  setCanvasTool('select');
}

// ─── Live card factory ────────────────────────────────────────────────────
function createLiveCard(fileEntry, x, y) {
  const id  = 'card-' + (++_cardCounter);
  const type = fileEntry.type;
  const def  = CARD_DEFAULTS[type] || { w: 360, h: 300 };
  const col  = STRIP_COLORS[type]  || '#6B6A66';

  const el = document.createElement('div');
  el.className = 'c-card-live';
  el.id        = id;
  el.style.left   = (x || 60) + 'px';
  el.style.top    = (y || 60) + 'px';
  el.style.width  = def.w + 'px';
  el.style.height = def.h + 'px';

  el.innerHTML = `
    <div class="clive-header" style="border-top:3px solid ${col}">
      <span class="clive-icon">${typeIcon(type)}</span>
      <span class="clive-title" title="${escHtml(fileEntry.name)}">${escHtml(fileEntry.name)}</span>
      <div class="clive-actions">
        <button class="clive-btn" onclick="minimizeCard('${id}')" title="Minimise">─</button>
        <button class="clive-btn" onclick="maximizeCard('${id}')" title="Expand">⤢</button>
        <button class="clive-btn danger" onclick="deleteCard('${id}')" title="Remove">✕</button>
      </div>
    </div>
    <div class="clive-body" id="clive-body-${id}"></div>
    <div class="clive-footer" id="clive-footer-${id}">
      <span class="clive-type-tag clive-tag-${type}">${type}</span>
      <div class="clive-link-anchors" id="cla-${id}"></div>
    </div>
    <div class="resize-handle resize-se" data-card="${id}" data-dir="se"></div>
    <div class="resize-handle resize-e"  data-card="${id}" data-dir="e"></div>
    <div class="resize-handle resize-s"  data-card="${id}" data-dir="s"></div>`;

  const body = el.querySelector('.clive-body');
  if (type === 'pdf')           embedPdfCard(body, fileEntry, id);
  else if (type === 'video')    embedVideoCard(body, fileEntry, id);
  else if (type === 'notebook') embedNotebookCard(body, fileEntry, id);

  makeDraggableCard(el, id);
  attachResizeHandles(el, id);
  el.addEventListener('click', evt => {
    if (evt.target.closest('.clive-actions, .clive-body, .resize-handle')) return;
    selectCard(id);
    if (_pendingLinkAnchor) completeLinkToCard(id);
  });

  document.getElementById('canvas-world').appendChild(el);
  _cards[id] = { id, type, fileEntry, el, anchors: [], wx: x || 60, wy: y || 60 };
  updateCanvasSubtitle();
  showToast('✅ ' + fileEntry.name + ' added to canvas', STRIP_COLORS[type]);
  return id;
}

// ─── PDF embed ────────────────────────────────────────────────────────────
function embedPdfCard(body, entry, cardId) {
  body.style.cssText = 'background:#525659;overflow:auto;display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px';
  const tb = document.createElement('div');
  tb.className = 'cpdf-toolbar';
  tb.innerHTML = `
    <button class="cpdf-nav" onclick="cpdfPrev('${cardId}')">‹</button>
    <span class="cpdf-info" id="cpdf-info-${cardId}">… / …</span>
    <button class="cpdf-nav" onclick="cpdfNext('${cardId}')">›</button>
    <button class="cpdf-zoom" onclick="cpdfZoom('${cardId}',-0.2)">−</button>
    <button class="cpdf-zoom" onclick="cpdfZoom('${cardId}',+0.2)">+</button>`;
  body.appendChild(tb);
  const pageWrap = document.createElement('div');
  pageWrap.id = 'cpdf-pages-' + cardId;
  pageWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;flex:1;overflow-y:auto;width:100%';
  body.appendChild(pageWrap);
  renderPdfInCard(entry, cardId, pageWrap);
}

const _cpdfState = {};

async function renderPdfInCard(entry, cardId, container) {
  try {
    const doc = await pdfjsLib.getDocument(entry.path).promise;
    _cpdfState[cardId] = { doc, scale: 0.9, page: 1, entry };
    container.innerHTML = '';
    document.getElementById('cpdf-info-' + cardId).textContent = `1 / ${doc.numPages}`;
    await cpdfRenderPage(cardId, 1, container);
  } catch(e) {
    container.innerHTML = `<div style="color:#fff;font-family:var(--fm);font-size:11px;padding:12px">❌ ${e.message}</div>`;
  }
}

async function cpdfRenderPage(cardId, pageNum, container) {
  const state = _cpdfState[cardId]; if (!state) return;
  container = container || document.getElementById('cpdf-pages-' + cardId);
  container.innerHTML = '';
  const page   = await state.doc.getPage(pageNum);
  const vp     = page.getViewport({ scale: state.scale });
  const canvas = document.createElement('canvas');
  canvas.width  = vp.width;
  canvas.height = vp.height;
  canvas.style.cssText = 'box-shadow:0 2px 8px rgba(0,0,0,.4);max-width:100%;display:block';
  container.appendChild(canvas);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  state.page = pageNum;
  const info = document.getElementById('cpdf-info-' + cardId);
  if (info) info.textContent = `${pageNum} / ${state.doc.numPages}`;
}

function cpdfPrev(cardId) { const s=_cpdfState[cardId]; if(s&&s.page>1) cpdfRenderPage(cardId,s.page-1); }
function cpdfNext(cardId) { const s=_cpdfState[cardId]; if(s&&s.page<s.doc.numPages) cpdfRenderPage(cardId,s.page+1); }
function cpdfZoom(cardId, delta) { const s=_cpdfState[cardId]; if(s){s.scale=Math.max(0.3,Math.min(3,s.scale+delta)); cpdfRenderPage(cardId,s.page);} }

// ─── Video embed ──────────────────────────────────────────────────────────
function embedVideoCard(body, entry, cardId) {
  body.style.cssText = 'background:#000;display:flex;flex-direction:column';
  const vid = document.createElement('video');
  vid.id = 'cvid-' + cardId;
  vid.src = entry.path;
  vid.controls = true;
  vid.style.cssText = 'width:100%;flex:1;min-height:0;object-fit:contain;display:block;background:#000';
  body.appendChild(vid);
  const bar = document.createElement('div');
  bar.className = 'cvid-bar';
  bar.innerHTML = `<button class="cvid-ts-btn" onclick="linkCardTimestamp('${cardId}')">📍 Link this timestamp</button>`;
  body.appendChild(bar);
}

function linkCardTimestamp(cardId) {
  const card = _cards[cardId]; if (!card) return;
  const vid  = document.getElementById('cvid-' + cardId); if (!vid) return;
  const t = vid.currentTime;
  const anchor = {
    type: 'timestamp', fileId: card.fileEntry.id,
    anchorId: `${card.fileEntry.id}-t${Math.floor(t)}`,
    time: t,
    label: `${card.fileEntry.name} @ ${fmtTime(t)}`,
    text:  `Video timestamp ${fmtTime(t)}`,
    sourceCardId: cardId,  // remember which canvas card this came from
  };
  startLinkFromAnchor(anchor, vid);
}

// ─── Notebook embed ───────────────────────────────────────────────────────
function embedNotebookCard(body, entry, cardId) {
  body.style.cssText = 'overflow:auto;background:#FAFAF8';
  const inner = document.createElement('div');
  inner.style.padding = '8px';
  inner.id = 'cnb-inner-' + cardId;
  body.appendChild(inner);
  fetch(entry.path).then(r => r.text()).then(text => {
    const ext = entry.name.split('.').pop().toLowerCase();
    if (ext === 'ipynb') {
      try { renderNbInCard(JSON.parse(text), inner, entry.id, cardId); }
      catch { renderRawInCard(text, inner, entry.id, cardId, ext); }
    } else { renderRawInCard(text, inner, entry.id, cardId, ext); }
  });
}

function renderNbInCard(nb, container, fileId, cardId) {
  const cells = nb.cells || nb.worksheets?.[0]?.cells || [];
  cells.forEach((cell, ci) => {
    const ct  = cell.cell_type || 'code';
    const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
    const div = document.createElement('div');
    div.className = 'cnb-cell';
    const badge = ct === 'markdown' ? '<span class="cnb-badge cnb-md">md</span>' : '<span class="cnb-badge cnb-code">code</span>';
    if (ct === 'markdown') {
      div.innerHTML = `<div class="cnb-cell-header">${badge}</div><div class="cnb-md-body">${mdToHtml(escHtml(src))}</div>`;
    } else {
      const lines = src.split('\n').map((line, li) => {
        const anchorId = `${fileId}-c${ci}-l${li}`;
        return `<div class="cnb-line" id="cnbl-${anchorId}" data-anchor-id="${anchorId}" data-file-id="${fileId}" data-cell="${ci}" data-line="${li}" data-text="${escAttr(line)}" onclick="onCanvasCodeLineClick(this,'${cardId}')">
          <span class="cnb-lnum">${li+1}</span><span class="cnb-lcode">${syntaxHL(escHtml(line))}</span></div>`;
      }).join('');
      const outputs = cell.outputs || [];
      const outText = outputs.map(o => {
        if (o.output_type==='stream') return Array.isArray(o.text)?o.text.join(''):(o.text||'');
        const t=o.data?.['text/plain']; return Array.isArray(t)?t.join(''):(t||'');
      }).filter(Boolean).join('\n');
      div.innerHTML = `<div class="cnb-cell-header">${badge}<span class="cnb-num">[${ci+1}]</span></div>
        <div class="cnb-code-wrap">${lines}</div>
        ${outText?`<div class="cnb-output">${escHtml(outText)}</div>`:''}`;
    }
    container.appendChild(div);
  });
}

function renderRawInCard(text, container, fileId, cardId, ext) {
  const lines = text.split('\n').map((line, li) => {
    const anchorId = `${fileId}-c0-l${li}`;
    return `<div class="cnb-line" id="cnbl-${anchorId}" data-anchor-id="${anchorId}" data-file-id="${fileId}" data-cell="0" data-line="${li}" data-text="${escAttr(line)}" onclick="onCanvasCodeLineClick(this,'${cardId}')">
      <span class="cnb-lnum">${li+1}</span><span class="cnb-lcode">${syntaxHL(escHtml(line))}</span></div>`;
  }).join('');
  container.innerHTML = `<div class="cnb-cell"><div class="cnb-cell-header"><span class="cnb-badge cnb-code">${ext}</span></div><div class="cnb-code-wrap">${lines}</div></div>`;
}

function onCanvasCodeLineClick(el, cardId) {
  el.classList.add('cnb-linked');
  const anchor = {
    type: 'codeline', fileId: el.dataset.fileId,
    anchorId: el.dataset.anchorId,
    cell: el.dataset.cell, line: el.dataset.line,
    text: el.dataset.text,
    label: `Line ${parseInt(el.dataset.line)+1}: ${truncate(el.dataset.text, 50)}`,
    sourceCardId: cardId,
    sourceElId: 'cnbl-' + el.dataset.anchorId,
  };
  startLinkFromAnchor(anchor, el);
}

// ─── Sticky card ──────────────────────────────────────────────────────────
function createStickyCard(x, y, text = '') {
  const id  = 'sticky-' + (++_cardCounter);
  const el  = document.createElement('div');
  el.className = 'c-sticky sticky-yellow';
  el.id   = id;
  el.style.left = x + 'px';
  el.style.top  = y + 'px';

  const colors = [
    {cls:'sticky-yellow',bg:'#FFF9C4'},{cls:'sticky-blue',bg:'#EBF4FF'},
    {cls:'sticky-teal',bg:'#E1F3EE'},{cls:'sticky-pink',bg:'#FFE4E8'},
  ];
  const dots = colors.map(c =>
    `<span class="sticky-dot" style="background:${c.bg}" onclick="event.stopPropagation();this.closest('.c-sticky').className='c-sticky ${c.cls}'"></span>`
  ).join('');

  el.innerHTML = `
    <div class="sticky-chrome">
      <div class="sticky-dots">${dots}</div>
      <button class="sticky-del" onclick="deleteCard('${id}')">✕</button>
    </div>
    <div class="sticky-content" contenteditable="true" spellcheck="false">${text||'Click to edit…'}</div>
    <div class="resize-handle resize-se" data-card="${id}" data-dir="se"></div>`;

  makeDraggableCard(el, id);
  attachResizeHandles(el, id);
  el.addEventListener('click', evt => {
    if (evt.target.closest('.sticky-chrome,.resize-handle')) return;
    selectCard(id);
    if (_pendingLinkAnchor) completeLinkToCard(id);
  });

  document.getElementById('canvas-world').appendChild(el);
  _cards[id] = { id, type:'sticky', el, anchors:[], wx: x, wy: y };
  setTimeout(() => el.querySelector('.sticky-content')?.focus(), 50);
  updateCanvasSubtitle();
  return id;
}

// ─── Link card ────────────────────────────────────────────────────────────
function spawnLinkCard() {
  const id = 'card-' + (++_cardCounter);
  const x  = 80 + Math.random()*120, y = 80 + Math.random()*80;
  const el = document.createElement('div');
  el.className = 'c-card-live c-link-card';
  el.id = id;
  el.style.left = x+'px'; el.style.top = y+'px';
  el.style.width = '260px'; el.style.height = '140px';
  el.innerHTML = `
    <div class="clive-header" style="border-top:3px solid #2B6CB0">
      <span class="clive-icon">🔗</span>
      <span class="clive-title">Cross-modal Link</span>
      <div class="clive-actions">
        <button class="clive-btn danger" onclick="deleteCard('${id}')">✕</button>
      </div>
    </div>
    <div class="clive-body" style="padding:10px;font-family:var(--fm);font-size:11px;color:var(--ink-3);display:flex;flex-direction:column;gap:6px">
      <div style="font-style:italic">Connect PDF ↔ Video ↔ Code</div>
      <div style="font-size:10px;color:var(--ink-4)">Link anchors from the viewer appear below</div>
    </div>
    <div class="clive-footer" id="clive-footer-${id}">
      <span class="clive-type-tag clive-tag-link">link</span>
      <div class="clive-link-anchors" id="cla-${id}"></div>
    </div>
    <div class="resize-handle resize-se" data-card="${id}" data-dir="se"></div>`;
  makeDraggableCard(el, id);
  attachResizeHandles(el, id);
  el.addEventListener('click', evt => {
    if (evt.target.closest('.clive-actions,.resize-handle')) return;
    selectCard(id);
    if (_pendingLinkAnchor) completeLinkToCard(id);
  });
  document.getElementById('canvas-world').appendChild(el);
  _cards[id] = { id, type:'link', el, anchors:[], wx: x, wy: y };
  updateCanvasSubtitle();
  showToast('🔗 Link card created','#2B6CB0');
  return id;
}

// ─── Minimize / maximize ──────────────────────────────────────────────────
function minimizeCard(id) {
  const card = _cards[id]; if (!card) return;
  const body   = document.getElementById('clive-body-' + id);
  const footer = document.getElementById('clive-footer-' + id);
  const mini   = card.el.dataset.minimized === '1';
  if (!mini) {
    card._savedH = card.el.style.height;
    card.el.style.height = '38px';
    card.el.style.overflow = 'hidden';
    card.el.dataset.minimized = '1';
  } else {
    card.el.style.height = card._savedH || '300px';
    card.el.style.overflow = '';
    card.el.dataset.minimized = '0';
  }
  redrawLinks();
}

function maximizeCard(id) {
  const surface = document.getElementById('canvas-surface');
  const card = _cards[id]; if (!card) return;
  const max = card.el.dataset.maximized === '1';
  if (!max) {
    card._savedStyle = { left:card.el.style.left, top:card.el.style.top, width:card.el.style.width, height:card.el.style.height, zIndex:card.el.style.zIndex };
    // Size in world coords that fills the screen
    const sw = surface.clientWidth  / _zoom;
    const sh = surface.clientHeight / _zoom;
    card.el.style.left   = (-_panX / _zoom + 10) + 'px';
    card.el.style.top    = (-_panY / _zoom + 10) + 'px';
    card.el.style.width  = (sw - 20) + 'px';
    card.el.style.height = (sh - 20) + 'px';
    card.el.style.zIndex = 500;
    card.el.dataset.maximized = '1';
    if (card.type === 'pdf') cpdfRenderPage(id, _cpdfState[id]?.page || 1);
  } else {
    Object.assign(card.el.style, card._savedStyle);
    card.el.dataset.maximized = '0';
    if (card.type === 'pdf') cpdfRenderPage(id, _cpdfState[id]?.page || 1);
  }
  redrawLinks();
}

// ─── Drag cards (in world space) ──────────────────────────────────────────
function makeDraggableCard(el, id) {
  el.addEventListener('mousedown', e => {
    if (e.target.closest('.clive-body,.clive-actions,.sticky-content,.sticky-chrome,.resize-handle,button,video,canvas,input,textarea')) return;
    if (_spaceDown) return;
    _dragCard = el;
    const rect = el.getBoundingClientRect();
    // offset in screen px, will be divided by zoom when applying
    _dragOffX = (e.clientX - rect.left);
    _dragOffY = (e.clientY - rect.top);
    el.style.zIndex = 200;
    e.preventDefault();
  });
}

function doDragCard(e) {
  if (!_dragCard) return;
  const surface = document.getElementById('canvas-surface');
  const sRect   = surface.getBoundingClientRect();
  // Convert mouse position to world coords, accounting for the drag offset
  const wx = (e.clientX - sRect.left - _panX) / _zoom - _dragOffX / _zoom;
  const wy = (e.clientY - sRect.top  - _panY) / _zoom - _dragOffY / _zoom;
  _dragCard.style.left = Math.max(0, wx) + 'px';
  _dragCard.style.top  = Math.max(0, wy) + 'px';
  const cid = _dragCard.id;
  if (_cards[cid]) { _cards[cid].wx = wx; _cards[cid].wy = wy; }
  redrawLinks();
}

// ─── Resize ───────────────────────────────────────────────────────────────
function attachResizeHandles(el, id) {
  el.querySelectorAll('.resize-handle').forEach(h => {
    h.addEventListener('mousedown', e => {
      e.stopPropagation(); e.preventDefault();
      const rect = el.getBoundingClientRect();
      _resizing = {
        el, id, dir: h.dataset.dir,
        startX: e.clientX, startY: e.clientY,
        startW: rect.width  / _zoom,   // store in world px
        startH: rect.height / _zoom,
        startL: parseFloat(el.style.left) || 0,
        startT: parseFloat(el.style.top)  || 0,
      };
      document.body.style.cursor = 'se-resize';
      document.body.style.userSelect = 'none';
    });
  });
}

function doResize(e) {
  const { el, dir, startX, startY, startW, startH } = _resizing;
  const dx = (e.clientX - startX) / _zoom;   // delta in world px
  const dy = (e.clientY - startY) / _zoom;
  if (dir==='se'||dir==='e') el.style.width  = Math.max(180, startW + dx) + 'px';
  if (dir==='se'||dir==='s') el.style.height = Math.max(80,  startH + dy) + 'px';
  redrawLinks();
}

// ─── Selection ────────────────────────────────────────────────────────────
function selectCard(id) {
  deselectAll();
  _selectedCardId = id;
  _cards[id]?.el.classList.add('selected');
  if (_pendingLinkAnchor) completeLinkToCard(id);
}
function deselectAll() {
  _selectedCardId = null;
  document.querySelectorAll('.c-card-live.selected,.c-sticky.selected').forEach(el => el.classList.remove('selected'));
}

function deleteCard(id) {
  const card = _cards[id]; if (!card) return;
  card.el.remove();
  delete _cards[id];
  delete _cpdfState[id];
  removeLinksForCard(id);
  updateCanvasSubtitle();
  showToast('🗑 Card removed','#6B6A66');
}

function clearCanvas() {
  if (!confirm('Clear all canvas elements?')) return;
  Object.keys(_cards).forEach(id => _cards[id].el.remove());
  _cards = {};
  _cardCounter = 0;
  Object.keys(_cpdfState).forEach(k => delete _cpdfState[k]);
  document.getElementById('link-lines-svg').innerHTML = '<defs id="svg-defs"></defs>';
  updateCanvasSubtitle();
}

function updateCanvasSubtitle() {
  const n = Object.keys(_cards).length;
  document.getElementById('canvas-subtitle').textContent = n + ' element' + (n!==1?'s':'');
}

// ─── Card editor ─────────────────────────────────────────────────────────
function openCardEditor(id) {
  document.getElementById('modal-title').textContent = 'Edit Card';
  document.getElementById('modal-body').innerHTML = `
    <div class="field-group">
      <div class="field-label">Notes</div>
      <textarea class="field-input field-textarea" id="edit-excerpt" rows="4"></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeCardModal()">Cancel</button>
      <button class="btn-primary" onclick="closeCardModal()">Save</button>
    </div>`;
  document.getElementById('card-modal').style.display = 'flex';
}
function closeCardModal(e) {
  if (e && e.target !== document.getElementById('card-modal')) return;
  document.getElementById('card-modal').style.display = 'none';
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function typeIcon(t)  { return {pdf:'📄',video:'🎬',notebook:'📓',link:'🔗',sticky:'📌'}[t]||'📎'; }
function fmtTime(s)   { const m=Math.floor(s/60),sec=Math.floor(s%60); return `${m}:${sec<10?'0':''}${sec}`; }
function truncate(s,n){ return s&&s.length>n?s.slice(0,n)+'…':s||''; }
function escHtml(s)   { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s)   { return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function syntaxHL(c)  {
  return c
    .replace(/\b(import|from|as|def|class|return|if|else|elif|for|while|in|not|and|or|True|False|None|with|try|except|finally|raise|yield|lambda|pass|break|continue)\b/g,'<span class="kw">$1</span>')
    .replace(/(#[^\n<]*)/g,'<span class="cm">$1</span>')
    .replace(/(&quot;.*?&quot;|&#39;.*?&#39;)/g,'<span class="st">$1</span>');
}
function mdToHtml(md) {
  return md
    .replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/`(.+?)`/g,'<code>$1</code>').replace(/\n/g,'<br>');
}
