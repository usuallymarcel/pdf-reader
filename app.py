import os
import sqlite3
import uuid
from pathlib import Path
from flask import Flask, jsonify, request, send_file, abort, render_template

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
PDF_DIR = DATA_DIR / "pdfs"
DB_PATH = DATA_DIR / "reader.sqlite3"
PDF_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("MAX_UPLOAD_MB", "500")) * 1024 * 1024

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                stored_name TEXT NOT NULL,
                uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_page INTEGER NOT NULL DEFAULT 1
            )
        """)

init_db()

@app.get("/")
def index():
    return render_template("index.html")

@app.get("/api/documents")
def list_documents():
    with db() as conn:
        rows = conn.execute("""
            SELECT id, filename, uploaded_at, last_page
            FROM documents ORDER BY uploaded_at DESC
        """).fetchall()
    return jsonify([dict(row) for row in rows])

@app.post("/api/documents")
def upload_document():
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify(error="Choose a PDF to upload."), 400
    if not uploaded.filename.lower().endswith(".pdf"):
        return jsonify(error="Only PDF files are supported."), 400

    doc_id = uuid.uuid4().hex
    stored_name = f"{doc_id}.pdf"
    destination = PDF_DIR / stored_name
    uploaded.save(destination)

    try:
        with db() as conn:
            conn.execute(
                "INSERT INTO documents (id, filename, stored_name) VALUES (?, ?, ?)",
                (doc_id, Path(uploaded.filename).name, stored_name),
            )
    except Exception:
        destination.unlink(missing_ok=True)
        raise

    return jsonify(id=doc_id), 201

@app.get("/api/documents/<doc_id>/file")
def get_pdf(doc_id):
    with db() as conn:
        row = conn.execute(
            "SELECT stored_name FROM documents WHERE id = ?", (doc_id,)
        ).fetchone()
    if row is None:
        abort(404)
    path = PDF_DIR / row["stored_name"]
    if not path.is_file():
        abort(404)
    response = send_file(path, mimetype="application/pdf", conditional=True)
    response.headers["Content-Disposition"] = "inline"
    return response

@app.put("/api/documents/<doc_id>/progress")
def save_progress(doc_id):
    payload = request.get_json(silent=True) or {}
    try:
        page = max(1, int(payload.get("page", 1)))
    except (TypeError, ValueError):
        return jsonify(error="Page must be a positive integer."), 400

    with db() as conn:
        cursor = conn.execute(
            "UPDATE documents SET last_page = ? WHERE id = ?", (page, doc_id)
        )
        if cursor.rowcount == 0:
            return jsonify(error="Document not found."), 404
    return jsonify(ok=True)

@app.delete("/api/documents/<doc_id>")
def delete_document(doc_id):
    with db() as conn:
        row = conn.execute(
            "SELECT stored_name FROM documents WHERE id = ?", (doc_id,)
        ).fetchone()
        if row is None:
            return jsonify(error="Document not found."), 404
        conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    (PDF_DIR / row["stored_name"]).unlink(missing_ok=True)
    return jsonify(ok=True)

@app.errorhandler(413)
def too_large(_error):
    return jsonify(error="That PDF is larger than the upload limit."), 413

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
