/* pdf_viewer.js — Adobe-style PDF viewer with persistent annotations across zoom */

// ─── State ─────────────────────────────────────────────────────────────────
let _pdfDoc      = null;
let _pdfEntry    = null;
let _pdfScale    = 1.4;
let _pdfTool     = 'cursor';
let _pdfPages    = [];        // { num, wrap, canvas, textDiv, annotDiv, vp, baseVp }
let _currentPage = 1;
let _selectionEventsAttached = false;

// Annotations: stored with NORMALIZED rects (0..1 relative to base viewport at scale=1)
// so they survive zoom perfectly.
// shape: { id, type, pageNum, text, normRects:[{x,y,w,h}], comment, scale }
const PDF_ANNOTS = {};
let _annotCounter = 0;

// Pending selection state
let _pendingText    = '';
let _pendingPageNum = 1;
let _pendingNormRects = [];   // normalized rects at current scale
let _pendingAnnotType = null;

// ─── Entry point ───────────────────────────────────────────────────────────
async function loadPdfViewer(entry) {
  _pdfEntry    = entry;
  _pdfDoc      = null;
  _pdfPages    = [];
  _currentPage = 1;

  document.getElementById('dz-pdf').style.display      = 'none';
  document.getElementById('pdf-reader').style.display  = 'flex';
  document.getElementById('pdf-name-label').textContent = entry.name;
  document.getElementById('viewer-filename').textContent = entry.name;
  document.getElementById('pdf-pages-container').innerHTML = '';
  setPdfTool('cursor');

  showToast('⏳ Rendering PDF…', '#2B6CB0');

  try {
    _pdfDoc = await pdfjsLib.getDocument(entry.path).promise;
    document.getElementById('pdf-total-pages').textContent = _pdfDoc.numPages;
    document.getElementById('pdf-cur-page').textContent    = 1;
    await renderAllPages();
    if (!_selectionEventsAttached) {
      setupPageSelectionEvents();
      _selectionEventsAttached = true;
    }
    showToast('✅ PDF ready — select text to annotate', '#1A8F6F');
  } catch (err) {
    showToast('❌ Could not render PDF: ' + err.message, '#E05A3A');
    console.error(err);
  }
}

// ─── Render all pages ──────────────────────────────────────────────────────
async function renderAllPages() {
  const container = document.getElementById('pdf-pages-container');
  container.innerHTML = '';
  _pdfPages = [];

  for (let num = 1; num <= _pdfDoc.numPages; num++) {
    const page   = await _pdfDoc.getPage(num);
    const vp     = page.getViewport({ scale: _pdfScale });
    const baseVp = page.getViewport({ scale: 1.0 });  // for normalization

    // Wrapper div — size matches rendered canvas
    const wrap = document.createElement('div');
    wrap.className    = 'pdf-page-wrap';
    wrap.dataset.page = num;
    wrap.style.width  = vp.width  + 'px';
    wrap.style.height = vp.height + 'px';
    wrap.style.position = 'relative';

    // Page number badge
    const badge = document.createElement('div');
    badge.className   = 'pdf-page-badge';
    badge.textContent = num;
    wrap.appendChild(badge);

    // Canvas (rendered PDF page)
    const canvas = document.createElement('canvas');
    canvas.width  = vp.width;
    canvas.height = vp.height;
    canvas.className = 'pdf-canvas';
    wrap.appendChild(canvas);

    // Text layer (for selection)
    const textDiv = document.createElement('div');
    textDiv.className  = 'pdf-text-layer';
    textDiv.style.width  = vp.width  + 'px';
    textDiv.style.height = vp.height + 'px';
    wrap.appendChild(textDiv);

    // Annotation layer (highlights, comments, links)
    const annotDiv = document.createElement('div');
    annotDiv.className        = 'pdf-page-annot-layer';
    annotDiv.dataset.page     = num;
    annotDiv.style.width      = vp.width  + 'px';
    annotDiv.style.height     = vp.height + 'px';
    annotDiv.style.position   = 'absolute';
    annotDiv.style.top        = '0';
    annotDiv.style.left       = '0';
    annotDiv.style.pointerEvents = 'none';  // clicks fall through to text layer
    wrap.appendChild(annotDiv);

    container.appendChild(wrap);
    _pdfPages.push({ num, wrap, canvas, textDiv, annotDiv, vp, baseVp, page });

    // Render PDF content onto canvas
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    // Render text layer (PDF.js built-in)
    const textContent = await page.getTextContent();
    pdfjsLib.renderTextLayer({
      textContent,
      container: textDiv,
      viewport:  vp,
      textDivs:  [],
    });
  }

  // Re-draw all existing annotations at the new scale
  reApplyAllAnnotations();
}

// ─── Zoom ──────────────────────────────────────────────────────────────────
async function pdfZoom(delta) {
  const scrollEl  = document.getElementById('pdf-viewport-wrap');
  const prevScrollRatio = scrollEl.scrollTop / (scrollEl.scrollHeight || 1);

  _pdfScale = Math.max(0.4, Math.min(3.5, _pdfScale + delta));
  document.getElementById('pdf-zoom-label').textContent = Math.round(_pdfScale * 100) + '%';

  await renderAllPages();   // re-renders pages AND calls reApplyAllAnnotations

  // Restore scroll position proportionally
  requestAnimationFrame(() => {
    scrollEl.scrollTop = prevScrollRatio * scrollEl.scrollHeight;
  });
}

// ─── Re-apply all annotations at current scale ────────────────────────────
function reApplyAllAnnotations() {
  Object.values(PDF_ANNOTS).forEach(annot => {
    // Remove old marks
    document.querySelectorAll(`[data-annot-id="${annot.id}"]`).forEach(el => el.remove());
    // Recompute pixel rects from normalized coords at current scale
    renderAnnotationFromNorm(annot);
  });
}

// ─── Navigation ────────────────────────────────────────────────────────────
function pdfPrevPage() { if (_currentPage > 1) scrollToPage(_currentPage - 1); }
function pdfNextPage() { if (_pdfDoc && _currentPage < _pdfDoc.numPages) scrollToPage(_currentPage + 1); }

function scrollToPage(num) {
  _currentPage = num;
  document.getElementById('pdf-cur-page').textContent = num;
  const wrap = document.querySelector(`.pdf-page-wrap[data-page="${num}"]`);
  if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Track current page on scroll
document.addEventListener('DOMContentLoaded', () => {
  const vpWrap = document.getElementById('pdf-viewport-wrap');
  if (vpWrap) {
    vpWrap.addEventListener('scroll', () => {
      const wraps  = document.querySelectorAll('.pdf-page-wrap');
      const vpTop  = vpWrap.scrollTop;
      let best = 1;
      wraps.forEach(w => { if (w.offsetTop <= vpTop + 80) best = parseInt(w.dataset.page); });
      if (best !== _currentPage) {
        _currentPage = best;
        document.getElementById('pdf-cur-page').textContent = best;
      }
    });
  }
});

// ─── Tool selection ────────────────────────────────────────────────────────
const TOOL_LABELS = {
  cursor:    '↖ Select — choose text then pick an action from the popup',
  highlight: '🖊 Highlight — select text and release to apply yellow highlight',
  comment:   '💬 Comment — select text and release to add a comment',
  link:      '🔗 Link — select text and release to link it to a canvas card',
};

function setPdfTool(tool) {
  _pdfTool = tool;
  document.querySelectorAll('.pdf-tool-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('ptool-' + tool);
  if (btn) btn.classList.add('active');
  const vpWrap = document.getElementById('pdf-viewport-wrap');
  if (vpWrap) vpWrap.style.cursor = tool === 'link' ? 'crosshair' : 'text';
  const msg = document.getElementById('pdf-status-msg');
  if (msg) msg.textContent = TOOL_LABELS[tool] || '';
  hideAnnotTooltip();
}

// ─── Text selection events ─────────────────────────────────────────────────
function setupPageSelectionEvents() {
  const vpWrap = document.getElementById('pdf-viewport-wrap');

  vpWrap.addEventListener('mouseup', e => {
    setTimeout(() => handleTextSelection(e), 40);
  });

  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#annot-tooltip') &&
        !e.target.closest('#comment-popover') &&
        !e.target.closest('.hl-menu')) {
      hideAnnotTooltip();
    }
  });
}

function handleTextSelection(e) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    hideAnnotTooltip();
    return;
  }

  const selectedText = sel.toString().trim();
  if (!selectedText) return;

  // Find which page wrap the selection lives on
  let pageWrap = null;
  let node = sel.anchorNode;
  while (node) {
    if (node.nodeType === 1 && node.classList?.contains('pdf-page-wrap')) { pageWrap = node; break; }
    node = node.parentElement;
  }
  if (!pageWrap && sel.rangeCount) {
    let el = sel.getRangeAt(0).commonAncestorContainer;
    while (el) {
      if (el.nodeType === 1 && el.classList?.contains('pdf-page-wrap')) { pageWrap = el; break; }
      el = el.parentElement;
    }
  }

  const pageNum = pageWrap ? parseInt(pageWrap.dataset.page) : 1;
  const pageInfo = _pdfPages.find(p => p.num === pageNum);

  // Compute NORMALIZED rects relative to the page element
  const normRects = [];
  if (pageInfo && sel.rangeCount) {
    const range     = sel.getRangeAt(0);
    const pageRect  = pageInfo.wrap.getBoundingClientRect();
    const pageW     = pageInfo.vp.width;
    const pageH     = pageInfo.vp.height;
    Array.from(range.getClientRects()).forEach(r => {
      if (r.width < 1 || r.height < 1) return;
      normRects.push({
        x: (r.left - pageRect.left) / pageW,
        y: (r.top  - pageRect.top)  / pageH,
        w: r.width  / pageW,
        h: r.height / pageH,
      });
    });
  }

  _pendingText      = selectedText;
  _pendingPageNum   = pageNum;
  _pendingNormRects = normRects;

  if (_pdfTool === 'cursor') {
    showAnnotTooltip(e.clientX, e.clientY);
  } else {
    applyAnnotation(_pdfTool);
    window.getSelection()?.removeAllRanges();
  }
}

// ─── Annotation tooltip ────────────────────────────────────────────────────
function showAnnotTooltip(x, y) {
  const tt = document.getElementById('annot-tooltip');
  tt.style.display = 'flex';
  const ttH = 42;
  tt.style.left = Math.max(4, Math.min(x - 60, window.innerWidth - 240)) + 'px';
  tt.style.top  = Math.max(4, y - ttH - 10) + 'px';
}
function hideAnnotTooltip() {
  document.getElementById('annot-tooltip').style.display = 'none';
}

// ─── Apply annotation ──────────────────────────────────────────────────────
function applyAnnotation(type) {
  hideAnnotTooltip();
  if (!_pendingNormRects.length && !_pendingText) {
    showToast('⚠ Select text first', '#D4850A');
    return;
  }
  if (type === 'comment') {
    _pendingAnnotType = 'comment';
    openCommentPopover();
  } else {
    commitAnnotation(type, '');
  }
  window.getSelection()?.removeAllRanges();
}

function commitAnnotation(type, comment) {
  const id = 'annot-' + (++_annotCounter);
  const annot = {
    id, type,
    pageNum:    _pendingPageNum,
    text:       _pendingText,
    normRects:  _pendingNormRects,   // ← normalized, scale-independent
    comment,
  };
  PDF_ANNOTS[id] = annot;
  renderAnnotationFromNorm(annot);

  if (type === 'link') {
    const anchor = {
      type:    'sentence',
      fileId:  _pdfEntry.id,
      anchorId: id,
      text:    _pendingText,
      label:   truncate(_pendingText, 60),
      annotId: id,
    };
    const markEl = document.getElementById('annot-' + id + '-mark');
    startLinkFromAnchor(anchor, markEl);
  } else {
    showToast(type === 'highlight' ? '🖊 Highlighted' : '💬 Comment added', '#1A8F6F');
  }
  clearPendingAnnot();
}

function clearPendingAnnot() {
  _pendingText      = '';
  _pendingPageNum   = 1;
  _pendingNormRects = [];
  _pendingAnnotType = null;
}

// ─── Render annotation from normalized coords ──────────────────────────────
function renderAnnotationFromNorm(annot) {
  const pageInfo = _pdfPages.find(p => p.num === annot.pageNum);
  if (!pageInfo) return;

  const layer = pageInfo.annotDiv;
  const pageW = pageInfo.vp.width;
  const pageH = pageInfo.vp.height;

  annot.normRects.forEach((nr, ri) => {
    // Convert normalized → pixel at current scale
    const px = nr.x * pageW;
    const py = nr.y * pageH;
    const pw = nr.w * pageW;
    const ph = nr.h * pageH;

    const mark = document.createElement('div');
    mark.className       = 'pdf-annot-mark annot-' + annot.type;
    mark.style.left      = px + 'px';
    mark.style.top       = py + 'px';
    mark.style.width     = pw + 'px';
    mark.style.height    = ph + 'px';
    mark.style.position  = 'absolute';
    mark.style.pointerEvents = 'auto';
    mark.dataset.annotId = annot.id;
    if (ri === 0) mark.id = 'annot-' + annot.id + '-mark';

    // Comment bubble icon
    if (annot.type === 'comment' && ri === 0) {
      const bubble = document.createElement('div');
      bubble.className   = 'comment-bubble-icon';
      bubble.textContent = '💬';
      bubble.title       = annot.comment;
      bubble.dataset.annotId = annot.id;
      bubble.addEventListener('click', e => {
        e.stopPropagation();
        showCommentBubble(annot, bubble);
      });
      mark.appendChild(bubble);
    }

    // Link dot
    if (annot.type === 'link' && ri === 0) {
      const dot = document.createElement('div');
      dot.className      = 'link-annot-dot';
      dot.title          = 'Linked to canvas — click to jump';
      dot.dataset.annotId = annot.id;
      dot.addEventListener('click', e => {
        e.stopPropagation();
        jumpToLinkedCard(annot.id);
      });
      mark.appendChild(dot);
    }

    // Highlight click → context menu
    mark.addEventListener('click', e => {
      if (annot.type === 'highlight') showHighlightMenu(annot, mark, e);
    });

    layer.appendChild(mark);
  });
}

// ─── Highlight context menu ────────────────────────────────────────────────
function showHighlightMenu(annot, el, e) {
  document.getElementById('hl-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'hl-menu';
  menu.className = 'hl-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top  = (e.clientY - 64) + 'px';
  menu.innerHTML = `
    <div class="hl-menu-item" onclick="linkAnnotToCanvas('${annot.id}')">&#x1F517; Link to canvas</div>
    <div class="hl-menu-item" onclick="addCommentToAnnot('${annot.id}')">&#x1F4AC; Add comment</div>
    <div class="hl-menu-item danger" onclick="deleteAnnotation('${annot.id}')">&#x1F5D1; Delete highlight</div>`;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 50);
}

function linkAnnotToCanvas(annotId) {
  document.getElementById('hl-menu')?.remove();
  const annot = PDF_ANNOTS[annotId]; if (!annot) return;
  const anchor = {
    type:     'sentence',
    fileId:   _pdfEntry.id,
    anchorId: annotId,
    text:     annot.text,
    label:    truncate(annot.text, 60),
    annotId,
  };
  const markEl = document.getElementById('annot-' + annotId + '-mark');
  startLinkFromAnchor(anchor, markEl);
}

function addCommentToAnnot(annotId) {
  document.getElementById('hl-menu')?.remove();
  const annot = PDF_ANNOTS[annotId]; if (!annot) return;
  _pendingText      = annot.text;
  _pendingNormRects = annot.normRects;
  _pendingPageNum   = annot.pageNum;
  _pendingAnnotType = 'comment';
  deleteAnnotation(annotId);
  openCommentPopover();
}

function showCommentBubble(annot, triggerEl) {
  const existing = document.getElementById('comment-bubble-popup');
  if (existing) { existing.remove(); return; }
  const popup = document.createElement('div');
  popup.id        = 'comment-bubble-popup';
  popup.className = 'comment-bubble-popup';
  const rect = triggerEl.getBoundingClientRect();
  popup.style.left = Math.min(rect.right + 8, window.innerWidth - 260) + 'px';
  popup.style.top  = rect.top + 'px';
  popup.innerHTML = `
    <div class="cbp-header">Comment</div>
    <div class="cbp-text">${escHtml(annot.comment)}</div>
    <div class="cbp-excerpt">"${escHtml(truncate(annot.text, 80))}"</div>
    <div class="cbp-actions">
      <button class="btn-secondary" style="font-size:10px;padding:3px 8px"
        onclick="linkAnnotToCanvas('${annot.id}');document.getElementById('comment-bubble-popup')?.remove()">
        &#x1F517; Link
      </button>
      <button class="btn-secondary" style="font-size:10px;padding:3px 8px;color:var(--coral)"
        onclick="deleteAnnotation('${annot.id}');document.getElementById('comment-bubble-popup')?.remove()">
        &#x1F5D1;
      </button>
    </div>`;
  document.body.appendChild(popup);
  setTimeout(() => document.addEventListener('click', e => {
    if (!e.target.closest('#comment-bubble-popup')) popup.remove();
  }, { once: true }), 60);
}

function deleteAnnotation(id) {
  delete PDF_ANNOTS[id];
  document.querySelectorAll(`[data-annot-id="${id}"]`).forEach(el => el.remove());
}

// ─── Comment popover ───────────────────────────────────────────────────────
function openCommentPopover() {
  const pop = document.getElementById('comment-popover');
  pop.style.display = 'block';
  const r = document.getElementById('pdf-viewport-wrap').getBoundingClientRect();
  pop.style.left = (r.left + r.width / 2 - 150) + 'px';
  pop.style.top  = (r.top  + 80) + 'px';
  document.getElementById('comment-input').value = '';
  document.getElementById('comment-input').focus();
}
function cancelComment() {
  document.getElementById('comment-popover').style.display = 'none';
  clearPendingAnnot();
}
function saveComment() {
  const txt = document.getElementById('comment-input').value.trim();
  document.getElementById('comment-popover').style.display = 'none';
  commitAnnotation('comment', txt || '(no comment)');
}

// ─── Jump to linked card ───────────────────────────────────────────────────
function jumpToLinkedCard(annotId) {
  const link = Object.values(LINKS).find(
    l => l.anchor.annotId === annotId || l.anchor.anchorId === annotId
  );
  if (link) jumpToCard(link.cardId);
  else showToast('No canvas link for this annotation yet', '#D4850A');
}

// ─── Public API ────────────────────────────────────────────────────────────
function loadPdf(entry) { loadPdfViewer(entry); }

// Shared helpers (also used by viewer.js / links.js)
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : s || ''; }
function escHtml(s)     { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
