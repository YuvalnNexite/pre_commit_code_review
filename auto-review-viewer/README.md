# Auto Code Review Viewer

Render `auto_code_review.md` from a mounted directory with a polished, shareable UI. The viewer runs on Node.js + Express, uses markdown-it for Markdown rendering, highlight.js for syntax highlighting (including diff blocks), and Tailwind CSS for styling.

## Features

- Reads Markdown from a mounted directory (defaults to `SRC_DIR`/`FILENAME`).
- Clean typography with Tailwind and highlight.js.
- Sticky header with live file path display and dark mode toggle.
- Auto-refresh when the source file changes (polls `GET /mtime`).
- Health check endpoint at `GET /healthz` for container monitoring.

## How It Works

1. Place a review markdown file (defaults to `auto_code_review.md`) in the folder you bind-mount into the container.
2. The viewer loads that file, highlights any `BAD` assessments, and exposes their suggested diffs.
3. When you press **Apply** in the UI (or call `POST /api/assessments/:id/apply`), the server runs Git with
   `git apply --check --ignore-whitespace --whitespace=nowarn` followed by `git apply --ignore-whitespace --whitespace=nowarn` inside `REPO_DIR` (defaults to `SRC_DIR`).
4. Changes land directly on the bind-mounted directory, so your host working tree is updated immediately.
5. If Git raises a dubious ownership warning, the server registers the repo in `git config --global safe.directory` and retries automatically.

## Project structure

```
auto-review-viewer/
  app/
    server.js
    package.json
    templates/
      index.html
  Dockerfile
  docker-compose.yml
  README.md
```

## Configuration

| Variable   | Default               | Description                                  |
|----------- |-----------------------|----------------------------------------------|
| `SRC_DIR`  | `/data`               | Directory inside the container to read from. |
| `FILENAME` | `auto_code_review.md` | File name to render inside `SRC_DIR`.        |
| `REPO_DIR` | `/data`               | Git repository root used for applying diffs. |
| `PORT`     | `3000`                | Port exposed by the Express server.          |

## Local development

```bash
cd auto-review-viewer/app
npm install
# Optionally set where to read the markdown from:
SRC_DIR=/path/to/data FILENAME=auto_code_review.md npm start
```

On startup, the server uses `SRC_DIR` (if provided) as the default folder for `FILENAME`. The app serves the UI at http://localhost:3000.

## Docker

Build the container:

```bash
docker build -t auto-review-viewer ./auto-review-viewer
```

Run it, mounting the folder that contains `auto_code_review.md`:

```bash
docker run --rm -p 3000:3000 \
  -e SRC_DIR=/data \
  -e REPO_DIR=/data \
  -e FILENAME=auto_code_review.md \
  -v /absolute/path/to/markdown:/data \
  auto-review-viewer
```

Ensure the bind mount is read/write (omit `:ro`) so `git apply` can update your local files.
The server automatically registers the mounted repository as a Git safe directory; if you still see `dubious ownership` errors, run `git config --global --add safe.directory /data` inside the container.
After the container starts you can verify connectivity with:

```bash
docker exec -it <container> sh -lc "cd $REPO_DIR && git status -sb"
```

## Docker Compose

The included compose file makes it easy to bind a local directory:

```bash
cd auto-review-viewer
ACR_SOURCE=/absolute/path/to/repo \
ACR_FILENAME=auto_code_review.md docker compose up --build
```

Ensure `ACR_SOURCE` points to the Git repository you want to modify and keep the bind mount writable so suggestion patches can land on your host.
If you mount the repo somewhere else inside the container, set `ACR_REPO_DIR` to that path.

Environment variables:

- `ACR_SOURCE`: directory to mount at `/data` (defaults to `./data`).
- `ACR_FILENAME`: optional override for the markdown file name.
- `ACR_REPO_DIR`: optional container path passed to Git when applying suggestions (defaults to `/data`).

## Endpoints

- `GET /` render the Markdown file as rich HTML.
- `GET /mtime` return the file's last modified timestamp (`{ mtimeMs, iso }`).
- `GET /healthz` simple health check returning `{ status: "ok" }`.

## Future enhancements

The rendering pipeline is centralized in `server.js` so future features (BAD code annotations, diff-specific actions, WebSockets, etc.) can be layered without rewriting the core. The Docker base already includes Git to support git-aware functionality later on.

## Logging

Logs at level `ERROR` and `WARN` always print to the console. Set `LOG_TO_CONSOLE=true` to also surface `INFO`/`DEBUG` messages.
File logging is optional to reduce I/O; enable it with `LOG_TO_FILE=true` (writes to `new.log`).
