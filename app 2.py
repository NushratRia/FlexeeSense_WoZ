from flask import Flask, render_template, request, jsonify, send_from_directory
import os, uuid, re

try:
    import pypdf
    HAS_PYPDF = True
except ImportError:
    HAS_PYPDF = False

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = os.path.join(os.path.dirname(__file__), 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

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
        pages = []
        for pi, page in enumerate(reader.pages):
            raw = page.extract_text() or ''
            # split into sentences
            sents = [s.strip() for s in re.split(r'(?<=[.!?])\s+', raw) if len(s.strip()) > 15]
            pages.append({'page': pi + 1, 'sentences': sents})
        return jsonify({'pages': pages})
    except Exception as e:
        return jsonify({'pages': [], 'error': str(e)})

if __name__ == '__main__':
    app.run(debug=True, port=5050)
