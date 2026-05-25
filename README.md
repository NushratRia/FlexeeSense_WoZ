# FlexeeSense WoZ

## Folder structure

```
app.py
requirements.txt
templates/
  index.html
static/
  css/
    main.css
  js/
    app.js
    canvas.js
    collab.js
    draw.js
    links.js
    pdf_viewer.js
    resize.js
    upload.js
    viewer.js
uploads/
```

A collaborative web workspace for sketching, annotating, and linking documents, videos, and code. This project combines a shared canvas, modal file viewers, and live peer sync using Flask + Flask-SocketIO.

## Key features

- Real-time multi-user collaboration on a shared canvas
- Supports PDF, video, notebook/code and sticky note cards
- Drag, resize, move, delete cards with live sync
- Freehand canvas drawing with stroke sync
- Upload files and share them across participants
- In-browser PDF viewer with highlight/comment/link support
- Notebook and code viewer with line linking
- Live presence cursors and join/leave notifications
- `/collab/debug` endpoint for inspecting live session state

## Project structure

- `app.py` — Flask app, upload handling, Socket.IO sync, and debug endpoint
- `requirements.txt` — Python dependencies
- `templates/index.html` — main frontend interface
- `static/css/main.css` — app styling
- `static/js/` — client-side viewer, canvas, upload, and collaboration logic
- `uploads/` — persisted uploads served by Flask

## Requirements

- Python 3.10+ (tested with Python 3.12)
- `flask`
- `flask-socketio`
- Optional: `pypdf` for PDF text extraction

Install dependencies:

```bash
pip install -r requirements.txt
```

If you do not need PDF text extraction, `pypdf` may be omitted but the `/extract_text` route will return an error message.

## Run locally

1. From the project root:

```bash
python app.py
```

2. Open your browser at:

```text
http://localhost:5050
```

The server listens on port `5050` by default.

## Usage

### Start a collaboration session

- Click **👥 Collaborate** in the top-right toolbar.
- Enter a display name, room name, and color.
- Join the room. Other users who join the same room name will share the canvas.

### Work with files

- Use the PDF / Video / Notebook tabs to upload content.
- Drag files onto the viewer dropzones or browse using the upload picker.
- Uploaded files are served from `uploads/` and shared with collaborators.
- Files supported:
  - PDF: `.pdf`
  - Video: `.mp4`, `.mov`, `.webm`, `.ogg`, `.m4v`
  - Notebook/Code/Text: `.ipynb`, `.py`, `.txt`, `.json`

### Canvas interactions

- `Select` to move and manage existing cards
- `Sticky` to add quick note cards
- `Draw` to sketch freehand on the canvas
- `Attach` to create cards from loaded PDF/video/notebook content
- `Links` to connect viewer content and canvas cards
- `Clear` to reset the canvas state

### Collaboration sync

The app syncs the following in real time:

- Canvas cards created, moved, resized, deleted
- Draw strokes created and deleted
- Shared files registered in the room
- Peer cursor movement for live presence
- Canvas clear events

### What is not synchronized

- Local PDF viewer scroll position
- Individual PDF annotation state if it is purely local to the viewer

## Endpoints

- `/` — Main app interface
- `/upload` — File upload endpoint
- `/file/<filename>` — Serve uploaded file from `uploads/`
- `/extract_text?fname=<filename>` — Extract PDF text if `pypdf` is installed
- `/collab/debug` — Debug view of live room state

## Collaboration architecture

The server keeps an in-memory snapshot for each room. When a user joins, the server sends the room snapshot to late joiners so they can restore the current canvas state.

Socket events handled by the server include:

- `join_room`
- `canvas_card_add`, `canvas_card_move`, `canvas_card_resize`, `canvas_card_delete`
- `canvas_stroke_add`, `canvas_stroke_delete`
- `canvas_link_add`, `canvas_link_delete`
- `file_shared`
- `cursor_move`
- `canvas_clear`
- `webrtc_offer`, `webrtc_answer`, `webrtc_ice`

## Notes

- Uploaded files are stored in `uploads/` and served directly by Flask.
- Room state is held in memory and resets when the server restarts.
- For production deployment, use a WSGI server compatible with Socket.IO, such as `gunicorn -k geventwebsocket.handler.WebSocketHandler`.


