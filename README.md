# Shelf

Self-hosted PDF reader for manga and light novels: library, series, paged, scroll and reflow
reading, search, bookmarks, offline use. A FastAPI backend serves a React frontend from one
container, with nothing loaded from a CDN.

## Run

```sh
docker network create proxy   # first time only, on a machine without Traefik
docker compose up -d --build
```

Open `http://YOUR-SERVER-IP:8080`, or `https://reader.marcel.co.nz` through Traefik. No `.env` is
needed. `docker compose down` keeps your data. `docker compose down -v` deletes the library.

## Organising

- **Series**: one per book, with a volume number that sets the order. Long-press, right-click or use the `...` menu on a series to rename it, merge it into another (this is how two misspellings become one), edit its author and type, or ungroup it. Renaming onto an existing series merges them. Moves have Undo.
- **Collections**: your own shelves, per user. A book can be in any number of them. They appear as filter chips in the library.
- **Move many at once**: Select in the library, then Move to series, Collections or More actions.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `USERS_API_URL` | `http://users-api:8000` | Login backend. Empty disables login. |
| `AUTH_FAIL_MODE` | `global` | `global` or `closed`: what happens while users-api is down. |
| `ALLOW_SIGNUP` | `true` | Allow new accounts. |
| `MAX_UPLOAD_MB` | `500` | Upload limit. |
| `DATA_DIR` | `/data` | Data location. |
| `FRONTEND_DIST` | `/app/frontend/dist` | Built frontend. |
| `CSRF_TRUSTED_ORIGINS` | empty | Extra allowed origins, comma separated. For the Vite dev server. |

## Auth

The browser only talks to the reader, which keeps its own `reader_session` cookie and validates it
against users-api. Health is cached for 15s, and tokens for 60s.

| users-api | Visitor | Result |
| --- | --- | --- |
| not configured, unreachable, 5xx, or missing capabilities | anyone | global: all documents visible, shared state |
| healthy | no or bad session | login required |
| healthy | valid session | own and shared documents, per-user state |

**During an outage**, with the default `AUTH_FAIL_MODE=global`, everyone can see and edit **every**
document, private ones included, with no login. Set `AUTH_FAIL_MODE=closed` to answer 503 on data
endpoints instead. Requests never wait more than about 2s on a hung users-api: the last known state
is served while a refresh runs in the background. Normal scoped mode returns by itself on recovery.

Login and signup are limited to 10 attempts a minute per IP and per username, in process.

## Data

Everything is in the `pdf_reader_data` volume, mounted at `/data`:

| Path | Contents |
| --- | --- |
| `library.sqlite3` | Database (WAL mode, with `-wal` and `-shm` files) |
| `pdfs/` | Uploaded files |
| `derived/<id>/` | Covers and reflow text, rebuilt by reprocessing |
| `tmp/` | Uploads in progress, cleared at boot |
| `reader.sqlite3.migrated` | The old app's database, after its one-time import |

Upgrading is automatic: migrations run at container start. When text extraction improves, books already in the library are re-read in the background, one at a time, and stay readable throughout. A book that fails keeps its old text and is tried again after the next restart.

## Backup

Stop the container so the database is consistent, then archive the volume:

```sh
docker compose stop
docker run --rm -v pdf-reader_pdf_reader_data:/data -v "$PWD":/backup alpine tar czf /backup/shelf.tgz -C /data .
docker compose start
```

The volume name is prefixed with the compose project, so check it with `docker volume ls`.

## Development

Backend, on Python 3.12:

```sh
cd backend
python -m venv ~/.venvs/shelf
~/.venvs/shelf/bin/pip install -r requirements-dev.txt
~/.venvs/shelf/bin/pytest
DATA_DIR=./.data ~/.venvs/shelf/bin/alembic upgrade head
DATA_DIR=./.data USERS_API_URL= CSRF_TRUSTED_ORIGINS=http://localhost:5173 FRONTEND_DIST=../frontend/dist \
  ~/.venvs/shelf/bin/uvicorn app.main:create_app --factory --reload
```

Frontend, proxying `/api` to port 8000:

```sh
cd frontend
npm ci
npm run dev
```
