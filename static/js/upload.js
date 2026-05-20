/* upload.js */
const FILES = {};

async function uploadFile(input, type) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  showToast('⬆ Uploading ' + file.name + '…', '#2B6CB0');

  const fd = new FormData();
  fd.append('file', file);

  try {
    const res  = await fetch('/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) { showToast('❌ ' + data.error, '#E05A3A'); return; }

    const entry = { id: data.id, name: data.name, type: data.type,
                    path: data.path, fname: data.fname };
    FILES[data.id] = entry;
    document.getElementById('m-files').textContent = Object.keys(FILES).length;

    // 1. Load into the left-panel viewer
    activateFile(entry);
    // 2. Also spawn a live canvas card automatically
    spawnCanvasCard(entry);
    // 3. Add chip to file bar
    addFileChip(entry);

    showToast('✅ ' + data.name + ' loaded', '#1A8F6F');
    closeUploadModal();
  } catch (err) {
    showToast('❌ Upload failed', '#E05A3A');
    console.error(err);
  }
}

function activateFile(entry) {
  if (entry.type === 'pdf') {
    switchViewTab('pdf', document.querySelector('[data-tab="pdf"]'));
    loadPdf(entry);
  } else if (entry.type === 'video') {
    switchViewTab('video', document.querySelector('[data-tab="video"]'));
    loadVideo(entry);
  } else if (entry.type === 'notebook') {
    switchViewTab('notebook', document.querySelector('[data-tab="notebook"]'));
    loadNotebook(entry);
  }
  document.querySelectorAll('.cfb-chip').forEach(c =>
    c.classList.toggle('active', c.dataset.id === entry.id));
}

function spawnCanvasCard(entry) {
  // Stagger cards so they don't all stack at 0,0
  const n  = Object.keys(FILES).length;
  const x  = 30 + (n - 1) * 24;
  const y  = 30 + (n - 1) * 18;
  createLiveCard(entry, x, y);   // defined in canvas.js
}

function addFileChip(entry) {
  const existing = document.querySelector(`.cfb-chip[data-id="${entry.id}"]`);
  if (existing) existing.remove();
  const icons = { pdf:'📄', video:'🎬', notebook:'📓' };
  const chip = document.createElement('div');
  chip.className = 'cfb-chip';
  chip.dataset.id = entry.id;
  chip.innerHTML = `${icons[entry.type]||'📎'} <span style="max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${entry.name}</span> <button class="cfb-del" onclick="removeFile('${entry.id}',event)">✕</button>`;
  chip.addEventListener('click', () => activateFile(entry));
  document.getElementById('cfb-list').appendChild(chip);
}

function removeFile(id, e) {
  if (e) e.stopPropagation();
  const entry = FILES[id]; if (!entry) return;
  delete FILES[id];
  document.querySelector(`.cfb-chip[data-id="${id}"]`)?.remove();
  document.getElementById('m-files').textContent = Object.keys(FILES).length;
  if (entry.type === 'pdf') {
    document.getElementById('pdf-reader').style.display = 'none';
    document.getElementById('dz-pdf').style.display = '';
  } else if (entry.type === 'video') {
    document.getElementById('video-reader').style.display = 'none';
    document.getElementById('dz-video').style.display = '';
    document.getElementById('video-player').src = '';
  } else if (entry.type === 'notebook') {
    document.getElementById('nb-reader').style.display = 'none';
    document.getElementById('dz-notebook').style.display = '';
    document.getElementById('nb-content').innerHTML = '';
  }
  removeLinksForFile(id);
  showToast('🗑 ' + entry.name + ' removed','#6B6A66');
}

function dzOver(e, el) { e.preventDefault(); el.classList.add('over'); }
function dzLeave(el)   { el.classList.remove('over'); }
function dzDrop(e, type) {
  e.preventDefault();
  e.currentTarget.classList.remove('over');
  const file = e.dataTransfer.files[0]; if (!file) return;
  const dt = new DataTransfer(); dt.items.add(file);
  const inp = document.createElement('input'); inp.type='file'; inp.files = dt.files;
  uploadFile(inp, type);
}

function openUploadPicker()  { document.getElementById('upload-modal').style.display = 'flex'; }
function closeUploadModal(e) {
  if (e && e.target !== document.getElementById('upload-modal')) return;
  document.getElementById('upload-modal').style.display = 'none';
}
