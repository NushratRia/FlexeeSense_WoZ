/* collab.js — FlexaSense real-time canvas collaboration + WebRTC video
   -------------------------------------------------------
   Drop into static/js/ and add script tag to index.html after all other scripts:
     <script src="/static/js/collab.js"></script>
*/

(function() {
'use strict';

// ── Config ────────────────────────────────────────────────────────────────
const COLLAB_COLORS = ['#2563EB','#D97706','#7C3AED','#1A8F6F','#E05A3A','#0891B2','#BE185D','#047857'];
let _myColor   = COLLAB_COLORS[Math.floor(Math.random() * COLLAB_COLORS.length)];
let _myName    = 'Peer ' + Math.floor(Math.random() * 900 + 100);
let _room      = 'main';
let _socket    = null;
let _connected = false;
let _peersEl   = {};          // sid -> cursor label DOM element
let _applyingRemote = false;  // guard: don't re-emit while applying peer state
let _canvasPatched  = false;  // patch canvas.js only once

// WebRTC
const _peerConns   = {};   // sid -> RTCPeerConnection
const _peerVideos  = {};   // sid -> <video> element
const _peerBubbles = {};   // sid -> bubble <div>
let   _localStream  = null;
let   _videoEnabled = false;
const BUBBLE_R      = 44;  // px radius

// ── Load Socket.IO from CDN ────────────────────────────────────────────────
function _loadSocketIO(cb) {
  if (window.io) { cb(); return; }
  const s = document.createElement('script');
  s.src     = 'https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.5/socket.io.min.js';
  s.onload  = cb;
  s.onerror = () => showToast('❌ Could not load Socket.IO', '#E05A3A');
  document.head.appendChild(s);
}

// ── Build UI ──────────────────────────────────────────────────────────────
function _buildUI() {
  const btn = document.getElementById('collab-btn');
  if (btn) {
    btn.style.background  = 'rgba(37,99,235,0.12)';
    btn.style.borderColor = 'rgba(37,99,235,0.35)';
    btn.style.color       = '#93C5FD';
  }

  const panel = document.createElement('div');
  panel.id = 'collab-panel';
  panel.style.cssText = [
    'position:fixed','top:58px','right:16px','width:290px',
    'background:#111','border:1px solid rgba(255,255,255,0.12)',
    'border-radius:10px','box-shadow:0 8px 32px rgba(0,0,0,0.5)',
    'z-index:300','display:none','flex-direction:column',
    'overflow:hidden','font-family:JetBrains Mono,monospace',
  ].join(';');

  panel.innerHTML = `
    <div style="padding:12px 14px;background:rgba(37,99,235,0.15);border-bottom:1px solid rgba(255,255,255,0.08)">
      <div style="font-family:Cabinet Grotesk,sans-serif;font-weight:800;font-size:13px;color:#fff;margin-bottom:2px">👥 Collaborate</div>
      <div style="font-size:10px;color:rgba(255,255,255,0.4)" id="collab-status-line">Not connected</div>
    </div>
    <div id="collab-join-form" style="padding:12px 14px;display:flex;flex-direction:column;gap:8px">
      <div>
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:rgba(255,255,255,0.35);margin-bottom:4px">Your name</div>
        <input id="collab-name" value="${_myName}"
          style="width:100%;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);
                 border-radius:5px;padding:6px 9px;color:#fff;font-family:inherit;font-size:11px;outline:none;box-sizing:border-box">
      </div>
      <div>
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:rgba(255,255,255,0.35);margin-bottom:4px">Room name</div>
        <input id="collab-room" value="${_room}"
          style="width:100%;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);
                 border-radius:5px;padding:6px 9px;color:#fff;font-family:inherit;font-size:11px;outline:none;box-sizing:border-box">
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <div style="font-size:9px;color:rgba(255,255,255,0.35)">Color</div>
        <input type="color" id="collab-color" value="${_myColor}"
          style="width:24px;height:24px;border-radius:50%;border:none;cursor:pointer;padding:0;background:none">
        <div style="flex:1"></div>
        <button id="collab-connect-btn" onclick="collabConnect()"
          style="padding:6px 16px;background:#2563EB;color:#fff;border:none;border-radius:5px;
                 font-family:Cabinet Grotesk,sans-serif;font-weight:700;font-size:11px;cursor:pointer">
          Join
        </button>
      </div>
    </div>
    <div id="collab-session" style="display:none;flex-direction:column">
      <div id="collab-peers-list" style="padding:8px 14px;border-top:1px solid rgba(255,255,255,0.07)">
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:rgba(255,255,255,0.3);margin-bottom:6px">In this room</div>
        <div id="collab-peers-inner"></div>
      </div>
      <div style="padding:6px 14px 8px;display:flex;gap:6px">
        <button id="collab-video-btn" onclick="collabToggleVideo()"
          style="flex:1;padding:6px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
                 border-radius:5px;color:rgba(255,255,255,0.6);font-family:Cabinet Grotesk,sans-serif;
                 font-weight:700;font-size:11px;cursor:pointer;transition:all .12s">
          📷 Enable camera
        </button>
        <button onclick="collabDisconnect()"
          style="padding:6px 12px;background:rgba(224,90,58,0.1);border:1px solid rgba(224,90,58,0.3);
                 border-radius:5px;color:#F87155;font-family:Cabinet Grotesk,sans-serif;
                 font-weight:700;font-size:11px;cursor:pointer">
          Leave
        </button>
      </div>
    </div>
    <div style="padding:5px 14px 8px;font-size:9px;color:rgba(255,255,255,0.18);border-top:1px solid rgba(255,255,255,0.05)">
      Share room name to collaborate · <a href="/collab/debug" target="_blank" style="color:rgba(255,255,255,0.25)">debug</a>
    </div>`;

  document.body.appendChild(panel);

  // Close panel on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('#collab-panel') && !e.target.closest('#collab-btn')) {
      panel.style.display = 'none';
    }
  });
}

function _togglePanel() {
  const p = document.getElementById('collab-panel');
  if (!p) return;
  p.style.display = p.style.display === 'none' ? 'flex' : 'none';
}
window.collabTogglePanel = _togglePanel;

function _setStatus(msg, color) {
  const el = document.getElementById('collab-status-line');
  if (el) { el.textContent = msg; el.style.color = color || 'rgba(255,255,255,0.4)'; }
}

// ── Connect ───────────────────────────────────────────────────────────────
window.collabConnect = function() {
  _myName  = (document.getElementById('collab-name')?.value || '').trim()  || _myName;
  _room    = (document.getElementById('collab-room')?.value || '').trim()   || _room;
  _myColor = document.getElementById('collab-color')?.value || _myColor;

  const btn = document.getElementById('collab-connect-btn');
  if (btn) { btn.textContent = 'Connecting…'; btn.disabled = true; }
  _setStatus('Connecting…', '#EF9F27');

  _loadSocketIO(() => {
    _socket = io({ transports: ['websocket','polling'] });

    _socket.on('connect', () => {
      _connected = true;
      _socket.emit('join_room', { room: _room, name: _myName, color: _myColor });
      if (btn) { btn.textContent = 'Connected ✓'; btn.disabled = false; }
      _setStatus(`Connected · room: "${_room}"`, '#1A8F6F');
      showToast(`👥 Joined room "${_room}"`, '#2563EB');

      // Show session UI, hide join form
      document.getElementById('collab-join-form').style.display  = 'none';
      document.getElementById('collab-session').style.display    = 'flex';
      _updatePeersList([]);

      // Style the topbar button
      const cb = document.getElementById('collab-btn');
      if (cb) { cb.style.background='rgba(26,143,111,0.2)'; cb.style.borderColor='#1A8F6F'; cb.style.color='#6EDFC0'; }

      // Patch canvas.js exactly once
      if (!_canvasPatched) { _patchCanvas(); _canvasPatched = true; }
      _startCursorBroadcast();
    });

    _socket.on('disconnect', () => {
      _connected = false;
      _setStatus('Disconnected', '#E05A3A');
      showToast('👥 Disconnected', '#E05A3A');
      _clearPeerCursors();
    });

    _socket.on('connect_error', err => {
      _setStatus('Failed: ' + err.message, '#E05A3A');
      if (btn) { btn.textContent = 'Retry'; btn.disabled = false; }
      showToast('❌ Collab connection failed — is the server running?', '#E05A3A');
    });

    _registerSocketEvents();
  });
};

window.collabDisconnect = function() {
  stopVideo();
  if (_socket) { _socket.disconnect(); _socket = null; }
  _connected = false;
  _clearPeerCursors();
  _clearAllPeerBubbles();
  _setStatus('Not connected', 'rgba(255,255,255,0.4)');
  const btn = document.getElementById('collab-connect-btn');
  if (btn) { btn.textContent = 'Join'; btn.disabled = false; }
  document.getElementById('collab-join-form').style.display  = 'flex';
  document.getElementById('collab-session').style.display    = 'none';
  const cb = document.getElementById('collab-btn');
  if (cb) { cb.style.background='rgba(37,99,235,0.12)'; cb.style.borderColor='rgba(37,99,235,0.35)'; cb.style.color='#93C5FD'; }
  showToast('👥 Left room', '#6B7280');
};

function _emit(event, data) {
  if (_socket && _connected && !_applyingRemote) {
    _socket.emit(event, { ...data, room: _room });
  }
}

// ── Socket event handlers ─────────────────────────────────────────────────
function _registerSocketEvents() {

  _socket.on('room_snapshot', data => {
    _applyingRemote = true;
    try {
      const state = data.state || {};
      Object.values(state.files || {}).forEach(f => {
        if (!FILES[f.id]) { FILES[f.id] = f; if(typeof addFileChip==='function') addFileChip(f); }
      });
      // Register files first so cards can find their fileEntry
      Object.values(state.files || {}).forEach(f => {
        if (!FILES[f.id]) { FILES[f.id] = f; }
      });
      // Cards (live PDF/video/notebook cards)
      Object.values(state.cards   || {}).forEach(c => _applyCardAdd(c));
      // Sticky cards
      Object.values(state.stickies || {}).forEach(s => _applyStickyAdd(s));
      // Draw strokes
      Object.values(state.strokes || {}).forEach(s => _applyStrokeAdd(s));
      // Connector links — after cards exist
      setTimeout(() => {
        Object.values(state.links || {}).forEach(l => _applyLinkAdd(l));
      }, 800);
    } finally { _applyingRemote = false; }

    _updatePeersList(data.peers || []);
    // Create bubbles for existing peers
    (data.peers || []).forEach(p => {
      _createPeerCursor(p.sid, p.name, p.color);
      _createPeerBubble(p.sid, p.name, p.color);
    });
    const n = Object.keys(data.state?.cards || {}).length;
    if (n > 0) showToast(`📥 Loaded ${n} card${n!==1?'s':''} from room`, '#2563EB');
  });

  _socket.on('peer_joined', data => {
    showToast(`👤 ${data.name} joined`, data.color || '#2563EB');
    _addPeerToList(data);
    _createPeerCursor(data.sid, data.name, data.color);
    _createPeerBubble(data.sid, data.name, data.color);
    // If we have video on, initiate WebRTC offer to the new peer
    if (_videoEnabled && _localStream) {
      setTimeout(() => _createPeerConn(data.sid, true), 600);
    }
  });

  _socket.on('peer_left', data => {
    showToast(`👤 ${data.name} left`, '#6B7280');
    _removePeerFromList(data.sid);
    _removePeerCursor(data.sid);
    _closePeerConn(data.sid);
  });

  // Canvas sync
  _socket.on('canvas_card_add',    d => { _applyingRemote=true; try{_applyCardAdd(d);}    finally{_applyingRemote=false;} });
  _socket.on('canvas_link_add',    d => { _applyingRemote=true; try{_applyLinkAdd(d);}    finally{_applyingRemote=false;} });
  _socket.on('canvas_link_delete', d => { _applyingRemote=true; try{ if(typeof removeLink==='function') removeLink(d.linkId); } finally{_applyingRemote=false;} });
  _socket.on('canvas_card_move',   d => { _applyingRemote=true; try{_applyCardMove(d);}   finally{_applyingRemote=false;} });
  _socket.on('canvas_card_resize', d => { _applyingRemote=true; try{_applyCardResize(d);} finally{_applyingRemote=false;} });
  _socket.on('canvas_card_delete', d => { _applyingRemote=true; try{deleteCard(d.id);}    finally{_applyingRemote=false;} });
  _socket.on('canvas_stroke_add',  d => { _applyingRemote=true; try{_applyStrokeAdd(d);}  finally{_applyingRemote=false;} });
  _socket.on('canvas_stroke_delete',d=>{ _applyingRemote=true; try{if(typeof deleteStroke==='function')deleteStroke(d.id);} finally{_applyingRemote=false;} });
  _socket.on('canvas_clear',       d => { _applyingRemote=true; try{if(typeof clearCanvas==='function')clearCanvas();} finally{_applyingRemote=false;} });
  _socket.on('canvas_sticky_add',  d => { _applyingRemote=true; try{_applyStickyAdd(d);}  finally{_applyingRemote=false;} });
  _socket.on('canvas_sticky_move', d => { _applyingRemote=true; try{_applyCardMove(d);}   finally{_applyingRemote=false;} });

  _socket.on('file_shared', data => {
    if (!FILES[data.id]) {
      FILES[data.id] = data;
      if(typeof addFileChip==='function') addFileChip(data);
      showToast('📄 ' + data.name + ' shared', '#1A8F6F');
    }
  });

  _socket.on('cursor_move', data => {
    _movePeerCursor(data.sid, data.x, data.y);
    _movePeerBubble(data.sid, data.x, data.y);
  });

  // WebRTC signaling
  _socket.on('webrtc_offer',  async d => { await _handleOffer(d.from, d.sdp); });
  _socket.on('webrtc_answer', async d => { await _handleAnswer(d.from, d.sdp); });
  _socket.on('webrtc_ice',    async d => { await _handleIce(d.from, d.candidate); });
}

// ── Canvas patching ───────────────────────────────────────────────────────
function _patchCanvas() {
  // createLiveCard — 4th param _remoteId lets _applyCardAdd set canonical id
  const _origCreate = window.createLiveCard;
  window.createLiveCard = function(entry, x, y, _remoteId) {
    const id = _origCreate(entry, x, y);
    // Remap to remote id immediately if provided (remote apply)
    if (_remoteId && id && _remoteId !== id && _cards[id]) {
      _cards[_remoteId]       = _cards[id];
      _cards[_remoteId].id    = _remoteId;
      _cards[_remoteId].el.id = _remoteId;
      delete _cards[id];
    }
    const finalId = _remoteId || id;
    if (!_applyingRemote && finalId) {
      const card = _cards[finalId];
      _emit('canvas_card_add', {
        id: finalId, x: x||60, y: y||60,
        w: parseFloat(card?.el?.style.width)||400,
        h: parseFloat(card?.el?.style.height)||300,
        fileEntry: entry, fileId: entry.id,
      });
      _emit('file_shared', entry);
    }
    return finalId;
  };

  // createStickyCard
  const _origSticky = window.createStickyCard;
  window.createStickyCard = function(x, y, text) {
    const id = _origSticky(x, y, text);
    if (!_applyingRemote && id) {
      _emit('canvas_sticky_add', { id, x: x||60, y: y||60, text: text||'' });
    }
    return id;
  };

  // deleteCard
  const _origDelete = window.deleteCard;
  window.deleteCard = function(id) {
    _origDelete(id);
    if (!_applyingRemote) _emit('canvas_card_delete', { id });
  };

  // doDragCard — capture position BEFORE the move so delta works even after mouseup
  const _origDrag = window.doDragCard;
  let _lastEmitX = null, _lastEmitY = null, _dragThrottle = null;
  window.doDragCard = function(e) {
    const cardId = window._dragCard?.id;
    _origDrag(e);
    if (!_applyingRemote && cardId && _cards[cardId]) {
      clearTimeout(_dragThrottle);
      _dragThrottle = setTimeout(() => {
        const card = _cards[cardId]; if (!card) return;
        const nx = parseFloat(card.el.style.left);
        const ny = parseFloat(card.el.style.top);
        if (nx !== _lastEmitX || ny !== _lastEmitY) {
          _emit('canvas_card_move', { id: cardId, x: nx, y: ny });
          _lastEmitX = nx; _lastEmitY = ny;
        }
      }, 32);
    }
  };

  // doResize
  const _origResize = window.doResize;
  let _resizeThrottle = null;
  window.doResize = function(e) {
    _origResize(e);
    if (!_applyingRemote && window._resizing) {
      clearTimeout(_resizeThrottle);
      _resizeThrottle = setTimeout(() => {
        const r = window._resizing; if (!r) return;
        _emit('canvas_card_resize', {
          id: r.id,
          w: parseFloat(r.el.style.width),
          h: parseFloat(r.el.style.height),
        });
      }, 32);
    }
  };

  // clearCanvas
  const _origClear = window.clearCanvas;
  window.clearCanvas = function() {
    _origClear();
    if (!_applyingRemote) _emit('canvas_clear', {});
  };

  // deleteStroke — also handled via window.onStrokeDeleted hook below
  // (kept here as fallback for any direct calls)
  const _origDelStroke = window.deleteStroke;
  window.deleteStroke = function(id) {
    if (typeof _origDelStroke === 'function') _origDelStroke(id);
    // emit handled by onStrokeDeleted hook set below
  };

  // ── Draw stroke hooks — draw.js calls these directly ──────────────────
  // Much more reliable than proxying the _strokes object (which is module-scoped)
  window.onStrokeAdded = function(id, points, color, width) {
    if (!_applyingRemote) {
      _emit('canvas_stroke_add', { id, points, color, width });
    }
  };

  window.onStrokeDeleted = function(id) {
    if (!_applyingRemote) {
      _emit('canvas_stroke_delete', { id });
    }
  };

  // Patch createLink — emit the full anchor+cardId so peers can recreate the line
  const _origCreateLink = window.createLink;
  window.createLink = function(anchor, cardId, sourceEl) {
    _origCreateLink(anchor, cardId, sourceEl);
    if (!_applyingRemote) {
      // Find the link just created (last entry in LINKS)
      const linkIds = Object.keys(LINKS);
      const linkId  = linkIds[linkIds.length - 1];
      if (linkId) {
        _emit('canvas_link_add', {
          linkId, cardId,
          anchor: {
            type:     anchor.type,
            fileId:   anchor.fileId,
            anchorId: anchor.anchorId,
            annotId:  anchor.annotId,
            text:     anchor.text,
            label:    anchor.label,
            time:     anchor.time,        // for video timestamps
            fromCard: anchor.fromCard,
          },
        });
      }
    }
  };

  // Patch removeLink — tell peers to remove their copy
  const _origRemoveLink = window.removeLink;
  window.removeLink = function(linkId, e) {
    _origRemoveLink(linkId, e);
    if (!_applyingRemote) {
      _emit('canvas_link_delete', { linkId });
    }
  };

  console.log('[collab] canvas patched ✓');
}

// ── Apply remote changes ──────────────────────────────────────────────────
function _applyCardAdd(data) {
  if (!data.id || _cards[data.id]) return;
  const entry = data.fileEntry || FILES[data.fileId];
  if (!entry) {
    console.warn('[collab] file not found for card:', data.fileId, '— queuing retry');
    // Retry after 500ms once file_shared may have arrived
    setTimeout(() => { if (!_cards[data.id]) _applyCardAdd(data); }, 500);
    return;
  }
  _applyingRemote = true;
  try {
    // Pass remote id as 4th param — createLiveCard remaps internally
    createLiveCard(entry, data.x||60, data.y||60, data.id);
  } finally {
    _applyingRemote = false;
  }
  // Apply stored size
  const el = _cards[data.id]?.el;
  if (el) {
    if (data.w) el.style.width  = data.w + 'px';
    if (data.h) el.style.height = data.h + 'px';
  }
}

function _applyStickyAdd(data) {
  if (!data.id || _cards[data.id]) return;
  _applyingRemote = true;
  try {
    createStickyCard(data.x||60, data.y||60, data.text||'');
    // Remap local id → remote id
    const keys = Object.keys(_cards);
    const newId = keys[keys.length - 1];
    if (newId && newId !== data.id && _cards[newId]) {
      _cards[data.id]       = _cards[newId];
      _cards[data.id].id    = data.id;
      _cards[data.id].el.id = data.id;
      delete _cards[newId];
    }
  } finally { _applyingRemote = false; }
}

function _applyCardMove(data) {
  const card = _cards[data.id]; if (!card) return;
  card.el.style.left = data.x + 'px';
  card.el.style.top  = data.y + 'px';
  if (typeof redrawLinks === 'function') redrawLinks();
}

function _applyCardResize(data) {
  const card = _cards[data.id]; if (!card) return;
  if (data.w) card.el.style.width  = data.w + 'px';
  if (data.h) card.el.style.height = data.h + 'px';
  if (typeof redrawLinks === 'function') redrawLinks();
}

function _applyLinkAdd(data) {
  if (!data.linkId || !data.cardId || !data.anchor) return;
  // Don't recreate if already exists
  if (typeof LINKS !== 'undefined' && LINKS[data.linkId]) return;
  // Card must exist
  if (!_cards[data.cardId]) {
    // Retry after cards may have loaded
    setTimeout(() => { if(!LINKS?.[data.linkId]) _applyLinkAdd(data); }, 600);
    return;
  }

  // For sentence/PDF links: find the annotation mark element as sourceEl
  // For video timestamps: source is the video player element
  // For code lines: source is the code line element
  let sourceEl = null;
  const a = data.anchor;
  if (a.annotId) {
    sourceEl = document.getElementById('annot-' + a.annotId + '-mark')
            || document.querySelector(`[data-annot-id="${a.annotId}"]`);
  } else if (a.type === 'timestamp') {
    sourceEl = document.getElementById('video-player');
  } else if (a.anchorId) {
    sourceEl = document.getElementById('cl-' + a.anchorId)
            || document.getElementById('cnbl-' + a.anchorId);
  }

  // Use createLink directly, bypassing the startLinkFromAnchor UI flow
  if (typeof createLink === 'function') {
    createLink(a, data.cardId, sourceEl);
    // The link was created with a new local linkId — remap to remote linkId
    const linkIds = Object.keys(LINKS);
    const newLinkId = linkIds[linkIds.length - 1];
    if (newLinkId && newLinkId !== data.linkId && LINKS[newLinkId]) {
      LINKS[data.linkId] = LINKS[newLinkId];
      LINKS[data.linkId].linkId = data.linkId;
      delete LINKS[newLinkId];
      // Fix SVG element IDs
      const renameSvgEl = (oldId, newId) => {
        const el = document.getElementById(oldId);
        if (el) el.id = newId;
      };
      renameSvgEl('lline-'  + newLinkId, 'lline-'  + data.linkId);
      renameSvgEl('lglow-'  + newLinkId, 'lglow-'  + data.linkId);
      renameSvgEl('llabel-' + newLinkId, 'llabel-' + data.linkId);
      // Fix badge id
      const badge = document.getElementById('la-' + newLinkId);
      if (badge) badge.id = 'la-' + data.linkId;
      // Fix card anchors array
      const card = _cards[data.cardId];
      if (card?.anchors) {
        card.anchors = card.anchors.map(id => id === newLinkId ? data.linkId : id);
      }
    }
  }
}

function _applyStrokeAdd(data) {
  if (!data.id || !data.points?.length) return;
  if (document.getElementById(data.id + '-path')) return;
  const svg = document.getElementById('draw-overlay-svg');
  if (!svg) return;
  svg.style.display = '';
  const glow = document.createElementNS('http://www.w3.org/2000/svg','path');
  glow.id = data.id+'-glow';
  glow.setAttribute('stroke', _rgba(data.color||'#E05A3A', 0.22));
  glow.setAttribute('stroke-width', (data.width||3)+8);
  glow.setAttribute('fill','none'); glow.setAttribute('stroke-linecap','round');
  glow.setAttribute('filter','blur(4px)');
  svg.appendChild(glow);
  const path = document.createElementNS('http://www.w3.org/2000/svg','path');
  path.id = data.id+'-path';
  path.setAttribute('stroke',        data.color||'#E05A3A');
  path.setAttribute('stroke-width',  String(data.width||3));
  path.setAttribute('fill',          'none');
  path.setAttribute('stroke-linecap','round');
  path.setAttribute('stroke-linejoin','round');
  path.setAttribute('opacity',       '0.9');
  svg.appendChild(path);
  const d = _smoothPath(data.points);
  path.setAttribute('d', d); glow.setAttribute('d', d);
  if (typeof window._strokes !== 'undefined') {
    _applyingRemote = true;
    window._strokes[data.id] = { id:data.id, el:path, glowEl:glow, points:data.points,
                                  color:data.color, width:data.width, linkedAnnots:[], linkedCards:[] };
    _applyingRemote = false;
  }
}

function _smoothPath(pts) {
  if (pts.length < 2) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length-1; i++) {
    const p0=pts[Math.max(0,i-1)], p1=pts[i], p2=pts[i+1], p3=pts[Math.min(pts.length-1,i+2)];
    d += ` C ${p1.x+(p2.x-p0.x)/6} ${p1.y+(p2.y-p0.y)/6}, ${p2.x-(p3.x-p1.x)/6} ${p2.y-(p3.y-p1.y)/6}, ${p2.x} ${p2.y}`;
  }
  return d;
}

// ── Cursor broadcast ──────────────────────────────────────────────────────
function _startCursorBroadcast() {
  let _t = null;
  document.addEventListener('mousemove', e => {
    if (!_connected || !_socket) return;
    clearTimeout(_t);
    _t = setTimeout(() => {
      _socket.emit('cursor_move', { room:_room, x:e.clientX, y:e.clientY });
    }, 35);
  });
}

// ── Peer cursors (name labels) ────────────────────────────────────────────
function _createPeerCursor(sid, name, color) {
  if (_peersEl[sid]) return;
  const el = document.createElement('div');
  el.id = 'pcursor-' + sid;
  el.style.cssText = [
    'position:fixed','z-index:9000','pointer-events:none',
    'display:flex','align-items:center','gap:4px',
    'left:-200px','top:-200px',
    'transition:left 80ms linear, top 80ms linear',
  ].join(';');
  el.innerHTML = `
    <svg width="14" height="18" viewBox="0 0 14 18" fill="none">
      <path d="M0 0L0 14L3.5 10.5L7 17.5L8.75 16.5L5.25 9.5L10.5 9.5Z" fill="${color}" stroke="white" stroke-width="1"/>
    </svg>
    <span style="background:${color};color:#fff;font-family:Cabinet Grotesk,sans-serif;font-weight:700;
                 font-size:11px;padding:2px 7px;border-radius:20px;white-space:nowrap;
                 box-shadow:0 2px 6px rgba(0,0,0,.3)">${name}</span>`;
  document.body.appendChild(el);
  _peersEl[sid] = el;
}

function _movePeerCursor(sid, x, y) {
  const el = _peersEl[sid]; if (!el) return;
  el.style.left = (x + 2) + 'px';
  el.style.top  = (y + 2) + 'px';
}

function _removePeerCursor(sid) {
  _peersEl[sid]?.remove();
  delete _peersEl[sid];
}

function _clearPeerCursors() {
  Object.keys(_peersEl).forEach(_removePeerCursor);
}

// ── Peers list panel ──────────────────────────────────────────────────────
function _updatePeersList(peers) {
  const inner = document.getElementById('collab-peers-inner');
  if (!inner) return;
  inner.innerHTML = '';
  _addPeerToList({ sid:'me', name:_myName+' (you)', color:_myColor });
  (Array.isArray(peers)?peers:Object.values(peers)).forEach(p => _addPeerToList(p));
}

function _addPeerToList(peer) {
  const inner = document.getElementById('collab-peers-inner');
  if (!inner || inner.querySelector(`[data-sid="${peer.sid}"]`)) return;
  const el = document.createElement('div');
  el.dataset.sid = peer.sid;
  el.style.cssText = 'display:flex;align-items:center;gap:7px;margin-bottom:5px';
  el.innerHTML = `
    <span style="width:10px;height:10px;border-radius:50%;background:${peer.color||'#888'};flex-shrink:0"></span>
    <span style="font-size:11px;color:rgba(255,255,255,0.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${peer.name}</span>`;
  inner.appendChild(el);
}

function _removePeerFromList(sid) {
  document.querySelector(`[data-sid="${sid}"]`)?.remove();
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBRTC VIDEO BUBBLES
// ═══════════════════════════════════════════════════════════════════════════

const RTC_CFG = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]};

// ── Local camera ──────────────────────────────────────────────────────────
async function startVideo() {
  if (_localStream) return _localStream;
  try {
    _localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    _showLocalBubble();
    return _localStream;
  } catch(e) {
    showToast('📷 Camera error: ' + e.message, '#D4850A');
    return null;
  }
}

function stopVideo() {
  _localStream?.getTracks().forEach(t => t.stop());
  _localStream = null;
  _videoEnabled = false;
  document.getElementById('collab-local-bubble')?.remove();
  Object.keys(_peerConns).forEach(_closePeerConn);
  const btn = document.getElementById('collab-video-btn');
  if (btn) { btn.textContent = '📷 Enable camera'; btn.style.color = 'rgba(255,255,255,0.6)'; }
}

window.collabToggleVideo = async function() {
  const btn = document.getElementById('collab-video-btn');
  if (_videoEnabled) {
    stopVideo();
  } else {
    if (btn) { btn.textContent = '⏳ Requesting…'; btn.disabled = true; }
    const stream = await startVideo();
    if (btn) { btn.disabled = false; }
    if (stream) {
      _videoEnabled = true;
      if (btn) { btn.textContent = '📷 Camera on ✓'; btn.style.color = '#6EDFC0'; }
      // Initiate WebRTC with all current peers
      Object.keys(_peerBubbles).forEach(sid => {
        if (sid !== 'local') _createPeerConn(sid, true);
      });
    } else {
      if (btn) btn.textContent = '📷 Enable camera';
    }
  }
};

// ── Local video bubble (bottom-left corner, draggable) ────────────────────
function _showLocalBubble() {
  document.getElementById('collab-local-bubble')?.remove();
  const sz   = BUBBLE_R * 2;
  const wrap = document.createElement('div');
  wrap.id = 'collab-local-bubble';
  wrap.style.cssText = [
    'position:fixed', `bottom:80px`, `left:16px`,
    `width:${sz}px`, `height:${sz}px`,
    'border-radius:50%', 'overflow:hidden',
    `border:3px solid ${_myColor}`,
    'box-shadow:0 4px 20px rgba(0,0,0,0.45)',
    'z-index:500', 'cursor:move', 'background:#000',
  ].join(';');

  const vid = document.createElement('video');
  vid.autoplay=true; vid.muted=true; vid.playsInline=true;
  vid.style.cssText = 'width:100%;height:100%;object-fit:cover;transform:scaleX(-1)';
  vid.srcObject = _localStream;
  wrap.appendChild(vid);

  const lbl = document.createElement('div');
  lbl.style.cssText = [
    'position:absolute','bottom:0','left:0','right:0',
    'text-align:center','font-family:Cabinet Grotesk,sans-serif',
    'font-weight:700','font-size:9px','color:#fff',
    'background:rgba(0,0,0,0.5)','padding:2px 0',
  ].join(';');
  lbl.textContent = 'You';
  wrap.appendChild(lbl);

  _makeBubbleDraggable(wrap);
  document.body.appendChild(wrap);
}

// ── Peer video bubble ─────────────────────────────────────────────────────
function _createPeerBubble(sid, name, color) {
  if (_peerBubbles[sid]) return;
  const sz   = BUBBLE_R * 2;
  const wrap = document.createElement('div');
  wrap.id = 'collab-peer-bubble-' + sid;
  wrap.style.cssText = [
    'position:fixed', 'left:-300px', 'top:-300px',
    `width:${sz}px`, `height:${sz}px`,
    'border-radius:50%', 'overflow:hidden',
    `border:3px solid ${color||'#E05A3A'}`,
    'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
    'z-index:499', 'pointer-events:none', 'background:#111',
    'transition:left 80ms linear, top 80ms linear',
  ].join(';');

  const vid = document.createElement('video');
  vid.autoplay=true; vid.playsInline=true;
  vid.style.cssText = 'width:100%;height:100%;object-fit:cover';
  wrap.appendChild(vid);

  const lbl = document.createElement('div');
  lbl.style.cssText = [
    'position:absolute','bottom:0','left:0','right:0',
    'text-align:center','font-family:Cabinet Grotesk,sans-serif',
    'font-weight:700','font-size:9px','color:#fff',
    'background:rgba(0,0,0,0.55)','padding:2px 0',
    'white-space:nowrap','overflow:hidden','text-overflow:ellipsis',
  ].join(';');
  lbl.textContent = name;
  wrap.appendChild(lbl);

  document.body.appendChild(wrap);
  _peerBubbles[sid] = wrap;
  _peerVideos[sid]  = vid;
}

function _movePeerBubble(sid, x, y) {
  const b = _peerBubbles[sid]; if (!b) return;
  b.style.left = (x + 16) + 'px';
  b.style.top  = (y - BUBBLE_R * 2 - 8) + 'px';
}

function _closePeerConn(sid) {
  _peerConns[sid]?.close();
  delete _peerConns[sid];
  _peerBubbles[sid]?.remove();
  delete _peerBubbles[sid];
  delete _peerVideos[sid];
}

function _clearAllPeerBubbles() {
  Object.keys(_peerBubbles).forEach(_closePeerConn);
}

// ── WebRTC ────────────────────────────────────────────────────────────────
async function _createPeerConn(sid, isInitiator) {
  if (_peerConns[sid]) return _peerConns[sid];
  const pc = new RTCPeerConnection(RTC_CFG);
  _peerConns[sid] = pc;

  // Add local tracks
  _localStream?.getTracks().forEach(t => pc.addTrack(t, _localStream));

  // Receive remote video
  pc.ontrack = e => {
    const vid = _peerVideos[sid];
    if (vid && e.streams[0]) { vid.srcObject = e.streams[0]; }
  };

  pc.onicecandidate = e => {
    if (e.candidate && _socket) {
      _socket.emit('webrtc_ice', { room:_room, to:sid, candidate:e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed','disconnected','closed'].includes(pc.connectionState)) {
      _closePeerConn(sid);
    }
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    _socket?.emit('webrtc_offer', { room:_room, to:sid, sdp:pc.localDescription });
  }
  return pc;
}

async function _handleOffer(from, sdp) {
  // Create bubble for this peer if not yet visible
  const peerInfo = { sid:from, name:'Peer', color:'#E05A3A' };
  _createPeerBubble(from, peerInfo.name, peerInfo.color);

  const pc = await _createPeerConn(from, false);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  _socket?.emit('webrtc_answer', { room:_room, to:from, sdp:pc.localDescription });
}

async function _handleAnswer(from, sdp) {
  const pc = _peerConns[from]; if (!pc) return;
  if (pc.signalingState === 'have-local-offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }
}

async function _handleIce(from, candidate) {
  const pc = _peerConns[from]; if (!pc) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
}

// ── Draggable bubble helper ───────────────────────────────────────────────
function _makeBubbleDraggable(el) {
  let dx=0, dy=0, sx=0, sy=0, dragging=false;
  el.addEventListener('mousedown', e => {
    dragging = true; sx=e.clientX; sy=e.clientY;
    const r = el.getBoundingClientRect();
    // Switch to top/left absolute positioning
    el.style.bottom=''; el.style.right='';
    el.style.left = r.left + 'px'; el.style.top = r.top + 'px';
    dx = r.left; dy = r.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    el.style.left = (dx + e.clientX - sx) + 'px';
    el.style.top  = (dy + e.clientY - sy) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

// ── Utilities ─────────────────────────────────────────────────────────────
function _rgba(hex, a) {
  if (!hex||!hex.startsWith('#')||hex.length<7) return `rgba(0,0,0,${a})`;
  return `rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${a})`;
}

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  _buildUI();
  console.log('[collab] FlexaSense collaboration ready. Click "👥 Collaborate" to join.');
});

})();
