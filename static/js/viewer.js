/* viewer.js — video + notebook viewers; tab switching */

let _nbLinkMode = false;
let _currentVidEntry = null;
let _currentNbEntry  = null;

// ─── TAB SWITCHING ────────────────────────────────────────────────────────
function switchViewTab(name, btn) {
  document.querySelectorAll('.ptab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  ['pdf', 'video', 'notebook'].forEach(n => {
    const pane = document.getElementById('view-' + n);
    if (pane) pane.style.display = n === name ? 'flex' : 'none';
  });
}

// ─── VIDEO ────────────────────────────────────────────────────────────────
function loadVideo(entry) {
  _currentVidEntry = entry;
  const player = document.getElementById('video-player');
  player.src = entry.path;
  player.load();
  document.getElementById('dz-video').style.display    = 'none';
  document.getElementById('video-reader').style.display = 'flex';
  document.getElementById('video-name-label').textContent = entry.name;
  document.getElementById('viewer-filename').textContent  = entry.name;
}

function linkCurrentTimestamp() {
  const vid = document.getElementById('video-player');
  if (!_currentVidEntry) { showToast('⚠ No video loaded', '#D4850A'); return; }
  const t = vid.currentTime;
  const anchor = {
    type:     'timestamp',
    fileId:   _currentVidEntry.id,
    anchorId: `${_currentVidEntry.id}-t${Math.floor(t)}`,
    time:     t,
    label:    `${_currentVidEntry.name} @ ${fmtTime(t)}`,
    text:     `Video timestamp ${fmtTime(t)}`,
  };
  addTimestampItem(anchor, _currentVidEntry);
  startLinkFromAnchor(anchor, null);
}

function addTimestampItem(anchor, entry) {
  if (document.getElementById('ts-' + anchor.anchorId)) return;
  const list = document.getElementById('ts-list');
  const item = document.createElement('div');
  item.className = 'ts-item';
  item.id = 'ts-' + anchor.anchorId;
  item.innerHTML = `
    <span class="ts-time">${fmtTime(anchor.time)}</span>
    <span class="ts-label">${entry.name}</span>
    <span class="ts-link-count" id="tslc-${anchor.anchorId}">0 links</span>
    <button class="ts-del" onclick="removeTimestamp('${anchor.anchorId}',event)">&#x2715;</button>`;
  item.addEventListener('click', e => {
    if (e.target.classList.contains('ts-del')) return;
    document.getElementById('video-player').currentTime = anchor.time;
    startLinkFromAnchor(anchor, item);
  });
  list.appendChild(item);
  const cnt = list.querySelectorAll('.ts-item').length;
  document.getElementById('ts-count').textContent = '(' + cnt + ')';
}

function removeTimestamp(anchorId, e) {
  if (e) e.stopPropagation();
  const el = document.getElementById('ts-' + anchorId);
  if (el) el.remove();
  removeLinksForAnchor(anchorId);
}

function fmtTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

// ─── NOTEBOOK ─────────────────────────────────────────────────────────────
async function loadNotebook(entry) {
  _currentNbEntry = entry;
  document.getElementById('dz-notebook').style.display  = 'none';
  document.getElementById('nb-reader').style.display    = 'flex';
  document.getElementById('nb-name-label').textContent  = entry.name;
  document.getElementById('viewer-filename').textContent = entry.name;
  _nbLinkMode = false;
  updateNbLinkModeUI();

  const res  = await fetch(entry.path);
  const text = await res.text();
  const ext  = entry.name.split('.').pop().toLowerCase();
  const container = document.getElementById('nb-content');
  container.innerHTML = '';

  if (ext === 'ipynb') {
    try { renderIpynb(JSON.parse(text), container, entry.id); }
    catch { renderRawCode(text, container, entry.id, ext); }
  } else {
    renderRawCode(text, container, entry.id, ext);
  }
}

function renderIpynb(nb, container, fileId) {
  const cells = nb.cells || nb.worksheets?.[0]?.cells || [];
  if (!cells.length) {
    container.innerHTML = '<div style="padding:20px;font-family:var(--fm);font-size:11px;color:var(--ink-4)">Empty notebook.</div>';
    return;
  }
  cells.forEach((cell, ci) => {
    const ct  = cell.cell_type || 'code';
    const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
    const num = cell.execution_count != null ? `[${cell.execution_count || ' '}]` : `[${ci + 1}]`;
    const div = document.createElement('div');
    div.className = 'nb-cell';
    const badge = ct === 'markdown'
      ? '<span class="cell-badge badge-md">markdown</span>'
      : '<span class="cell-badge badge-code">code</span>';
    let inner = `<div class="nb-cell-header">${badge}<button class="run-btn" onclick="simulateRun(this,event)">&#9654; Run</button><span class="cell-num">${num}</span></div>`;
    if (ct === 'markdown') {
      inner += `<div class="nb-md">${mdToHtml(escHtml(src))}</div>`;
    } else {
      inner += `<div class="nb-code">${buildCodeLines(src, fileId, ci)}</div>`;
      const outputs = cell.outputs || [];
      const outText = outputs.map(o => {
        if (o.output_type === 'stream') return Array.isArray(o.text) ? o.text.join('') : (o.text || '');
        const t = o.data?.['text/plain']; return Array.isArray(t) ? t.join('') : (t || '');
      }).filter(Boolean).join('\n');
      if (outText) inner += `<div class="nb-output"><div class="outlbl">Output</div><pre style="margin:0;font-size:10px;white-space:pre-wrap">${escHtml(outText)}</pre></div>`;
    }
    div.innerHTML = inner;
    div.addEventListener('click', () => {
      document.querySelectorAll('.nb-cell').forEach(c => c.classList.remove('active'));
      div.classList.add('active');
    });
    container.appendChild(div);
  });
}

function renderRawCode(text, container, fileId, ext) {
  const div = document.createElement('div');
  div.className = 'nb-cell active';
  div.innerHTML = `
    <div class="nb-cell-header">
      <span class="cell-badge badge-code">${ext}</span>
      <button class="run-btn" onclick="simulateRun(this,event)">&#9654; Run</button>
      <span class="cell-num">[1]</span>
    </div>
    <div class="nb-code">${buildCodeLines(text, fileId, 0)}</div>`;
  container.appendChild(div);
}

function buildCodeLines(src, fileId, cellIdx) {
  return src.split('\n').map((line, li) => {
    const anchorId = `${fileId}-c${cellIdx}-l${li}`;
    return `<div class="code-line" id="cl-${anchorId}"
      data-anchor-id="${anchorId}" data-file-id="${fileId}"
      data-cell="${cellIdx}" data-line="${li}"
      data-text="${escAttr(line)}"
      onclick="onCodeLineClick(this)">
      <span class="line-num">${li + 1}</span>
      <span class="line-content">${syntaxHL(escHtml(line))}</span>
    </div>`;
  }).join('');
}

function onCodeLineClick(el) {
  if (!_nbLinkMode) return;
  const anchor = {
    type:     'codeline',
    fileId:   el.dataset.fileId,
    anchorId: el.dataset.anchorId,
    cell:     el.dataset.cell,
    line:     el.dataset.line,
    text:     el.dataset.text,
    label:    `Line ${parseInt(el.dataset.line) + 1}: ${truncate(el.dataset.text, 50)}`,
  };
  el.classList.add('linked');
  startLinkFromAnchor(anchor, el);
}

function toggleNbLinkMode() {
  _nbLinkMode = !_nbLinkMode;
  updateNbLinkModeUI();
}
function updateNbLinkModeUI() {
  const btn = document.getElementById('nb-link-btn');
  if (!btn) return;
  const content = document.getElementById('nb-content');
  if (_nbLinkMode) {
    btn.textContent = '✕ Exit Link Mode';
    btn.classList.add('active');
    if (content) content.style.cursor = 'crosshair';
    showToast('🔗 Click any code line to link it to canvas', '#6B4FBB');
  } else {
    btn.textContent = '🔗 Link Mode';
    btn.classList.remove('active');
    if (content) content.style.cursor = '';
  }
}

function simulateRun(btn, e) {
  e.stopPropagation();
  const orig = btn.textContent;
  btn.textContent = '⏳'; btn.style.color = 'var(--amber)';
  setTimeout(() => {
    btn.textContent = '✓'; btn.style.color = 'var(--teal)';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 2000);
  }, 700);
}

// ─── utils ─────────────────────────────────────────────────────────────────
function syntaxHL(code) {
  return code
    .replace(/\b(import|from|as|def|class|return|if|else|elif|for|while|in|not|and|or|True|False|None|with|try|except|finally|raise|yield|lambda|pass|break|continue|global|nonlocal|assert|del)\b/g,
             '<span class="kw">$1</span>')
    .replace(/(#[^\n<]*)/g, '<span class="cm">$1</span>')
    .replace(/(&quot;.*?&quot;|&#39;.*?&#39;)/g, '<span class="st">$1</span>');
}
function mdToHtml(md) {
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm,  '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code style="font-family:var(--fm);font-size:10px;background:var(--paper-2);padding:1px 4px;border-radius:2px">$1</code>')
    .replace(/\n/g, '<br>');
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escAttr(s) { return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
