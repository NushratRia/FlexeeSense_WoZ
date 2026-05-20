/* links.js — cross-modal anchor → canvas card linking
   Lines are drawn in WORLD COORDINATES inside canvas-world,
   so they zoom and pan with the canvas automatically.
   Source point  = right edge of viewer panel, converted to world coords
                   OR the exact position of the annotation mark if visible
   Target point  = left-center edge of the destination card in world coords
*/

const LINKS = {};
let _linkCounter = 0;
let _pendingLinkAnchor  = null;
let _pendingSourceEl    = null;

// ── Start a link from a viewer anchor ─────────────────────────────────────
function startLinkFromAnchor(anchor, sourceEl) {
  _pendingLinkAnchor = anchor;
  _pendingSourceEl   = sourceEl;
  showLinkIndicator(anchor);
}

function showLinkIndicator(anchor) {
  const ind = document.getElementById('link-indicator');
  ind.style.display = 'block';
  const labels = { sentence:'📄 sentence', timestamp:'🎬 timestamp', codeline:'📓 code line' };
  document.getElementById('link-indicator-text').innerHTML =
    `Linking <b>${labels[anchor.type]||anchor.type}</b>: "${truncate(anchor.label||anchor.text, 48)}"
     &mdash; click a canvas card or
     <u style="cursor:pointer;color:var(--blue)" onclick="quickLinkNewCard()">create new card</u>`;

  Object.values(_cards).forEach(c => {
    c.el.classList.add('link-target-mode');
    c.el.style.cursor = 'crosshair';
  });
  showToast('🔗 Click a canvas card to link', '#2B6CB0');
}

function cancelLink() {
  _pendingLinkAnchor = null;
  _pendingSourceEl   = null;
  document.getElementById('link-indicator').style.display = 'none';
  Object.values(_cards).forEach(c => {
    c.el.classList.remove('link-target-mode');
    c.el.style.cursor = '';
  });
}

function completeLinkToCard(cardId) {
  if (!_pendingLinkAnchor) return;
  createLink(_pendingLinkAnchor, cardId, _pendingSourceEl);
  cancelLink();
}

function quickLinkNewCard() {
  if (!_pendingLinkAnchor) return;
  const anchor = _pendingLinkAnchor;
  const srcEl  = _pendingSourceEl;
  cancelLink();
  const cardId = spawnLinkCard();
  setTimeout(() => createLink(anchor, cardId, srcEl), 60);
}

// ── Create and store a link ────────────────────────────────────────────────
function createLink(anchor, cardId, sourceEl) {
  const linkId = 'link-' + (++_linkCounter);
  const card   = _cards[cardId];
  if (!card) return;

  // Badge in card footer anchor zone
  const zone = document.getElementById('cla-' + cardId)
             || document.getElementById('cf-'  + cardId);
  if (zone) {
    const badge = document.createElement('span');
    badge.className = 'clive-anchor-badge';
    badge.id        = 'la-' + linkId;
    badge.title     = anchor.label || anchor.text;
    const icons = { sentence:'📄', timestamp:'🎬', codeline:'📓' };
    badge.innerHTML =
      `${icons[anchor.type]||'🔗'} ${truncate(anchor.label||anchor.text, 28)}
       <span onclick="removeLink('${linkId}',event)" style="opacity:.5;cursor:pointer;margin-left:3px">✕</span>`;
    badge.addEventListener('click', e => {
      if (!e.target.closest('span[onclick]')) jumpToAnchor(anchor);
    });
    zone.appendChild(badge);
  }

  // Mark source element
  if (sourceEl) markSourceLinked(sourceEl, anchor, linkId);

  // Draw the SVG line
  const lineEl = drawLinkLine(linkId, anchor, cardId, sourceEl);

  LINKS[linkId] = { linkId, anchor, cardId, lineEl, sourceEl };
  card.anchors  = card.anchors || [];
  card.anchors.push(linkId);

  document.getElementById('m-links').textContent = Object.keys(LINKS).length;
  showToast('✅ Linked ' + anchor.type + ' → card', '#1A8F6F');

  if (sourceEl) {
    sourceEl.classList.add('link-highlighted');
    setTimeout(() => sourceEl.classList.remove('link-highlighted'), 1500);
  }

  // Update timestamp count badge
  if (anchor.type === 'timestamp') {
    const cnt = document.getElementById('tslc-' + anchor.anchorId);
    if (cnt) {
      const n = Object.values(LINKS).filter(l => l.anchor.anchorId === anchor.anchorId).length;
      cnt.textContent = n + ' link' + (n !== 1 ? 's' : '');
    }
  }
}

// ── Mark the source element visually ──────────────────────────────────────
function markSourceLinked(el, anchor, linkId) {
  if (anchor.type === 'sentence') {
    el.classList.add('linked');
    if (!el.querySelector('.sentence-link-badge')) {
      const b = document.createElement('span');
      b.className = 'sentence-link-badge';
      b.id = 'slb-' + linkId;
      b.textContent = '→ canvas';
      b.addEventListener('click', e => {
        e.stopPropagation();
        const lnk = LINKS[linkId];
        if (lnk) jumpToCard(lnk.cardId);
      });
      el.appendChild(b);
    }
  } else if (anchor.type === 'codeline') {
    el.classList.add('linked');
    if (!el.querySelector('.line-link-dot')) {
      const dot = document.createElement('div');
      dot.className = 'line-link-dot';
      dot.id = 'lld-' + linkId;
      el.style.position = 'relative';
      el.appendChild(dot);
    }
  }
}

// ── SVG link line in world space ───────────────────────────────────────────
//
// The SVG lives inside #canvas-world which is translated+scaled by CSS transform.
// So we draw in WORLD COORDINATES (same units as card left/top).
// Source: we convert the viewer-side element's screen rect → world coords.
// Target: left edge of the card in world coords.
//
function drawLinkLine(linkId, anchor, cardId, sourceEl) {
  const svg  = document.getElementById('link-lines-svg');
  const defs = document.getElementById('svg-defs');
  if (!svg || !defs) return null;

  const strokeColor = {
    sentence:  '#2B6CB0',
    timestamp: '#D4850A',
    codeline:  '#6B4FBB',
  }[anchor.type] || '#6B6A66';

  // Arrow marker (one per link)
  const mid = 'arr-' + linkId;
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', mid);
  marker.setAttribute('markerWidth',  '9');
  marker.setAttribute('markerHeight', '9');
  marker.setAttribute('refX', '7');
  marker.setAttribute('refY', '3.5');
  marker.setAttribute('orient', 'auto');
  const ap = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  ap.setAttribute('d', 'M0,0 L0,7 L9,3.5 z');
  ap.setAttribute('fill', strokeColor);
  marker.appendChild(ap);
  defs.appendChild(marker);

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.id = 'lline-' + linkId;
  path.setAttribute('stroke',           strokeColor);
  path.setAttribute('stroke-width',     '2');
  path.setAttribute('fill',             'none');
  path.setAttribute('stroke-dasharray', '6 4');
  path.setAttribute('opacity',          '0.85');
  path.setAttribute('marker-end',       `url(#${mid})`);
  svg.appendChild(path);

  // Store reference so redrawLinks can update it
  if (LINKS[linkId]) LINKS[linkId].lineEl = path;

  positionLinkLine(linkId);
  return path;
}

// ── Position one line (called on every redraw) ─────────────────────────────
function positionLinkLine(linkId) {
  const link = LINKS[linkId]; if (!link) return;
  const path = link.lineEl || document.getElementById('lline-' + linkId);
  if (!path) return;
  const card = _cards[link.cardId]; if (!card) return;

  // ── Target: left-center of the card in world coords ──
  const cardEl   = card.el;
  const cardWx   = parseFloat(cardEl.style.left)  || 0;
  const cardWy   = parseFloat(cardEl.style.top)   || 0;
  const cardWw   = parseFloat(cardEl.style.width)  || 300;
  const cardWh   = parseFloat(cardEl.style.height) || 200;
  const tx = cardWx;                      // left edge
  const ty = cardWy + cardWh / 2;         // vertical centre

  // ── Source: convert the viewer-side element's screen rect → world ──
  // World coords: wx = (screenX - surfaceLeft - panX) / zoom
  const surface  = document.getElementById('canvas-surface');
  const sRect    = surface.getBoundingClientRect();

  let sx, sy;
  const srcEl = link.sourceEl;

  if (srcEl) {
    try {
      const elRect = srcEl.getBoundingClientRect();
      if (elRect.width > 0 && elRect.height > 0) {
        // Right edge of source element, vertical center
        const screenX = elRect.right;
        const screenY = elRect.top + elRect.height / 2;
        sx = (screenX - sRect.left - _panX) / _zoom;
        sy = (screenY - sRect.top  - _panY) / _zoom;
      }
    } catch (_) {}
  }

  // Fallback: right edge of viewer panel
  if (sx === undefined) {
    const viewer = document.getElementById('viewer-panel');
    const vRect  = viewer.getBoundingClientRect();
    sx = (vRect.right  - sRect.left - _panX) / _zoom;
    sy = (vRect.top + vRect.height / 2 - sRect.top - _panY) / _zoom;
  }

  // Cubic bezier: control points pull horizontally
  const cp = Math.abs(tx - sx) * 0.55;
  const cx1 = sx + cp, cy1 = sy;
  const cx2 = tx - cp, cy2 = ty;
  path.setAttribute('d', `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${tx} ${ty}`);
}

// ── Redraw all lines (called on zoom/pan/drag) ─────────────────────────────
function redrawLinks() {
  Object.keys(LINKS).forEach(positionLinkLine);
}

// ── Remove a link ─────────────────────────────────────────────────────────
function removeLink(linkId, e) {
  if (e) e.stopPropagation();
  const link = LINKS[linkId]; if (!link) return;

  // Remove SVG elements
  document.getElementById('lline-' + linkId)?.remove();
  document.getElementById('arr-'   + linkId)?.remove();  // marker lives in defs
  const defs = document.getElementById('svg-defs');
  defs?.querySelector('#arr-' + linkId)?.remove();

  // Remove badges / marks
  document.getElementById('la-'  + linkId)?.remove();
  const slb = document.getElementById('slb-' + linkId);
  if (slb) { slb.closest('.sentence-item, .pdf-annot-mark')?.classList.remove('linked'); slb.remove(); }
  const lld = document.getElementById('lld-' + linkId);
  if (lld) { lld.closest('.code-line, .cnb-line')?.classList.remove('linked'); lld.remove(); }

  // Update card anchors
  const card = _cards[link.cardId];
  if (card) card.anchors = (card.anchors||[]).filter(a => a !== linkId);

  delete LINKS[linkId];
  document.getElementById('m-links').textContent = Object.keys(LINKS).length;
  showToast('🗑 Link removed', '#6B6A66');
}

function removeLinksForCard(cardId) {
  [...((_cards[cardId]?.anchors)||[])].forEach(id => removeLink(id));
}
function removeLinksForFile(fileId) {
  Object.keys(LINKS).forEach(id => {
    if (LINKS[id]?.anchor?.fileId === fileId) removeLink(id);
  });
}
function removeLinksForAnchor(anchorId) {
  Object.keys(LINKS).forEach(id => {
    if (LINKS[id]?.anchor?.anchorId === anchorId) removeLink(id);
  });
}

// ── Navigation ────────────────────────────────────────────────────────────
function jumpToAnchor(anchor) {
  if (anchor.type === 'sentence') {
    switchViewTab('pdf', document.querySelector('[data-tab="pdf"]'));
    if (typeof _pdfLinkMode !== 'undefined' && !_pdfLinkMode) toggleLinkMode?.();
    const el = document.querySelector(`[data-sentence-id="${anchor.anchorId}"]`)
            || document.getElementById('annot-' + (anchor.annotId||anchor.anchorId) + '-mark');
    if (el) { el.scrollIntoView({ behavior:'smooth', block:'center' }); flashEl(el); }
  } else if (anchor.type === 'timestamp') {
    switchViewTab('video', document.querySelector('[data-tab="video"]'));
    const vid = document.getElementById('video-player');
    if (vid) { vid.currentTime = anchor.time; vid.play().catch(()=>{}); }
  } else if (anchor.type === 'codeline') {
    switchViewTab('notebook', document.querySelector('[data-tab="notebook"]'));
    // Try left panel first, then canvas card
    const el = document.getElementById('cl-' + anchor.anchorId)
            || document.getElementById('cnbl-' + anchor.anchorId);
    if (el) { el.scrollIntoView({ behavior:'smooth', block:'center' }); flashEl(el); }
  }
}

function jumpToCard(cardId) {
  const card = _cards[cardId]; if (!card) return;
  // Pan the canvas to bring the card into view
  const surface = document.getElementById('canvas-surface');
  const sw = surface.clientWidth;
  const sh = surface.clientHeight;
  const wx = parseFloat(card.el.style.left)  || 0;
  const wy = parseFloat(card.el.style.top)   || 0;
  const ww = parseFloat(card.el.style.width)  || 300;
  const wh = parseFloat(card.el.style.height) || 200;
  // Centre card on screen
  _panX = sw / 2 - (wx + ww / 2) * _zoom;
  _panY = sh / 2 - (wy + wh / 2) * _zoom;
  applyTransform();
  redrawLinks();
  flashEl(card.el);
}

function flashEl(el) {
  el.classList.add('link-highlighted');
  setTimeout(() => el.classList.remove('link-highlighted'), 1400);
}

// helper (also used by pdf_viewer.js / canvas.js)
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : s || ''; }
