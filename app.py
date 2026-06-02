"""
app.py — FlexaSense with real-time canvas collaboration
Adds Flask-SocketIO on top of the existing app without changing any other file.

Architecture:
  - Each browser tab joins a "room" (default room: 'main')
  - When a user changes the canvas (move card, add card, draw stroke, add link, etc.)
    their browser emits a socket event → server broadcasts to all OTHER peers in the room
  - Peers receive the event and apply the change locally (canvas.js handles this)
  - Uploaded files are served from the shared uploads/ folder so all peers can load them

Run:
  python app.py
  # or for production:
  gunicorn -k geventwebsocket.handler.WebSocketHandler -w 1 app:app
"""

from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO, join_room, leave_room, emit
import os, uuid, re, json

# ── Logging setup ──────────────────────────────────────────────────────────
import logging
from logging.handlers import RotatingFileHandler

LOG_FILE    = os.path.join(os.path.dirname(__file__), 'app.log')
LOG_FORMAT  = '%(asctime)s  %(levelname)-8s  %(message)s'
LOG_DATE    = '%Y-%m-%d %H:%M:%S'
LOG_MAX     = 5 * 1024 * 1024   # 5 MB per file
LOG_BACKUPS = 3                  # keep app.log, app.log.1, app.log.2, app.log.3

# Root logger → both file and console
logging.basicConfig(
    level   = logging.DEBUG,
    format  = LOG_FORMAT,
    datefmt = LOG_DATE,
    handlers= [
        RotatingFileHandler(LOG_FILE, maxBytes=LOG_MAX, backupCount=LOG_BACKUPS, encoding='utf-8'),
        logging.StreamHandler(),           # still prints to terminal
    ]
)
log = logging.getLogger('flexasense')

# Quiet down Flask/SocketIO/werkzeug noise (keep WARNING+ only)
logging.getLogger('werkzeug').setLevel(logging.WARNING)
logging.getLogger('socketio').setLevel(logging.WARNING)
logging.getLogger('engineio').setLevel(logging.WARNING)

log.info('=' * 60)
log.info('FlexaSense server starting')
log.info(f'Log file: {LOG_FILE}')
log.info('=' * 60)

try:
    import pypdf
    HAS_PYPDF = True
    log.info('pypdf available — PDF text extraction enabled')
except ImportError:
    HAS_PYPDF = False
    log.warning('pypdf not installed — PDF text extraction disabled')

app = Flask(__name__)
app.config['SECRET_KEY']        = 'flexasense-collab-secret'
app.config['UPLOAD_FOLDER']     = os.path.join(os.path.dirname(__file__), 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024

# ── Clear uploads on every server start (session files are temporary) ─────
import shutil
_upload_dir = app.config['UPLOAD_FOLDER']
if os.path.exists(_upload_dir):
    shutil.rmtree(_upload_dir)
os.makedirs(_upload_dir)
log.info('Uploads folder cleared — new session started')

# Threading mode — works without eventlet/gevent
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

# ── In-memory room state ──────────────────────────────────────────────────
_room_state = {}   # room_id -> { cards, stickies, strokes, links, files }
_room_peers = {}   # room_id -> { sid -> { name, color, cursor } }

def _get_room(room):
    if room not in _room_state:
        _room_state[room] = { 'cards': {}, 'stickies': {}, 'strokes': {}, 'links': {}, 'files': {} }
    if room not in _room_peers:
        _room_peers[room] = {}
    return _room_state[room], _room_peers[room]

# ── HTTP routes ───────────────────────────────────────────────────────────
ALLOWED = {
    'pdf':      ['.pdf'],
    'video':    ['.mp4', '.mov', '.webm', '.ogg', '.m4v'],
    'notebook': ['.ipynb', '.py', '.txt', '.json'],
}

def detect_type(filename):
    ext = os.path.splitext(filename)[1].lower()
    for t, exts in ALLOWED.items():
        if ext in exts:
            return t
    return None

@app.route('/')
def index():
    log.debug(f'GET /  →  client {request.remote_addr}')
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload():
    if 'file' not in request.files:
        log.warning('Upload rejected — no file part in request')
        return jsonify({'error': 'No file part'}), 400
    f = request.files['file']
    if not f.filename:
        log.warning('Upload rejected — empty filename')
        return jsonify({'error': 'Empty filename'}), 400
    ftype = detect_type(f.filename)
    if not ftype:
        log.warning(f'Upload rejected — unsupported file type: {f.filename}')
        return jsonify({'error': 'Unsupported file type'}), 400
    ext   = os.path.splitext(f.filename)[1].lower()
    uid   = str(uuid.uuid4())
    fname = uid + ext
    dest  = os.path.join(app.config['UPLOAD_FOLDER'], fname)
    f.save(dest)
    size_kb = os.path.getsize(dest) // 1024
    log.info(f'File uploaded: "{f.filename}"  type={ftype}  size={size_kb}KB  id={uid}')
    return jsonify({'id': uid, 'name': f.filename, 'type': ftype,
                    'path': f'/file/{fname}', 'fname': fname})

@app.route('/file/<filename>')
def serve_file(filename):
    log.debug(f'Serving file: {filename}')
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

@app.route('/extract_text')
def extract_text():
    fname = request.args.get('fname', '')
    if not fname or '/' in fname or '..' in fname:
        log.warning(f'extract_text: invalid fname "{fname}"')
        return jsonify({'pages': []})
    full = os.path.join(app.config['UPLOAD_FOLDER'], fname)
    if not os.path.exists(full):
        log.warning(f'extract_text: file not found "{fname}"')
        return jsonify({'pages': []})
    if not HAS_PYPDF:
        return jsonify({'pages': [], 'error': 'pypdf not installed'})
    try:
        reader = pypdf.PdfReader(full)
        pages  = []
        for pi, page in enumerate(reader.pages):
            raw   = page.extract_text() or ''
            sents = [s.strip() for s in re.split(r'(?<=[.!?])\s+', raw) if len(s.strip()) > 15]
            pages.append({'page': pi + 1, 'sentences': sents})
        log.info(f'Text extracted: {fname}  ({len(pages)} pages)')
        return jsonify({'pages': pages})
    except Exception as e:
        log.error(f'Text extraction failed for "{fname}": {e}', exc_info=True)
        return jsonify({'pages': [], 'error': str(e)})

@app.route('/reset_session', methods=['POST'])
def reset_session_files():
    upload_dir = app.config['UPLOAD_FOLDER']
    try:
        shutil.rmtree(upload_dir)
        os.makedirs(upload_dir)
    except Exception as e:
        log.error(f'reset_session failed: {e}', exc_info=True)
        return jsonify({'ok': False, 'error': str(e)}), 500
    _room_state.clear()
    _room_peers.clear()
    log.info('Session reset — uploads and room state cleared')
    return jsonify({'ok': True})

@app.route('/collab/debug')
def collab_debug():
    out = {}
    for room, state in _room_state.items():
        peers = _room_peers.get(room, {})
        out[room] = {
            'peers':   list(peers.values()),
            'cards':   len(state['cards']),
            'stickies':len(state.get('stickies',{})),
            'strokes': len(state['strokes']),
            'links':   len(state['links']),
            'files':   list(state['files'].keys()),
        }
    log.debug(f'Debug endpoint accessed — rooms: {list(out.keys())}')
    return jsonify(out)

# ── Socket.IO events ──────────────────────────────────────────────────────
@socketio.on('connect')
def on_connect():
    log.info(f'CONNECT    sid={request.sid}  ip={request.remote_addr}')

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    for room, peers in _room_peers.items():
        if sid in peers:
            name = peers[sid].get('name', 'Someone')
            del peers[sid]
            emit('peer_left', {'sid': sid, 'name': name}, to=room, skip_sid=sid)
            log.info(f'DISCONNECT sid={sid}  name="{name}"  room={room}  peers_left={len(peers)}')
            break
    else:
        log.debug(f'DISCONNECT sid={sid}  (was not in any room)')

@socketio.on('join_room')
def on_join_room(data):
    room  = data.get('room', 'main')
    name  = data.get('name', 'Peer')
    color = data.get('color', '#2563EB')

    join_room(room)
    state, peers = _get_room(room)
    peers[request.sid] = {'sid': request.sid, 'name': name, 'color': color, 'cursor': None}

    snapshot_summary = {
        'cards':   len(state['cards']),
        'stickies':len(state.get('stickies',{})),
        'strokes': len(state['strokes']),
        'links':   len(state['links']),
        'files':   len(state['files']),
    }
    emit('room_snapshot', {
        'room':    room,
        'state':   state,
        'peers':   [p for s, p in peers.items() if s != request.sid],
    })
    emit('peer_joined', {'sid': request.sid, 'name': name, 'color': color},
         to=room, skip_sid=request.sid)

    log.info(f'JOIN       sid={request.sid}  name="{name}"  room="{room}"  '
             f'peers={len(peers)}  snapshot={snapshot_summary}')

# ── Canvas sync events ────────────────────────────────────────────────────
@socketio.on('canvas_card_add')
def on_card_add(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state['cards'][data['id']] = data
    emit('canvas_card_add', data, to=room, skip_sid=request.sid)
    log.info(f'CARD_ADD   room="{room}"  id={data["id"]}  '
             f'type={data.get("fileEntry",{}).get("type","?")}  '
             f'total_cards={len(state["cards"])}')

@socketio.on('canvas_card_move')
def on_card_move(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    if data['id'] in state['cards']:
        state['cards'][data['id']]['x'] = data['x']
        state['cards'][data['id']]['y'] = data['y']
    if data['id'] in state.get('stickies', {}):
        state['stickies'][data['id']]['x'] = data['x']
        state['stickies'][data['id']]['y'] = data['y']
    emit('canvas_card_move', data, to=room, skip_sid=request.sid)
    log.debug(f'CARD_MOVE  room="{room}"  id={data["id"]}  x={data.get("x")}  y={data.get("y")}')

@socketio.on('canvas_sticky_add')
def on_sticky_add(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state.setdefault('stickies', {})[data['id']] = data
    emit('canvas_sticky_add', data, to=room, skip_sid=request.sid)
    log.info(f'STICKY_ADD room="{room}"  id={data["id"]}  total={len(state["stickies"])}')

@socketio.on('canvas_card_resize')
def on_card_resize(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    if data['id'] in state['cards']:
        state['cards'][data['id']].update({'w': data['w'], 'h': data['h']})
    emit('canvas_card_resize', data, to=room, skip_sid=request.sid)
    log.debug(f'CARD_RESIZE room="{room}"  id={data["id"]}  w={data.get("w")}  h={data.get("h")}')

@socketio.on('canvas_card_delete')
def on_card_delete(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state['cards'].pop(data['id'], None)
    state.get('stickies', {}).pop(data['id'], None)
    emit('canvas_card_delete', data, to=room, skip_sid=request.sid)
    log.info(f'CARD_DEL   room="{room}"  id={data["id"]}  cards_left={len(state["cards"])}')

@socketio.on('canvas_stroke_add')
def on_stroke_add(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state['strokes'][data['id']] = data
    emit('canvas_stroke_add', data, to=room, skip_sid=request.sid)
    pts = len(data.get('points', []))
    log.info(f'STROKE_ADD room="{room}"  id={data["id"]}  points={pts}  '
             f'color={data.get("color")}  total={len(state["strokes"])}')

@socketio.on('canvas_stroke_delete')
def on_stroke_delete(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state['strokes'].pop(data['id'], None)
    emit('canvas_stroke_delete', data, to=room, skip_sid=request.sid)
    log.info(f'STROKE_DEL room="{room}"  id={data["id"]}  strokes_left={len(state["strokes"])}')

@socketio.on('canvas_link_add')
def on_link_add(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    link_id = data.get('linkId')
    if link_id:
        state['links'][link_id] = data
    emit('canvas_link_add', data, to=room, skip_sid=request.sid)
    anchor = data.get('anchor', {})
    log.info(f'LINK_ADD   room="{room}"  linkId={link_id}  '
             f'type={anchor.get("type")}  cardId={data.get("cardId")}  '
             f'total={len(state["links"])}')

@socketio.on('canvas_link_delete')
def on_link_delete(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state['links'].pop(data.get('linkId', ''), None)
    emit('canvas_link_delete', data, to=room, skip_sid=request.sid)
    log.info(f'LINK_DEL   room="{room}"  linkId={data.get("linkId")}  links_left={len(state["links"])}')

@socketio.on('file_shared')
def on_file_shared(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state['files'][data['id']] = data
    emit('file_shared', data, to=room, skip_sid=request.sid)
    log.info(f'FILE_SHARE room="{room}"  id={data["id"]}  name="{data.get("name")}"  '
             f'type={data.get("type")}  total={len(state["files"])}')

@socketio.on('cursor_move')
def on_cursor(data):
    room = data.get('room', 'main')
    _, peers = _get_room(room)
    if request.sid in peers:
        peers[request.sid]['cursor'] = {'x': data.get('x'), 'y': data.get('y')}
    emit('cursor_move', {**data, 'sid': request.sid}, to=room, skip_sid=request.sid)
    # cursor_move fires ~25x/sec — log at DEBUG only to avoid log spam
    log.debug(f'CURSOR     room="{room}"  sid={request.sid}  x={data.get("x")}  y={data.get("y")}')

@socketio.on('canvas_clear')
def on_canvas_clear(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    counts = {k: len(state[k]) for k in ('cards','stickies','strokes','links')}
    state['cards']    = {}
    state['stickies'] = {}
    state['strokes']  = {}
    state['links']    = {}
    emit('canvas_clear', data, to=room, skip_sid=request.sid)
    log.warning(f'CANVAS_CLR room="{room}"  cleared={counts}')

# ── WebRTC signaling relay ────────────────────────────────────────────────
@socketio.on('webrtc_offer')
def on_webrtc_offer(data):
    to = data.get('to')
    emit('webrtc_offer', {**data, 'from': request.sid}, to=to)
    log.debug(f'WEBRTC_OFFER  from={request.sid} → to={to}')

@socketio.on('webrtc_answer')
def on_webrtc_answer(data):
    to = data.get('to')
    emit('webrtc_answer', {**data, 'from': request.sid}, to=to)
    log.debug(f'WEBRTC_ANSWER from={request.sid} → to={to}')

@socketio.on('webrtc_ice')
def on_webrtc_ice(data):
    to = data.get('to')
    emit('webrtc_ice', {**data, 'from': request.sid}, to=to)
    log.debug(f'WEBRTC_ICE    from={request.sid} → to={to}')

# ── Error handler ─────────────────────────────────────────────────────────
@socketio.on_error_default
def on_socket_error(e):
    log.error(f'SOCKET_ERROR  sid={request.sid}  error={e}', exc_info=True)

@app.errorhandler(Exception)
def on_http_error(e):
    log.error(f'HTTP_ERROR  {request.method} {request.path}  error={e}', exc_info=True)
    return jsonify({'error': str(e)}), 500

# ── Startup ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    log.info(f'Starting server on 0.0.0.0:{port}')
    log.info(f'Debug room state: http://localhost:{port}/collab/debug')
    log.info(f'Log file:         {LOG_FILE}')
    socketio.run(
        app,
        host="0.0.0.0",
        port=port,
        debug=False,
        allow_unsafe_werkzeug=True
    )
