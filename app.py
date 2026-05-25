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

try:
    import pypdf
    HAS_PYPDF = True
except ImportError:
    HAS_PYPDF = False

app = Flask(__name__)
app.config['SECRET_KEY']       = 'flexasense-collab-secret'
app.config['UPLOAD_FOLDER']    = os.path.join(os.path.dirname(__file__), 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# Threading mode — works without eventlet/gevent
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

# ── In-memory room state (survives across connections, resets on server restart)
# Each room stores the latest known canvas snapshot so late-joiners get full state
_room_state = {}   # room_id -> { cards, strokes, links, files }
_room_peers = {}   # room_id -> { sid -> { name, color, cursor } }

def _get_room(room):
    if room not in _room_state:
        _room_state[room] = { 'cards': {}, 'strokes': {}, 'links': {}, 'files': {} }
    if room not in _room_peers:
        _room_peers[room] = {}
    return _room_state[room], _room_peers[room]

# ── HTTP routes (unchanged from original) ─────────────────────────────────
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
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    f = request.files['file']
    if not f.filename:
        return jsonify({'error': 'Empty filename'}), 400
    ftype = detect_type(f.filename)
    if not ftype:
        return jsonify({'error': 'Unsupported file type'}), 400
    ext   = os.path.splitext(f.filename)[1].lower()
    uid   = str(uuid.uuid4())
    fname = uid + ext
    f.save(os.path.join(app.config['UPLOAD_FOLDER'], fname))
    return jsonify({'id': uid, 'name': f.filename, 'type': ftype,
                    'path': f'/file/{fname}', 'fname': fname})

@app.route('/file/<filename>')
def serve_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

@app.route('/extract_text')
def extract_text():
    fname = request.args.get('fname', '')
    if not fname or '/' in fname or '..' in fname:
        return jsonify({'pages': []})
    full = os.path.join(app.config['UPLOAD_FOLDER'], fname)
    if not os.path.exists(full):
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
        return jsonify({'pages': pages})
    except Exception as e:
        return jsonify({'pages': [], 'error': str(e)})

# ── Debug endpoint — inspect live room state ──────────────────────────────
@app.route('/collab/debug')
def collab_debug():
    """Shows current room state. Open in browser for easy debugging."""
    out = {}
    for room, state in _room_state.items():
        peers = _room_peers.get(room, {})
        out[room] = {
            'peers':   list(peers.values()),
            'cards':   len(state['cards']),
            'strokes': len(state['strokes']),
            'links':   len(state['links']),
            'files':   list(state['files'].keys()),
        }
    return jsonify(out)

# ── Socket.IO events ──────────────────────────────────────────────────────
@socketio.on('connect')
def on_connect():
    print(f'[collab] peer connected: {request.sid}')

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    # Remove from all rooms
    for room, peers in _room_peers.items():
        if sid in peers:
            name = peers[sid].get('name', 'Someone')
            del peers[sid]
            emit('peer_left', {'sid': sid, 'name': name}, to=room, skip_sid=sid)
            print(f'[collab] {name} left room {room}')
            break

@socketio.on('join_room')
def on_join_room(data):
    """Client joins a collaboration room and receives full current state."""
    room  = data.get('room', 'main')
    name  = data.get('name', 'Peer')
    color = data.get('color', '#2563EB')

    join_room(room)
    state, peers = _get_room(room)
    peers[request.sid] = {'sid': request.sid, 'name': name, 'color': color, 'cursor': None}

    # Send current room snapshot to the new peer only
    emit('room_snapshot', {
        'room':    room,
        'state':   state,
        'peers':   [p for s, p in peers.items() if s != request.sid],
    })

    # Tell everyone else a new peer joined
    emit('peer_joined', {'sid': request.sid, 'name': name, 'color': color},
         to=room, skip_sid=request.sid)

    print(f'[collab] {name} joined room {room} ({len(peers)} peers total)')

# ── Canvas sync events ─────────────────────────────────────────────────────
# Each event: store in room state, then broadcast to peers (skip sender)

@socketio.on('canvas_card_add')
def on_card_add(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state['cards'][data['id']] = data
    emit('canvas_card_add', data, to=room, skip_sid=request.sid)

@socketio.on('canvas_card_move')
def on_card_move(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    if data['id'] in state['cards']:
        state['cards'][data['id']]['x'] = data['x']
        state['cards'][data['id']]['y'] = data['y']
    emit('canvas_card_move', data, to=room, skip_sid=request.sid)

@socketio.on('canvas_card_resize')
def on_card_resize(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    if data['id'] in state['cards']:
        state['cards'][data['id']].update({'w': data['w'], 'h': data['h']})
    emit('canvas_card_resize', data, to=room, skip_sid=request.sid)

@socketio.on('canvas_card_delete')
def on_card_delete(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state['cards'].pop(data['id'], None)
    emit('canvas_card_delete', data, to=room, skip_sid=request.sid)

@socketio.on('canvas_stroke_add')
def on_stroke_add(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state['strokes'][data['id']] = data
    emit('canvas_stroke_add', data, to=room, skip_sid=request.sid)

@socketio.on('canvas_stroke_delete')
def on_stroke_delete(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state['strokes'].pop(data['id'], None)
    emit('canvas_stroke_delete', data, to=room, skip_sid=request.sid)

@socketio.on('canvas_link_add')
def on_link_add(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state['links'][data['id']] = data
    emit('canvas_link_add', data, to=room, skip_sid=request.sid)

@socketio.on('canvas_link_delete')
def on_link_delete(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state['links'].pop(data['id'], None)
    emit('canvas_link_delete', data, to=room, skip_sid=request.sid)

@socketio.on('file_shared')
def on_file_shared(data):
    """A peer uploaded a file — tell others so they can register it in FILES."""
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state['files'][data['id']] = data
    emit('file_shared', data, to=room, skip_sid=request.sid)

@socketio.on('cursor_move')
def on_cursor(data):
    """Broadcast cursor position for live presence cursors."""
    room = data.get('room', 'main')
    _, peers = _get_room(room)
    if request.sid in peers:
        peers[request.sid]['cursor'] = {'x': data.get('x'), 'y': data.get('y')}
    emit('cursor_move', {**data, 'sid': request.sid}, to=room, skip_sid=request.sid)

@socketio.on('canvas_clear')
def on_canvas_clear(data):
    room = data.get('room', 'main')
    state, _ = _get_room(room)
    state['cards']   = {}
    state['strokes'] = {}
    state['links']   = {}
    emit('canvas_clear', data, to=room, skip_sid=request.sid)

# ── WebRTC signaling relay (server just forwards, never touches media) ──────
@socketio.on('webrtc_offer')
def on_webrtc_offer(data):
    to  = data.get('to')
    emit('webrtc_offer',  {**data, 'from': request.sid}, to=to)

@socketio.on('webrtc_answer')
def on_webrtc_answer(data):
    to  = data.get('to')
    emit('webrtc_answer', {**data, 'from': request.sid}, to=to)

@socketio.on('webrtc_ice')
def on_webrtc_ice(data):
    to  = data.get('to')
    emit('webrtc_ice',    {**data, 'from': request.sid}, to=to)

if __name__ == '__main__':
    print('FlexaSense collab server starting on http://localhost:5050')
    print('Debug room state: http://localhost:5050/collab/debug')
    socketio.run(app, debug=True, port=5050, allow_unsafe_werkzeug=True)
