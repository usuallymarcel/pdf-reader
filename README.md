# PDF Reader

A small single-user PDF library. PDFs and the SQLite database live in the persistent
Docker volume `pdf_reader_data`. Reading position is saved per PDF and restored when
you open that PDF again.

## Start

```sh
docker compose up -d --build
```

Open `http://YOUR-SERVER-IP:8080`.

## Stop / remove

Stop the container but keep your books and reading positions:

```sh
docker compose down
```

Start again:

```sh
docker compose up -d
```

**Important:** `docker compose down -v` deletes the persistent volume and all uploaded
PDFs plus the database. Do not use `-v` unless you intend to wipe the library.

## Configuration

- Change the host port in `docker-compose.yml` (`8080:8000`).
- `MAX_UPLOAD_MB` defaults to 500.
- PDF.js is loaded from cdnjs, so the browser needs internet access to load the viewer library.
- This is intentionally a single-user app with no login. Do not expose it publicly without
  adding authentication or putting it behind an access-controlled network/proxy.
