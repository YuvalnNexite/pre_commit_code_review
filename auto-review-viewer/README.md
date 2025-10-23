# Auto Code Review Viewer

Render `auto_code_review.md` from a mounted directory with a polished, shareable UI. The viewer runs on Node.js + Express, uses markdown-it for Markdown rendering, highlight.js for syntax highlighting (including diff blocks), and Tailwind CSS for styling.

## Features

- 📄 Reads Markdown from a mounted directory (`/data/auto_code_review.md` by default).
- 🎨 Beautiful typography powered by Tailwind's typography plugin and highlight.js.
- 🌓 Sticky header with live file path display and dark mode toggle.
- 🔁 Automatic refresh when the source file changes (polls `GET /mtime`).
- 💓 Health check endpoint at `GET /healthz` for container monitoring.

## Project structure

```
auto-review-viewer/
├─ app/
│  ├─ server.js
│  ├─ package.json
│  └─ templates/
│     └─ index.html
├─ Dockerfile
├─ docker-compose.yml
└─ README.md
```

## Configuration

| Variable   | Default                | Description                                   |
|------------|------------------------|-----------------------------------------------|
| `SRC_DIR`  | `/data`                | Directory inside the container to read from. |
| `FILENAME` | `auto_code_review.md`  | File name to render inside `SRC_DIR`.         |
| `PORT`     | `3000`                 | Port exposed by the Express server.          |

## Local development

```bash
cd auto-review-viewer/app
npm install
SRC_DIR=/path/to/data FILENAME=auto_code_review.md npm start
```

The app serves the UI at [http://localhost:3000](http://localhost:3000).

## Docker

Build the container:

```bash
docker build -t auto-review-viewer ./auto-review-viewer
```

Run it, mounting the folder that contains `auto_code_review.md`:

```bash
docker run --rm -p 3000:3000 \
  -e SRC_DIR=/data \
  -e FILENAME=auto_code_review.md \
  -v /absolute/path/to/markdown:/data \
  auto-review-viewer
```

## Docker Compose

The included compose file makes it easy to bind a local directory:

```bash
cd auto-review-viewer
ACR_SOURCE=/absolute/path/to/markdown docker compose up --build
```

Environment variables:

- `ACR_SOURCE`: directory to mount at `/data` (defaults to `./data`).
- `ACR_FILENAME`: optional override for the markdown file name.

## Endpoints

- `GET /` – render the Markdown file as rich HTML.
- `GET /mtime` – return the file's last modified timestamp (`{ mtimeMs, iso }`).
- `GET /healthz` – simple health check returning `{ status: "ok" }`.

## Future enhancements

The rendering pipeline is centralized in `server.js` so future features (BAD code annotations, diff-specific actions, WebSockets, etc.) can be layered without rewriting the core. The Docker base already includes Git to support git-aware functionality later on.
