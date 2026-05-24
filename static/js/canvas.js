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
    if (_dragCard) {
      // Check if released over the viewer panel — if so, open in viewer
      const viewer = document.getElementById('viewer-panel');
      const vr     = viewer?.getBoundingClientRect();
      const card   = _cards[_dragCard.id];
      if (vr && e.clientX >= vr.left && e.clientX <= vr.right &&
          e.clientY >= vr.top  && e.clientY <= vr.bottom &&
          card && ['pdf','video','notebook'].includes(card.type)) {
        // Open this card's file in the left viewer
        _openCardInViewer(card);
      }
      // Always clean up
      _setViewerDropHighlight(false);
      _overViewerDrop = false;
      _dragCard.style.zIndex = '';
      _dragCard = null;
      redrawLinks();
    }
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
  // Redraw link lines (they live in a fixed SVG overlay, need screen coords refresh)
  if (typeof redrawLinks === 'function') requestAnimationFrame(redrawLinks);
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
  body.style.cssText = 'background:#525659;overflow:hidden;display:flex;flex-direction:column';

  // toolbar
  const tb = document.createElement('div');
  tb.className = 'cpdf-toolbar';
  tb.innerHTML = `
    <button class="cpdf-nav" onclick="cpdfPrev('${cardId}')">‹</button>
    <span class="cpdf-info" id="cpdf-info-${cardId}">… / …</span>
    <button class="cpdf-nav" onclick="cpdfNext('${cardId}')">›</button>
    <button class="cpdf-zoom" onclick="cpdfZoom('${cardId}',-0.25)">−</button>
    <button class="cpdf-zoom" onclick="cpdfZoom('${cardId}',+0.25)">+</button>
    <div class="cpdf-sep"></div>
    <button class="cpdf-annot-btn active" id="cptool-cursor-${cardId}"   onclick="setCPdfTool('${cardId}','cursor')"    title="Select">↖</button>
    <button class="cpdf-annot-btn"        id="cptool-highlight-${cardId}" onclick="setCPdfTool('${cardId}','highlight')" title="Highlight" style="color:#D97706">🖊</button>
    <button class="cpdf-annot-btn"        id="cptool-comment-${cardId}"   onclick="setCPdfTool('${cardId}','comment')"   title="Comment"   style="color:#1A8F6F">💬</button>
    <button class="cpdf-annot-btn"        id="cptool-link-${cardId}"      onclick="setCPdfTool('${cardId}','link')"      title="Link"      style="color:#2563EB">🔗</button>`;
  body.appendChild(tb);

  // page viewport (canvas + text layer stacked)
  const pageScroll = document.createElement('div');
  pageScroll.id = 'cpdf-scroll-' + cardId;
  pageScroll.style.cssText = 'flex:1;overflow:auto;display:flex;flex-direction:column;align-items:center;gap:6px;padding:8px;min-height:0';
  body.appendChild(pageScroll);

  // annotation panel (collapsible, below pages)
  const annotPanel = document.createElement('div');
  annotPanel.id = 'cpdf-annotpanel-' + cardId;
  annotPanel.className = 'ccard-annot-panel';
  annotPanel.innerHTML = '<div class="ccard-annot-label">Annotations <span id="cpdf-annotcount-'+cardId+'">0</span></div><div class="ccard-annot-list" id="cpdf-annotlist-'+cardId+'"></div>';
  body.appendChild(annotPanel);

  renderPdfInCard(entry, cardId, pageScroll);
}

const _cpdfState = {};  // cardId -> { doc, scale, page, entry, tool, annotCounter }

async function renderPdfInCard(entry, cardId, container) {
  try {
    const doc = await pdfjsLib.getDocument(entry.path).promise;
    _cpdfState[cardId] = { doc, scale:0.85, page:1, entry, tool:'cursor', annotCounter:0 };
    container.innerHTML = '';
    document.getElementById('cpdf-info-' + cardId).textContent = `1 / ${doc.numPages}`;
    await cpdfRenderPage(cardId, 1, container);
  } catch(e) {
    container.innerHTML = `<div style="color:#fff;font-family:var(--fm);font-size:11px;padding:12px">❌ ${e.message}</div>`;
  }
}

async function cpdfRenderPage(cardId, pageNum, container) {
  const state = _cpdfState[cardId]; if (!state) return;
  container = container || document.getElementById('cpdf-scroll-' + cardId);
  container.innerHTML = '';

  const page = await state.doc.getPage(pageNum);
  const vp   = page.getViewport({ scale: state.scale });

  // Wrapper holds canvas + text layer + annot overlay
  const wrap = document.createElement('div');
  wrap.style.cssText = `position:relative;width:${vp.width}px;height:${vp.height}px;flex-shrink:0;box-shadow:0 2px 12px rgba(0,0,0,.5)`;

  // Canvas
  const canvas = document.createElement('canvas');
  canvas.width = vp.width; canvas.height = vp.height;
  canvas.style.cssText = 'display:block;position:absolute;top:0;left:0';
  wrap.appendChild(canvas);

  // Text layer for selection
  const textDiv = document.createElement('div');
  textDiv.className = 'cpdf-text-layer';
  textDiv.style.cssText = `position:absolute;top:0;left:0;width:${vp.width}px;height:${vp.height}px;overflow:hidden;pointer-events:auto;user-select:text;cursor:text`;
  wrap.appendChild(textDiv);

  // Highlight / annotation overlay
  const annotOverlay = document.createElement('div');
  annotOverlay.className = 'cpdf-annot-overlay';
  annotOverlay.dataset.cardId = cardId;
  annotOverlay.style.cssText = `position:absolute;top:0;left:0;width:${vp.width}px;height:${vp.height}px;pointer-events:none`;
  wrap.appendChild(annotOverlay);

  container.appendChild(wrap);

  await page.render({ canvasContext:canvas.getContext('2d'), viewport:vp }).promise;
  const tc = await page.getTextContent();
  pdfjsLib.renderTextLayer({ textContent:tc, container:textDiv, viewport:vp, textDivs:[] });

  state.page = pageNum;
  state.pageVp = vp;
  state.pageWrap = wrap;
  state.annotOverlay = annotOverlay;
  const info = document.getElementById('cpdf-info-' + cardId);
  if (info) info.textContent = `${pageNum} / ${state.doc.numPages}`;

  // Mouseup → show mini annotation toolbar
  textDiv.addEventListener('mouseup', (e) => {
    setTimeout(() => cpdfHandleSelection(cardId, e, annotOverlay, vp, wrap), 30);
  });
}

function cpdfPrev(cardId) { const s=_cpdfState[cardId]; if(s&&s.page>1){const c=document.getElementById('cpdf-scroll-'+cardId);if(c)cpdfRenderPage(cardId,s.page-1,c);} }
function cpdfNext(cardId) { const s=_cpdfState[cardId]; if(s&&s.page<s.doc.numPages){const c=document.getElementById('cpdf-scroll-'+cardId);if(c)cpdfRenderPage(cardId,s.page+1,c);} }
function cpdfZoom(cardId,delta) { const s=_cpdfState[cardId]; if(s){s.scale=Math.max(0.3,Math.min(3,s.scale+delta));const c=document.getElementById('cpdf-scroll-'+cardId);if(c)cpdfRenderPage(cardId,s.page,c);} }

function setCPdfTool(cardId, tool) {
  const state = _cpdfState[cardId]; if (!state) return;
  state.tool = tool;
  ['cursor','highlight','comment','link'].forEach(t => {
    const btn = document.getElementById(`cptool-${t}-${cardId}`);
    if (btn) btn.classList.toggle('active', t === tool);
  });
}

// ─── PDF card annotation on text selection ───────────────────────────────────
// Shared pending state per card
const _cpdfPending = {}; // cardId -> { text, normRects, vp, wrap }

function cpdfHandleSelection(cardId, e, annotOverlay, vp, wrap) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
  const text = sel.toString().trim();
  const state = _cpdfState[cardId]; if (!state) return;

  // Compute normalized rects relative to the page wrapper
  const pageRect = wrap.getBoundingClientRect();
  const normRects = [];
  if (sel.rangeCount) {
    Array.from(sel.getRangeAt(0).getClientRects()).forEach(r => {
      if (r.width < 1 || r.height < 1) return;
      normRects.push({
        x:(r.left-pageRect.left)/vp.width,
        y:(r.top-pageRect.top)/vp.height,
        w:r.width/vp.width, h:r.height/vp.height
      });
    });
  }
  _cpdfPending[cardId] = { text, normRects, vp, wrap, annotOverlay };

  if (state.tool === 'cursor') {
    // Show floating mini-toolbar near selection
    showCPdfMiniBar(cardId, e.clientX, e.clientY);
  } else {
    cpdfApplyAnnot(cardId, state.tool, '');
    window.getSelection()?.removeAllRanges();
  }
}

function showCPdfMiniBar(cardId, cx, cy) {
  removeCPdfMiniBar();
  const bar = document.createElement('div');
  bar.id = 'cpdf-minibar';
  bar.className = 'cpdf-minibar';
  bar.style.left = Math.max(4, cx - 80) + 'px';
  bar.style.top  = Math.max(4, cy - 48) + 'px';
  bar.innerHTML = `
    <button onclick="cpdfApplyAnnot('${cardId}','highlight','');removeCPdfMiniBar()" title="Highlight">🖊 Highlight</button>
    <button onclick="cpdfPromptComment('${cardId}');removeCPdfMiniBar()" title="Comment">💬 Comment</button>
    <button onclick="cpdfApplyAnnot('${cardId}','link','');removeCPdfMiniBar()" title="Link to canvas resource">🔗 Link</button>`;
  document.body.appendChild(bar);
  setTimeout(() => document.addEventListener('mousedown', removeCPdfMiniBarOnOut, {once:true}), 50);
}
function removeCPdfMiniBar() { document.getElementById('cpdf-minibar')?.remove(); }
function removeCPdfMiniBarOnOut(e) { if (!e.target.closest('#cpdf-minibar')) removeCPdfMiniBar(); }

function cpdfPromptComment(cardId) {
  const pen = _cpdfPending[cardId]; if (!pen) return;
  showCardCommentPopover(cardId, pen.text, (txt) => {
    cpdfApplyAnnot(cardId, 'comment', txt);
  });
  window.getSelection()?.removeAllRanges();
}

function cpdfApplyAnnot(cardId, type, comment) {
  const pen   = _cpdfPending[cardId]; if (!pen) return;
  const state = _cpdfState[cardId];   if (!state) return;
  const id    = ++state.annotCounter;
  const annotId = `cpdf-${cardId}-a${id}`;

  // Draw highlight marks on the overlay
  const { normRects, vp, wrap, annotOverlay } = pen;
  const colors = { highlight:'rgba(255,220,0,0.45)', comment:'rgba(26,143,111,0.2)', link:'rgba(37,99,235,0.18)' };
  const borders= { highlight:'rgba(212,133,10,0.8)',  comment:'rgba(26,143,111,0.7)',  link:'rgba(37,99,235,0.9)' };

  normRects.forEach((nr, ri) => {
    const mark = document.createElement('div');
    mark.className = 'cpdf-mark cpdf-mark-' + type;
    mark.style.cssText = `position:absolute;pointer-events:auto;cursor:pointer;` +
      `left:${nr.x*vp.width}px;top:${nr.y*vp.height}px;` +
      `width:${nr.w*vp.width}px;height:${nr.h*vp.height}px;` +
      `background:${colors[type]||'rgba(0,0,0,0.1)'};` +
      `border-bottom:2px solid ${borders[type]||'#888'};` +
      `mix-blend-mode:multiply;border-radius:1px;`;
    mark.dataset.annotId = annotId;
    if (ri === 0) {
      mark.id = annotId + '-mark';
      if (type === 'comment' && comment) {
        const bubble = document.createElement('div');
        bubble.className = 'cpdf-bubble';
        bubble.textContent = '💬';
        bubble.title = comment;
        bubble.onclick = (e) => { e.stopPropagation(); showInlineAnnotNote(annotId, pen.text, comment, cardId); };
        mark.style.pointerEvents = 'auto';
        mark.appendChild(bubble);
      }
      if (type === 'link') {
        const dot = document.createElement('div');
        dot.className = 'cpdf-link-dot';
        dot.onclick = (e) => { e.stopPropagation(); cpdfStartLink(cardId, annotId, pen.text); };
        mark.appendChild(dot);
        mark.onclick = () => cpdfStartLink(cardId, annotId, pen.text);
      }
      if (type === 'highlight') {
        mark.onclick = () => showCPdfAnnotMenu(cardId, annotId, pen.text, mark);
      }
    }
    annotOverlay.appendChild(mark);
  });

  // Add to annotation list panel
  addToAnnotPanel(cardId, annotId, type, pen.text, comment);

  if (type === 'link') cpdfStartLink(cardId, annotId, pen.text);
  delete _cpdfPending[cardId];
  window.getSelection()?.removeAllRanges();
}

function cpdfStartLink(cardId, annotId, text) {
  const markEl = document.getElementById(annotId + '-mark');
  const anchor = {
    type: 'sentence', fileId: _cards[cardId]?.fileEntry?.id || cardId,
    anchorId: annotId, text, label: truncate(text, 60),
    annotId, fromCard: cardId
  };
  startLinkFromAnchor(anchor, markEl);
  showToast('🔗 Click any canvas card to link this text', '#2563EB');
}

function showCPdfAnnotMenu(cardId, annotId, text, markEl) {
  const existing = document.getElementById('cpdf-annot-ctx');
  if (existing) { existing.remove(); return; }
  const r = markEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.id = 'cpdf-annot-ctx';
  menu.className = 'cpdf-annot-ctx';
  menu.style.cssText = `left:${r.left}px;top:${r.bottom+4}px`;
  menu.innerHTML = `
    <div class="cpdf-ctx-item" onclick="cpdfStartLink('${cardId}','${annotId}','${escAttr(text.slice(0,80))}');document.getElementById('cpdf-annot-ctx')?.remove()">🔗 Link to canvas resource</div>
    <div class="cpdf-ctx-item" onclick="cpdfPromptCommentOnAnnot('${cardId}','${annotId}','${escAttr(text.slice(0,80))}');document.getElementById('cpdf-annot-ctx')?.remove()">💬 Add comment</div>
    <div class="cpdf-ctx-item danger" onclick="removeAnnot('${cardId}','${annotId}');document.getElementById('cpdf-annot-ctx')?.remove()">🗑 Remove</div>`;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('mousedown', e => { if(!e.target.closest('#cpdf-annot-ctx')) menu.remove(); }, {once:true}), 40);
}

function cpdfPromptCommentOnAnnot(cardId, annotId, text) {
  _cpdfPending[cardId] = { text, normRects:[], annotOverlay:null, vp:null, wrap:null };
  showCardCommentPopover(cardId, text, (txt) => {
    const entry = { type:'comment', text, comment:txt };
    addToAnnotPanel(cardId, annotId+'-c', 'comment', text, txt);
    showToast('💬 Comment added','#1A8F6F');
    delete _cpdfPending[cardId];
  });
}

// ─── Video embed ──────────────────────────────────────────────────────────
function embedVideoCard(body, entry, cardId) {
  body.style.cssText = 'background:#000;display:flex;flex-direction:column;overflow:hidden';

  const vid = document.createElement('video');
  vid.id = 'cvid-' + cardId;
  vid.src = entry.path;
  vid.controls = true;
  vid.style.cssText = 'width:100%;flex:1;min-height:0;object-fit:contain;display:block;background:#000';
  body.appendChild(vid);

  const bar = document.createElement('div');
  bar.className = 'cvid-bar';
  bar.innerHTML = `
    <button class="cvid-ts-btn" onclick="linkCardTimestamp('${cardId}')">📍 Link timestamp</button>
    <button class="cvid-ts-btn" onclick="vidAddComment('${cardId}')">💬 Comment</button>`;
  body.appendChild(bar);

  // Annotation panel
  const ap = document.createElement('div');
  ap.id = 'cpdf-annotpanel-' + cardId;
  ap.className = 'ccard-annot-panel';
  ap.innerHTML = '<div class="ccard-annot-label">Timestamp notes <span id="cpdf-annotcount-'+cardId+'">0</span></div><div class="ccard-annot-list" id="cpdf-annotlist-'+cardId+'"></div>';
  body.appendChild(ap);
}

function linkCardTimestamp(cardId) {
  const card = _cards[cardId]; if (!card) return;
  const vid  = document.getElementById('cvid-' + cardId); if (!vid) return;
  const t = vid.currentTime;
  const anchor = {
    type:'timestamp', fileId:card.fileEntry.id,
    anchorId:`${card.fileEntry.id}-t${Math.floor(t)}`,
    time:t,
    label:`${card.fileEntry.name} @ ${fmtTime(t)}`,
    text:`Video timestamp ${fmtTime(t)}`,
    sourceCardId:cardId,
  };
  startLinkFromAnchor(anchor, vid);
}

function vidAddComment(cardId) {
  const card = _cards[cardId]; if (!card) return;
  const vid  = document.getElementById('cvid-' + cardId); if (!vid) return;
  const t    = vid.currentTime;
  const text = `@ ${fmtTime(t)}`;
  showCardCommentPopover(cardId, text, (comment) => {
    const annotId = `cvid-${cardId}-a${Date.now()}`;
    addToAnnotPanel(cardId, annotId, 'comment', text, comment);
    showToast('💬 Comment added at ' + text,'#1A8F6F');
  });
}

// ─── Notebook embed ───────────────────────────────────────────────────────
function embedNotebookCard(body, entry, cardId) {
  body.style.cssText = 'overflow:hidden;background:#FAFAF8;display:flex;flex-direction:column';

  // Toolbar
  const ntb = document.createElement('div');
  ntb.className = 'cnb-toolbar';
  ntb.innerHTML = `<span style="font-family:var(--fm);font-size:10px;color:var(--g400)">Click line:</span>
    <button class="cnb-tool-btn active" id="cnbtool-link-${cardId}"    onclick="setCNbTool('${cardId}','link')"    title="Link line">🔗 Link</button>
    <button class="cnb-tool-btn"        id="cnbtool-comment-${cardId}" onclick="setCNbTool('${cardId}','comment')" title="Comment">💬 Comment</button>
    <button class="cnb-tool-btn"        id="cnbtool-hl-${cardId}"      onclick="setCNbTool('${cardId}','hl')"      title="Highlight">🖊 Highlight</button>`;
  body.appendChild(ntb);

  const inner = document.createElement('div');
  inner.style.cssText = 'padding:8px;flex:1;overflow:auto;min-height:0';
  inner.id = 'cnb-inner-' + cardId;
  body.appendChild(inner);

  // Annotation panel
  const ap = document.createElement('div');
  ap.id = 'cpdf-annotpanel-' + cardId;
  ap.className = 'ccard-annot-panel';
  ap.innerHTML = '<div class="ccard-annot-label">Line annotations <span id="cpdf-annotcount-'+cardId+'">0</span></div><div class="ccard-annot-list" id="cpdf-annotlist-'+cardId+'"></div>';
  body.appendChild(ap);

  // Store tool state
  if (!_cnbState) window._cnbState = {};
  _cnbState[cardId] = { tool: 'link' };

  fetch(entry.path).then(r=>r.text()).then(text => {
    const ext = entry.name.split('.').pop().toLowerCase();
    if (ext==='ipynb') {
      try { renderNbInCard(JSON.parse(text), inner, entry.id, cardId); }
      catch { renderRawInCard(text, inner, entry.id, cardId, ext); }
    } else { renderRawInCard(text, inner, entry.id, cardId, ext); }
  });
}

const _cnbState = {};
function setCNbTool(cardId, tool) {
  _cnbState[cardId] = _cnbState[cardId] || {};
  _cnbState[cardId].tool = tool;
  ['link','comment','hl'].forEach(t => {
    const btn = document.getElementById(`cnbtool-${t}-${cardId}`);
    if (btn) btn.classList.toggle('active', t===tool);
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
  const tool = (_cnbState[cardId]?.tool) || 'link';
  const text  = el.dataset.text || '';
  const lineLabel = `Line ${parseInt(el.dataset.line)+1}: ${truncate(text, 50)}`;

  if (tool === 'link') {
    el.classList.add('cnb-linked');
    const anchor = {
      type:'codeline', fileId:el.dataset.fileId,
      anchorId:el.dataset.anchorId,
      cell:el.dataset.cell, line:el.dataset.line,
      text, label:lineLabel,
      sourceCardId:cardId, sourceElId:'cnbl-'+el.dataset.anchorId,
    };
    startLinkFromAnchor(anchor, el);

  } else if (tool === 'comment') {
    showCardCommentPopover(cardId, lineLabel, (comment) => {
      el.classList.add('cnb-commented');
      const bubble = document.createElement('span');
      bubble.className = 'cnb-comment-bubble';
      bubble.textContent = '💬';
      bubble.title = comment;
      bubble.onclick = (e) => { e.stopPropagation(); showInlineAnnotNote('cnb-'+cardId+'-l'+el.dataset.line, text, comment, cardId); };
      el.appendChild(bubble);
      const annotId = `cnb-${cardId}-l${el.dataset.line}`;
      addToAnnotPanel(cardId, annotId, 'comment', lineLabel, comment);
      showToast('💬 Comment added','#1A8F6F');
    });

  } else if (tool === 'hl') {
    el.classList.add('cnb-hl');
    const annotId = `cnb-hl-${cardId}-l${el.dataset.line}`;
    addToAnnotPanel(cardId, annotId, 'highlight', lineLabel, '');
    showToast('🖊 Line highlighted','#D97706');
  }
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
  const wx = (e.clientX - sRect.left - _panX) / _zoom - _dragOffX / _zoom;
  const wy = (e.clientY - sRect.top  - _panY) / _zoom - _dragOffY / _zoom;
  const cid = _dragCard.id;
  const prevRect = _dragCard.getBoundingClientRect();
  _dragCard.style.left = wx + 'px';
  _dragCard.style.top  = wy + 'px';
  if (_cards[cid]) { _cards[cid].wx = wx; _cards[cid].wy = wy; }
  const newRect = _dragCard.getBoundingClientRect();
  const sdx = newRect.left - prevRect.left;
  const sdy = newRect.top  - prevRect.top;
  if (typeof moveStrokesWithCard === 'function') moveStrokesWithCard(cid, sdx, sdy);
  if (typeof redrawLinks === 'function') redrawLinks();

  // Show drop-zone highlight when dragging over the viewer panel
  _checkViewerDropZone(e.clientX, e.clientY, cid);
}

// Track whether we're hovering the viewer drop zone
let _overViewerDrop = false;

function _checkViewerDropZone(cx, cy, cardId) {
  const viewer = document.getElementById('viewer-panel');
  if (!viewer) return;
  const vr = viewer.getBoundingClientRect();
  const card = _cards[cardId];
  // Only show for pdf/video/notebook cards (not sticky/link)
  const eligible = card && ['pdf','video','notebook'].includes(card.type);
  const inside   = eligible && cx >= vr.left && cx <= vr.right && cy >= vr.top && cy <= vr.bottom;

  if (inside !== _overViewerDrop) {
    _overViewerDrop = inside;
    _setViewerDropHighlight(inside, card?.type);
  }
}

function _setViewerDropHighlight(active, type) {
  const viewer = document.getElementById('viewer-panel');
  if (!viewer) return;

  let indicator = document.getElementById('viewer-drop-indicator');
  if (active) {
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'viewer-drop-indicator';
      indicator.style.cssText = [
        'position:absolute', 'inset:0', 'z-index:100',
        'pointer-events:none', 'border-radius:0',
        'display:flex', 'flex-direction:column',
        'align-items:center', 'justify-content:center',
        'gap:8px', 'transition:opacity .15s',
      ].join(';');
      viewer.style.position = 'relative';
      viewer.appendChild(indicator);
    }
    const colors = { pdf:'#E05A3A', video:'#D4850A', notebook:'#6B4FBB' };
    const icons  = { pdf:'📄', video:'🎬', notebook:'📓' };
    const col    = colors[type] || '#2B6CB0';
    indicator.style.cssText += `;background:${col}18;border:3px dashed ${col};`;
    indicator.innerHTML = `
      <div style="font-size:32px;line-height:1">${icons[type]||'📎'}</div>
      <div style="font-family:'Cabinet Grotesk',sans-serif;font-weight:800;font-size:15px;color:${col}">
        Drop to open in viewer
      </div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:${col};opacity:.7">
        Replaces current ${type} in left panel
      </div>`;
  } else {
    indicator?.remove();
    _overViewerDrop = false;
  }
}

// ─── Open canvas card in left viewer ────────────────────────────────────
function _openCardInViewer(card) {
  if (!card || !card.fileEntry) {
    showToast('⚠ This card has no file to open', '#D4850A');
    return;
  }
  const entry = card.fileEntry;
  // activateFile is defined in upload.js — it loads the file into the correct viewer tab
  if (typeof activateFile === 'function') {
    activateFile(entry);
    showToast('📂 Opened in viewer: ' + entry.name, '#1A8F6F');
  } else {
    showToast('⚠ Viewer not ready', '#D4850A');
  }
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

// ═══════════════════════════════════════════════════════════════════
// SHARED ANNOTATION HELPERS (for PDF / Video / Notebook cards)
// ═══════════════════════════════════════════════════════════════════

// ── Comment popover ──────────────────────────────────────────────────────────
let _commentCallback = null;

function showCardCommentPopover(cardId, refText, onSave) {
  removeCardCommentPopover();
  _commentCallback = onSave;
  const pop = document.createElement('div');
  pop.id = 'card-comment-popover';
  pop.className = 'card-comment-popover';
  // Position near card
  const card = _cards[cardId];
  let left = 200, top = 200;
  if (card) {
    const r = card.el.getBoundingClientRect();
    left = Math.min(r.right + 8, window.innerWidth - 310);
    top  = r.top + 20;
  }
  pop.style.cssText = `left:${left}px;top:${top}px`;
  pop.innerHTML = `
    <div class="ccp-header">💬 Add comment</div>
    <div class="ccp-ref">"${escHtml(truncate(refText, 60))}"</div>
    <textarea class="ccp-input" id="ccp-input" placeholder="Type your comment…" rows="3" autofocus></textarea>
    <div class="ccp-actions">
      <button class="ccp-btn secondary" onclick="removeCardCommentPopover()">Cancel</button>
      <button class="ccp-btn primary"   onclick="saveCardComment()">Add</button>
    </div>`;
  document.body.appendChild(pop);
  setTimeout(() => {
    const inp = document.getElementById('ccp-input');
    if (inp) inp.focus();
  }, 30);
}

function removeCardCommentPopover() {
  document.getElementById('card-comment-popover')?.remove();
  _commentCallback = null;
}

function saveCardComment() {
  const txt = (document.getElementById('ccp-input')?.value || '').trim();
  removeCardCommentPopover();
  if (_commentCallback) { _commentCallback(txt || '(no text)'); _commentCallback = null; }
}

// ── Annotation panel (collapsible list per card) ─────────────────────────────
const _cardAnnotStore = {}; // cardId -> [{ id, type, text, comment }]

function addToAnnotPanel(cardId, annotId, type, text, comment) {
  if (!_cardAnnotStore[cardId]) _cardAnnotStore[cardId] = [];
  _cardAnnotStore[cardId].push({ id:annotId, type, text, comment });

  const list = document.getElementById('cpdf-annotlist-' + cardId);
  if (!list) return;

  const row = document.createElement('div');
  row.className = 'ccard-annot-row';
  row.id = 'cannotr-' + annotId;

  const typeColors = { highlight:'#D97706', comment:'#1A8F6F', link:'#2563EB' };
  const typeIcons  = { highlight:'🖊', comment:'💬', link:'🔗' };
  row.innerHTML = `
    <div class="ccard-annot-strip" style="background:${typeColors[type]||'#888'}"></div>
    <div class="ccard-annot-body">
      <div class="ccard-annot-type" style="color:${typeColors[type]||'#888'}">${typeIcons[type]||'•'} ${type}</div>
      <div class="ccard-annot-text">"${escHtml(truncate(text,44))}"</div>
      ${comment ? `<div class="ccard-annot-comment">${escHtml(comment)}</div>` : ''}
    </div>
    <div class="ccard-annot-acts">
      ${type==='link'?`<button class="ccard-annot-btn" title="Jump to linked card" onclick="findAndJumpToLinkedCard('${annotId}')">→</button>`:''}
      <button class="ccard-annot-btn del" title="Remove" onclick="removeAnnot('${cardId}','${annotId}')">✕</button>
    </div>`;
  list.appendChild(row);

  // Update count badge
  const cnt = document.getElementById('cpdf-annotcount-' + cardId);
  if (cnt) cnt.textContent = (parseInt(cnt.textContent)||0) + 1;

  // Make panel visible
  const panel = document.getElementById('cpdf-annotpanel-' + cardId);
  if (panel) panel.classList.add('has-annots');
}

function removeAnnot(cardId, annotId) {
  // Remove visual marks
  document.querySelectorAll(`[data-annot-id="${annotId}"],[id="${annotId}-mark"]`).forEach(el => el.remove());
  document.getElementById('cannotr-' + annotId)?.remove();
  // Update count
  const cnt = document.getElementById('cpdf-annotcount-' + cardId);
  if (cnt) cnt.textContent = Math.max(0, (parseInt(cnt.textContent)||1) - 1);
  if (_cardAnnotStore[cardId])
    _cardAnnotStore[cardId] = _cardAnnotStore[cardId].filter(a => a.id !== annotId);
}

function findAndJumpToLinkedCard(annotId) {
  const link = Object.values(LINKS).find(l => l.anchor?.annotId === annotId || l.anchor?.anchorId === annotId);
  if (link) jumpToCard(link.cardId);
  else showToast('No canvas link found for this annotation','#D4850A');
}

// ── Inline note popup (click on 💬 bubble) ───────────────────────────────────
function showInlineAnnotNote(annotId, text, comment, cardId) {
  document.getElementById('inline-note-pop')?.remove();
  const pop = document.createElement('div');
  pop.id = 'inline-note-pop';
  pop.className = 'inline-note-pop';
  const mark = document.getElementById(annotId + '-mark');
  let left = 200, top = 200;
  if (mark) {
    const r = mark.getBoundingClientRect();
    left = Math.min(r.right + 6, window.innerWidth - 240);
    top  = r.top;
  }
  pop.style.cssText = `left:${left}px;top:${top}px`;
  pop.innerHTML = `
    <div class="inp-header">💬 Comment</div>
    <div class="inp-text">${escHtml(comment)}</div>
    <div class="inp-ref">"${escHtml(truncate(text,60))}"</div>
    <div class="inp-actions">
      <button class="ccp-btn secondary" onclick="cpdfStartLink('${cardId}','${annotId}','${escAttr(text.slice(0,80))}');document.getElementById('inline-note-pop')?.remove()">🔗 Link</button>
      <button class="ccp-btn secondary" onclick="removeAnnot('${cardId}','${annotId}');document.getElementById('inline-note-pop')?.remove()">🗑</button>
      <button class="ccp-btn primary"   onclick="document.getElementById('inline-note-pop')?.remove()">Close</button>
    </div>`;
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener('mousedown', e => {
    if (!e.target.closest('#inline-note-pop')) pop.remove();
  }, {once:true}), 40);
}

// ═══════════════════════════════════════════════════════════════════
