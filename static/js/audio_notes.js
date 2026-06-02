/* audio_notes.js — Canvas-only push-to-talk voice notes/audio logs.
   Add after canvas.js so it can reuse existing canvas card helpers. */
(function () {
  'use strict';

  let _audioStream = null;
  let _activeRecorder = null;
  let _activeChunks = [];
  let _activeCardId = null;
  let _activeStartedAt = 0;
  let _timerId = null;
  const _objectUrls = new Set();

  document.addEventListener('DOMContentLoaded', () => {
    injectVoiceNoteTool();
  });

  function injectVoiceNoteTool() {
    const toolbar = document.querySelector('.canvas-toolbar');
    if (!toolbar || document.getElementById('tool-audio-note')) return;

    const btn = document.createElement('button');
    btn.className = 'ctool';
    btn.id = 'tool-audio-note';
    btn.type = 'button';
    btn.title = 'Add a push-to-talk voice note on the canvas';
    btn.innerHTML = '🎙 Voice Note';
    btn.addEventListener('click', () => {
      closeAttachMenuSafe();
      createAudioNoteAtCanvasCenter();
    });

    const stickyBtn = document.getElementById('tool-sticky');
    if (stickyBtn && stickyBtn.parentNode === toolbar) {
      stickyBtn.insertAdjacentElement('afterend', btn);
    } else {
      toolbar.appendChild(btn);
    }
  }

  function createAudioNoteAtCanvasCenter() {
    if (typeof deselectAll === 'function') deselectAll();
    document.querySelectorAll('.ctool').forEach(b => b.classList.remove('on'));
    document.getElementById('tool-audio-note')?.classList.add('on');

    const surface = document.getElementById('canvas-surface');
    if (!surface || typeof screenToWorld !== 'function') return;
    const rect = surface.getBoundingClientRect();
    const wp = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const id = createAudioNoteCard(Math.max(20, wp.x - 140), Math.max(20, wp.y - 95));

    if (typeof selectCard === 'function') selectCard(id);
    setTimeout(() => {
      document.getElementById('tool-audio-note')?.classList.remove('on');
      document.getElementById('tool-select')?.classList.add('on');
      if (typeof setCanvasTool === 'function') setCanvasTool('select');
    }, 120);
  }

  function createAudioNoteCard(x, y) {
    const id = 'audio-note-' + (++_cardCounter);
    const el = document.createElement('div');
    el.className = 'c-card-live c-audio-note';
    el.id = id;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = '280px';
    el.style.height = '220px';

    el.innerHTML = `
      <div class="clive-header audio-note-header">
        <span class="clive-icon">🎙</span>
        <span class="clive-title">Voice Note</span>
        <div class="clive-actions">
          <button class="clive-btn danger" title="Remove" onclick="deleteCard('${id}')">✕</button>
        </div>
      </div>
      <div class="clive-body audio-note-body">
        <div class="audio-note-hint">Hold the button to record. Release to save an audio log.</div>
        <button class="audio-ptt-btn" type="button" data-card="${id}">
          <span class="audio-ptt-icon">●</span>
          <span class="audio-ptt-label">Hold to Talk</span>
        </button>
        <div class="audio-record-status" id="audio-status-${id}">Ready</div>
        <div class="audio-log-list" id="audio-log-list-${id}"></div>
      </div>
      <div class="clive-footer audio-note-footer">
        <span class="clive-type-tag audio-note-tag">audio log</span>
        <span class="audio-log-count" id="audio-log-count-${id}">0 logs</span>
      </div>
      <div class="resize-handle resize-se" data-card="${id}" data-dir="se"></div>`;

    document.getElementById('canvas-world')?.appendChild(el);
    _cards[id] = { id, type: 'audio', el, anchors: [], logs: [], wx: x, wy: y };

    if (typeof makeDraggableCard === 'function') makeDraggableCard(el, id);
    if (typeof attachResizeHandles === 'function') attachResizeHandles(el, id);

    el.addEventListener('click', evt => {
      if (evt.target.closest('.clive-actions,.resize-handle,.audio-ptt-btn,audio,button')) return;
      if (typeof selectCard === 'function') selectCard(id);
      if (typeof completeLinkToCard === 'function' && typeof _pendingLinkAnchor !== 'undefined' && _pendingLinkAnchor) {
        completeLinkToCard(id);
      }
    });

    bindPushToTalk(el.querySelector('.audio-ptt-btn'), id);
    if (typeof updateCanvasSubtitle === 'function') updateCanvasSubtitle();
    showToastSafe('🎙 Voice note added', '#1A8F6F');
    return id;
  }

  function bindPushToTalk(button, cardId) {
    if (!button) return;

    const start = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      startRecording(cardId, button);
    };
    const stop = (evt) => {
      if (evt) {
        evt.preventDefault();
        evt.stopPropagation();
      }
      stopRecording();
    };

    button.addEventListener('mousedown', start);
    button.addEventListener('touchstart', start, { passive: false });
    document.addEventListener('mouseup', stop);
    document.addEventListener('touchend', stop, { passive: false });
    document.addEventListener('touchcancel', stop, { passive: false });

    button.addEventListener('keydown', evt => {
      if (evt.code === 'Space' || evt.code === 'Enter') start(evt);
    });
    button.addEventListener('keyup', evt => {
      if (evt.code === 'Space' || evt.code === 'Enter') stop(evt);
    });
  }

  async function getAudioStream() {
    if (_audioStream && _audioStream.active) return _audioStream;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Audio recording is not supported in this browser.');
    }
    _audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return _audioStream;
  }

  async function startRecording(cardId, button) {
    if (_activeRecorder?.state === 'recording') return;
    const card = _cards[cardId];
    if (!card) return;

    try {
      const stream = await getAudioStream();
      const mimeType = pickMimeType();
      _activeChunks = [];
      _activeCardId = cardId;
      _activeStartedAt = Date.now();
      _activeRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      _activeRecorder.ondataavailable = evt => {
        if (evt.data && evt.data.size > 0) _activeChunks.push(evt.data);
      };
      _activeRecorder.onstop = () => finalizeRecording(cardId, _activeRecorder.mimeType || mimeType || 'audio/webm');

      _activeRecorder.start(100);
      button.classList.add('recording');
      setStatus(cardId, 'Recording 0:00');
      _timerId = setInterval(() => {
        const sec = Math.floor((Date.now() - _activeStartedAt) / 1000);
        setStatus(cardId, 'Recording ' + formatDuration(sec));
      }, 250);
    } catch (err) {
      setStatus(cardId, 'Microphone blocked or unavailable');
      showToastSafe('⚠ Microphone permission needed', '#D4850A');
      console.error('[audio_notes] startRecording failed:', err);
    }
  }

  function stopRecording() {
    if (!_activeRecorder || _activeRecorder.state !== 'recording') return;
    const btn = document.querySelector(`.audio-ptt-btn[data-card="${_activeCardId}"]`);
    btn?.classList.remove('recording');
    if (_timerId) clearInterval(_timerId);
    _timerId = null;
    setStatus(_activeCardId, 'Saving audio log…');
    _activeRecorder.stop();
  }

  function finalizeRecording(cardId, mimeType) {
    const card = _cards[cardId];
    if (!card) return;

    const elapsed = Math.max(0, Math.round((Date.now() - _activeStartedAt) / 1000));
    if (!_activeChunks.length || elapsed < 1) {
      setStatus(cardId, 'Too short. Hold a little longer.');
      cleanupActiveRecorder();
      return;
    }

    const blob = new Blob(_activeChunks, { type: mimeType || 'audio/webm' });
    const url = URL.createObjectURL(blob);
    _objectUrls.add(url);

    const log = {
      id: 'alog-' + Date.now(),
      url,
      blob,
      createdAt: new Date(),
      duration: elapsed,
      size: blob.size,
      mimeType: blob.type || mimeType || 'audio/webm'
    };

    card.logs = card.logs || [];
    card.logs.push(log);
    renderAudioLog(cardId, log, card.logs.length);
    updateAudioLogCount(cardId);
    setStatus(cardId, 'Saved ' + formatDuration(elapsed));
    showToastSafe('✅ Audio log saved', '#1A8F6F');
    cleanupActiveRecorder();
  }

  function cleanupActiveRecorder() {
    _activeRecorder = null;
    _activeChunks = [];
    _activeCardId = null;
    _activeStartedAt = 0;
  }

  function renderAudioLog(cardId, log, index) {
    const list = document.getElementById('audio-log-list-' + cardId);
    if (!list) return;

    const item = document.createElement('div');
    item.className = 'audio-log-item';
    item.dataset.logId = log.id;
    const fileName = `voice-note-${safeTimeName(log.createdAt)}.webm`;
    item.innerHTML = `
      <div class="audio-log-meta">
        <span class="audio-log-title">Log ${index}</span>
        <span class="audio-log-time">${formatClock(log.createdAt)} · ${formatDuration(log.duration)}</span>
      </div>
      <audio controls preload="metadata" src="${log.url}"></audio>
      <div class="audio-log-actions">
        <a class="audio-log-download" href="${log.url}" download="${fileName}">Download</a>
        <button class="audio-log-delete" type="button">Delete</button>
      </div>`;

    item.querySelector('.audio-log-delete')?.addEventListener('click', evt => {
      evt.stopPropagation();
      deleteAudioLog(cardId, log.id);
    });

    list.prepend(item);
  }

  function deleteAudioLog(cardId, logId) {
    const card = _cards[cardId];
    if (!card?.logs) return;
    const idx = card.logs.findIndex(l => l.id === logId);
    if (idx >= 0) {
      const [log] = card.logs.splice(idx, 1);
      if (log?.url) {
        URL.revokeObjectURL(log.url);
        _objectUrls.delete(log.url);
      }
    }
    document.querySelector(`#audio-log-list-${cardId} [data-log-id="${logId}"]`)?.remove();
    updateAudioLogCount(cardId);
    setStatus(cardId, 'Deleted audio log');
  }

  function updateAudioLogCount(cardId) {
    const count = _cards[cardId]?.logs?.length || 0;
    const el = document.getElementById('audio-log-count-' + cardId);
    if (el) el.textContent = count + ' log' + (count === 1 ? '' : 's');
  }

  function setStatus(cardId, text) {
    const el = document.getElementById('audio-status-' + cardId);
    if (el) el.textContent = text;
  }

  function pickMimeType() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    return candidates.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  function formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function formatClock(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function safeTimeName(date) {
    return date.toISOString().replace(/[:.]/g, '-');
  }

  function closeAttachMenuSafe() {
    if (typeof closeAttachMenu === 'function') closeAttachMenu();
  }

  function showToastSafe(message, color) {
    if (typeof showToast === 'function') showToast(message, color);
  }

  const originalDelete = window.deleteCard;
  if (typeof originalDelete === 'function') {
    window.deleteCard = function patchedDeleteCard(id) {
      const card = _cards?.[id];
      if (card?.type === 'audio' && Array.isArray(card.logs)) {
        card.logs.forEach(log => {
          if (log?.url) {
            URL.revokeObjectURL(log.url);
            _objectUrls.delete(log.url);
          }
        });
      }
      return originalDelete(id);
    };
  }

  window.addEventListener('beforeunload', () => {
    _objectUrls.forEach(url => URL.revokeObjectURL(url));
    if (_audioStream) _audioStream.getTracks().forEach(t => t.stop());
  });

  window.createAudioNoteCard = createAudioNoteCard;
})();
