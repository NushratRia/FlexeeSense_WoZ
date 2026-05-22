/*  links.js — Context-Preserving Visual Links (Steinberger et al. InfoVis 2011)

    SVG is a FIXED overlay covering the full viewport (z-index:30).
    All coordinates are in SCREEN PIXELS — no world transform needed.
    Source: getBoundingClientRect() of the annotation/highlight/code-line in the viewer.
    Target: getBoundingClientRect() of the canvas card.
    Route:  orthogonal corridor path hugging the splitter border, then smooth bezier.
    Bundle: multiple links spread vertically at the corridor.
    Glow:   SVG blur filter for halo effect.
    Label:  floating pill at path midpoint.
    Panel:  collapsible links drawer listing all links with jump/remove.
*/

const LINKS  = {};
let _linkCounter       = 0;
let _pendingLinkAnchor = null;
let _pendingSourceEl   = null;
let _linksPanelOpen    = false;

// ── Type styles ─────────────────────────────────────────────────────────────
const TYPE_STYLE = {
  sentence:  { color:'#2563EB', glow:'rgba(37,99,235,0.3)',   label:'PDF',   dash:'10 4', width:2.5, flowTo:'-42', flowDur:'1.4s' },
  timestamp: { color:'#D97706', glow:'rgba(217,119,6,0.3)',   label:'Video', dash:'7 5',  width:2.5, flowTo:'36',  flowDur:'1.0s' },
  codeline:  { color:'#7C3AED', glow:'rgba(124,58,237,0.3)',  label:'Code',  dash:'3 7',  width:2,   flowTo:'-30', flowDur:'1.8s' },
};
const FALLBACK_STYLE = { color:'#6B7280', glow:'rgba(107,114,128,0.2)', label:'Link', dash:'6 4', width:2, flowTo:'-24', flowDur:'1.2s' };

// ── Pending link state ───────────────────────────────────────────────────────
function startLinkFromAnchor(anchor, sourceEl) {
  _pendingLinkAnchor = anchor;
  _pendingSourceEl   = sourceEl;
  showLinkIndicator(anchor);
}

function showLinkIndicator(anchor) {
  const st  = TYPE_STYLE[anchor.type] || FALLBACK_STYLE;
  const ind = document.getElementById('link-indicator');
  ind.style.display = 'block';
  document.getElementById('link-indicator-text').innerHTML =
    `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${st.color};
       margin-right:5px;vertical-align:middle;box-shadow:0 0 0 3px ${st.glow}"></span>` +
    `Linking <b style="color:${st.color}">${st.label}</b>: "${_truncate(anchor.label||anchor.text, 42)}"` +
    ` — click a canvas card or ` +
    `<u style="cursor:pointer;color:${st.color}" onclick="quickLinkNewCard()">create new card</u>`;
  Object.values(_cards).forEach(c => { c.el.classList.add('link-target-mode'); c.el.style.cursor='crosshair'; });
  showToast('🔗 Click a canvas card to link', st.color);
}

function cancelLink() {
  _pendingLinkAnchor = null; _pendingSourceEl = null;
  document.getElementById('link-indicator').style.display = 'none';
  Object.values(_cards).forEach(c => { c.el.classList.remove('link-target-mode'); c.el.style.cursor=''; });
}

function completeLinkToCard(cardId) {
  if (!_pendingLinkAnchor) return;
  createLink(_pendingLinkAnchor, cardId, _pendingSourceEl);
  cancelLink();
}

function quickLinkNewCard() {
  if (!_pendingLinkAnchor) return;
  const anchor=_pendingLinkAnchor, srcEl=_pendingSourceEl;
  cancelLink();
  const cardId = spawnLinkCard();
  setTimeout(() => createLink(anchor, cardId, srcEl), 80);
}

// ── Create link ──────────────────────────────────────────────────────────────
function createLink(anchor, cardId, sourceEl) {
  const linkId = 'link-' + (++_linkCounter);
  const card   = _cards[cardId]; if (!card) return;
  const st     = TYPE_STYLE[anchor.type] || FALLBACK_STYLE;

  // Badge in card footer
  const zone = document.getElementById('cla-'+cardId) || document.getElementById('cf-'+cardId);
  if (zone) {
    const badge = document.createElement('span');
    badge.className = 'clive-anchor-badge';
    badge.id        = 'la-'+linkId;
    badge.title     = anchor.label || anchor.text;
    badge.style.cssText = `border-left:3px solid ${st.color};background:${st.glow};`;
    badge.innerHTML = `<b style="color:${st.color};margin-right:3px">${st.label}</b>`
      + _truncate(anchor.label||anchor.text, 20)
      + ` <span onclick="removeLink('${linkId}',event)" style="opacity:.45;cursor:pointer;margin-left:3px">✕</span>`;
    badge.addEventListener('click', e => { if (!e.target.closest('span[onclick]')) jumpToAnchor(anchor); });
    zone.appendChild(badge);
  }

  if (sourceEl) _markSourceLinked(sourceEl, anchor, linkId, st);

  // Build SVG
  const svgEls = _buildSVG(linkId, st, anchor);
  LINKS[linkId] = { linkId, anchor, cardId, sourceEl, st, ...svgEls };
  card.anchors  = card.anchors || [];
  card.anchors.push(linkId);

  _updateLinkCount();
  _addLinkToPanel(linkId, anchor, cardId, st);

  if (sourceEl) {
    sourceEl.classList.add('link-highlighted');
    setTimeout(() => sourceEl.classList.remove('link-highlighted'), 1600);
  }
  positionLinkLine(linkId);
  showToast(`✅ ${st.label} linked → canvas card`, st.color);
}

// ── Mark source element ──────────────────────────────────────────────────────
function _markSourceLinked(el, anchor, linkId, st) {
  el.classList.add('linked');
  if (anchor.type === 'sentence' && !el.querySelector('.sentence-link-badge')) {
    const b = document.createElement('span');
    b.className = 'sentence-link-badge'; b.id = 'slb-'+linkId;
    b.style.background = st.color; b.textContent = '→ canvas';
    b.addEventListener('click', e => { e.stopPropagation(); const lnk=LINKS[linkId]; if(lnk) jumpToCard(lnk.cardId); });
    el.appendChild(b);
  } else if (anchor.type === 'codeline' && !el.querySelector('.line-link-dot')) {
    const dot = document.createElement('div');
    dot.className = 'line-link-dot'; dot.id = 'lld-'+linkId;
    dot.style.cssText = `background:${st.color};box-shadow:0 0 0 3px ${st.glow};`;
    el.style.position = 'relative'; el.appendChild(dot);
  }
}

// ── Build SVG elements ───────────────────────────────────────────────────────
function _buildSVG(linkId, st, anchor) {
  const svg  = document.getElementById('link-lines-svg');
  const defs = document.getElementById('svg-defs');

  // Blur filter for glow
  const fid    = 'blur-'+linkId;
  const filter = document.createElementNS('http://www.w3.org/2000/svg','filter');
  filter.setAttribute('id',fid); filter.setAttribute('x','-30%'); filter.setAttribute('y','-30%');
  filter.setAttribute('width','160%'); filter.setAttribute('height','160%');
  const feBlur = document.createElementNS('http://www.w3.org/2000/svg','feGaussianBlur');
  feBlur.setAttribute('stdDeviation','3.5'); filter.appendChild(feBlur); defs.appendChild(filter);

  // Arrow marker
  const mid    = 'arr-'+linkId;
  const marker = document.createElementNS('http://www.w3.org/2000/svg','marker');
  marker.setAttribute('id',mid); marker.setAttribute('markerWidth','9');
  marker.setAttribute('markerHeight','9'); marker.setAttribute('refX','7');
  marker.setAttribute('refY','3.5'); marker.setAttribute('orient','auto');
  marker.setAttribute('markerUnits','strokeWidth');
  const ap = document.createElementNS('http://www.w3.org/2000/svg','path');
  ap.setAttribute('d','M0,0 L0,7 L9,3.5 z'); ap.setAttribute('fill',st.color);
  marker.appendChild(ap); defs.appendChild(marker);

  // Glow path
  const glowEl = document.createElementNS('http://www.w3.org/2000/svg','path');
  glowEl.id = 'lglow-'+linkId;
  glowEl.setAttribute('stroke',st.glow); glowEl.setAttribute('stroke-width', st.width+7);
  glowEl.setAttribute('fill','none'); glowEl.setAttribute('stroke-linecap','round');
  glowEl.setAttribute('filter',`url(#${fid})`); glowEl.setAttribute('opacity','0.8');
  svg.appendChild(glowEl);

  // Main path
  const pathEl = document.createElementNS('http://www.w3.org/2000/svg','path');
  pathEl.id = 'lline-'+linkId;
  pathEl.setAttribute('stroke',st.color); pathEl.setAttribute('stroke-width',st.width);
  pathEl.setAttribute('fill','none'); pathEl.setAttribute('stroke-dasharray',st.dash);
  pathEl.setAttribute('stroke-linecap','round'); pathEl.setAttribute('stroke-linejoin','round');
  pathEl.setAttribute('opacity','0.95'); pathEl.setAttribute('marker-end',`url(#${mid})`);
  // Animated flow
  const anim = document.createElementNS('http://www.w3.org/2000/svg','animate');
  anim.setAttribute('attributeName','stroke-dashoffset');
  anim.setAttribute('from','0'); anim.setAttribute('to',st.flowTo);
  anim.setAttribute('dur',st.flowDur); anim.setAttribute('repeatCount','indefinite');
  pathEl.appendChild(anim); svg.appendChild(pathEl);

  // Label group
  const labelG = document.createElementNS('http://www.w3.org/2000/svg','g');
  labelG.id = 'llabel-'+linkId; labelG.style.pointerEvents = 'none';
  const pillEl = document.createElementNS('http://www.w3.org/2000/svg','rect');
  pillEl.setAttribute('rx','5'); pillEl.setAttribute('ry','5');
  pillEl.setAttribute('fill',st.color); pillEl.setAttribute('opacity','0.92');
  const txtEl = document.createElementNS('http://www.w3.org/2000/svg','text');
  txtEl.setAttribute('fill','#fff'); txtEl.setAttribute('font-size','10');
  txtEl.setAttribute('font-family','JetBrains Mono,monospace'); txtEl.setAttribute('font-weight','600');
  txtEl.setAttribute('pointer-events','none');
  txtEl.textContent = st.label+': '+_truncate(anchor.label||anchor.text, 20);
  const midDot = document.createElementNS('http://www.w3.org/2000/svg','circle');
  midDot.setAttribute('r','4'); midDot.setAttribute('fill',st.color);
  midDot.setAttribute('stroke','#fff'); midDot.setAttribute('stroke-width','1.5');
  midDot.setAttribute('opacity','0.9');
  labelG.appendChild(midDot); labelG.appendChild(pillEl); labelG.appendChild(txtEl);
  svg.appendChild(labelG);

  return { pathEl, glowEl, labelG, pillEl, txtEl, midDot };
}

// ── Route computation (screen coordinates) ──────────────────────────────────
//
//  Source port: right edge of the annotation element (in the viewer panel)
//  Corridor:    right edge of viewer panel + splitter (the natural boundary)
//  Target port: left edge of the canvas card
//
//  Path shape: S-curve via orthogonal corridor
//    P0 (source) → horizontal exit → corridor vertical segment → horizontal entry → P3 (target)
//
function _computeRoute(sx, sy, tx, ty, linkId) {
  // Simple smooth cubic bezier — source exits rightward, target enters leftward.
  // Bundle offset: spread parallel links vertically so they don't stack.
  const allIds = Object.keys(LINKS);
  const myIdx  = allIds.indexOf(linkId);
  const offset = (myIdx - (allIds.length - 1) / 2) * 16;

  const dist = Math.abs(tx - sx);
  const cp   = Math.min(dist * 0.55, 280);

  // Shift mid-points vertically for bundle separation
  const msy = sy + offset;
  const mty = ty + offset;

  const cx1 = sx + cp, cy1 = msy;
  const cx2 = tx - cp, cy2 = mty;
  return `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${tx} ${ty}`;
}

// ── Position one link ────────────────────────────────────────────────────────
function positionLinkLine(linkId) {
  const link = LINKS[linkId]; if (!link) return;
  const { pathEl, glowEl, labelG, pillEl, txtEl, midDot } = link;
  if (!pathEl) return;
  const card = _cards[link.cardId]; if (!card) return;

  // ── Source: exits at the viewer panel's RIGHT EDGE (sx),
  //    at the vertical position of the annotation mark (sy).
  //    The mark may be scrolled; clamp sy to the visible viewer area.
  const viewer = document.getElementById('viewer-panel');
  const vr     = viewer.getBoundingClientRect();
  let sx = vr.right;  // always exit from panel right edge
  let sy = vr.top + vr.height / 2;  // default: panel vertical centre

  if (link.sourceEl) {
    try {
      const r = link.sourceEl.getBoundingClientRect();
      // Only use the mark's y if it is within the visible viewer bounds
      if (r.top >= vr.top - 4 && r.bottom <= vr.bottom + 4 && (r.width > 0 || r.height > 0)) {
        sy = r.top + r.height / 2;
      } else if (r.bottom < vr.top) {
        // mark is scrolled above — clamp to top edge with a small inset
        sy = vr.top + 14;
      } else if (r.top > vr.bottom) {
        // mark is scrolled below — clamp to bottom edge
        sy = vr.bottom - 14;
      }
    } catch(_) {}
  }

  // ── Target: left edge of canvas card in screen coords ──
  let tx, ty;
  try {
    const cr = card.el.getBoundingClientRect();
    tx = cr.left;
    ty = cr.top + cr.height/2;
  } catch(_) { return; }

  // Don't draw if card is not visible
  if (tx <= 0 || isNaN(tx)) return;

  const d = _computeRoute(sx, sy, tx, ty, linkId);
  pathEl.setAttribute('d', d);
  if (glowEl) glowEl.setAttribute('d', d);

  // Label at path midpoint using SVG geometry
  try {
    if (pathEl.getTotalLength) {
      const len  = pathEl.getTotalLength();
      const mid  = pathEl.getPointAtLength(len*0.52);
      if (midDot) { midDot.setAttribute('cx', mid.x); midDot.setAttribute('cy', mid.y); }
      const tW = txtEl?.getComputedTextLength ? Math.max(txtEl.getComputedTextLength(),52) : 70;
      const pH = 15, pad = 7;
      if (pillEl) {
        pillEl.setAttribute('x', mid.x - tW/2 - pad);
        pillEl.setAttribute('y', mid.y - pH - 3);
        pillEl.setAttribute('width',  tW + pad*2);
        pillEl.setAttribute('height', pH);
      }
      if (txtEl) {
        txtEl.setAttribute('x', mid.x - tW/2);
        txtEl.setAttribute('y', mid.y - pH/2 - 2);
      }
    }
  } catch(_) {}
}

function redrawLinks() { Object.keys(LINKS).forEach(positionLinkLine); }

// ResizeObserver keeps lines live when viewer panel is resized
document.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('resize', redrawLinks);
  const viewer = document.getElementById('viewer-panel');
  if (viewer && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(redrawLinks).observe(viewer);
  }
  document.getElementById('canvas-surface')?.addEventListener('scroll', redrawLinks);
  // Redraw when PDF, video, or notebook viewers scroll (mark positions change)
  document.getElementById('pdf-viewport-wrap')?.addEventListener('scroll', redrawLinks);
  document.getElementById('nb-content')?.addEventListener('scroll', redrawLinks);
});

// ── Links Panel ──────────────────────────────────────────────────────────────
function toggleLinksPanel() {
  _linksPanelOpen = !_linksPanelOpen;
  const panel = document.getElementById('links-panel');
  panel.classList.toggle('open', _linksPanelOpen);
  const btn = document.getElementById('links-panel-btn');
  if (btn) btn.classList.toggle('on', _linksPanelOpen);
}

function _addLinkToPanel(linkId, anchor, cardId, st) {
  document.getElementById('lp-empty').style.display = 'none';
  const body = document.getElementById('lp-body');
  const row  = document.createElement('div');
  row.className = 'lp-row';
  row.id        = 'lpr-'+linkId;
  const card    = _cards[cardId];
  const cardName = card?.fileEntry?.name || card?.type || 'card';
  row.innerHTML =
    `<div class="lp-row-color" style="background:${st.color}"></div>
     <div class="lp-row-body">
       <div class="lp-row-type" style="color:${st.color}">${st.label}</div>
       <div class="lp-row-src">"${_truncate(anchor.label||anchor.text,38)}"</div>
       <div class="lp-row-target">→ ${_truncate(cardName, 26)}</div>
     </div>
     <div class="lp-row-actions">
       <button class="lp-act-btn" title="Jump to source" onclick="jumpToAnchor(${JSON.stringify(anchor).replace(/"/g,"'")})">&#x21E6;</button>
       <button class="lp-act-btn" title="Jump to card"   onclick="jumpToCard('${cardId}')">&#x21E8;</button>
       <button class="lp-act-btn lp-del" title="Remove link" onclick="removeLink('${linkId}',event)">&#x2715;</button>
     </div>`;
  body.appendChild(row);
  _updateLinkCount();
}

function _updateLinkCount() {
  const n = Object.keys(LINKS).length;
  document.getElementById('m-links').textContent = n;
  const badge = document.getElementById('links-count-badge');
  if (badge) badge.textContent = n;
  const lpCount = document.getElementById('lp-count');
  if (lpCount) lpCount.textContent = n;
}

function removeAllLinks() {
  if (Object.keys(LINKS).length === 0) return;
  if (!confirm('Remove all links?')) return;
  [...Object.keys(LINKS)].forEach(id => removeLink(id));
}

// ── Remove one link ──────────────────────────────────────────────────────────
function removeLink(linkId, e) {
  if (e) e.stopPropagation();
  const link = LINKS[linkId]; if (!link) return;

  // Remove SVG elements
  ['lline-','lglow-','llabel-'].forEach(p => document.getElementById(p+linkId)?.remove());
  document.getElementById('svg-defs')?.querySelector('#arr-'+linkId)?.remove();
  document.getElementById('svg-defs')?.querySelector('#blur-'+linkId)?.remove();

  // Remove card badge
  document.getElementById('la-'+linkId)?.remove();

  // Remove source marks
  const slb = document.getElementById('slb-'+linkId);
  if (slb) { slb.closest('.sentence-item,.pdf-annot-mark')?.classList.remove('linked'); slb.remove(); }
  const lld = document.getElementById('lld-'+linkId);
  if (lld) { lld.closest('.code-line,.cnb-line')?.classList.remove('linked'); lld.remove(); }

  // Remove from panel
  document.getElementById('lpr-'+linkId)?.remove();

  // Update card anchors
  const card = _cards[link.cardId];
  if (card) card.anchors = (card.anchors||[]).filter(a => a !== linkId);

  delete LINKS[linkId];
  _updateLinkCount();

  // Show empty state if no links left
  if (Object.keys(LINKS).length === 0) {
    document.getElementById('lp-empty').style.display = '';
  }
  redrawLinks(); // re-bundle remaining
  showToast('🗑 Link removed','#6B7280');
}

function removeLinksForCard(cardId) {
  [...((_cards[cardId]?.anchors)||[])].forEach(id => removeLink(id));
}
function removeLinksForFile(fileId) {
  Object.keys(LINKS).forEach(id => { if(LINKS[id]?.anchor?.fileId===fileId) removeLink(id); });
}
function removeLinksForAnchor(anchorId) {
  Object.keys(LINKS).forEach(id => { if(LINKS[id]?.anchor?.anchorId===anchorId) removeLink(id); });
}

// ── Navigation ───────────────────────────────────────────────────────────────
function jumpToAnchor(anchor) {
  if (anchor.type === 'sentence') {
    switchViewTab('pdf', document.querySelector('[data-tab="pdf"]'));
    const el = document.getElementById('annot-'+(anchor.annotId||anchor.anchorId)+'-mark');
    if (el) { el.scrollIntoView({behavior:'smooth',block:'center'}); flashEl(el); }
  } else if (anchor.type === 'timestamp') {
    switchViewTab('video', document.querySelector('[data-tab="video"]'));
    const vid = document.getElementById('video-player');
    if (vid) { vid.currentTime=anchor.time; vid.play().catch(()=>{}); }
  } else if (anchor.type === 'codeline') {
    switchViewTab('notebook', document.querySelector('[data-tab="notebook"]'));
    const el = document.getElementById('cl-'+anchor.anchorId)
            || document.getElementById('cnbl-'+anchor.anchorId);
    if (el) { el.scrollIntoView({behavior:'smooth',block:'center'}); flashEl(el); }
  }
}

function jumpToCard(cardId) {
  const card = _cards[cardId]; if (!card) return;
  const surface = document.getElementById('canvas-surface');
  const sw=surface.clientWidth, sh=surface.clientHeight;
  const wx=parseFloat(card.el.style.left)||0, wy=parseFloat(card.el.style.top)||0;
  const ww=parseFloat(card.el.style.width)||300, wh=parseFloat(card.el.style.height)||200;
  _panX = sw/2-(wx+ww/2)*_zoom; _panY = sh/2-(wy+wh/2)*_zoom;
  applyTransform(); redrawLinks(); flashEl(card.el);
}

function flashEl(el) {
  el.classList.add('link-highlighted');
  setTimeout(()=>el.classList.remove('link-highlighted'),1400);
}
function _truncate(s,n){ return s&&s.length>n?s.slice(0,n)+'…':s||''; }
function truncate(s,n){ return _truncate(s,n); } // alias used by canvas.js
