# one-more-epub-converter

Client-side EPUB → TXT / printable HTML converter that runs entirely in the browser using Pyodide.
Designed for Cloudflare Pages (static hosting only) with an optional Docker Compose setup for local use.

## Cloudflare Pages

This repo is static. Configure Pages to serve `public/` as the output directory.

- Framework preset: None
- Build command: (leave empty)
- Output directory: `public`

A `wrangler.toml` is included with `pages_build_output_dir = "public"` for `wrangler pages` workflows.

## Local development

### Option 1: Docker Compose

```bash
docker compose up --build
```

Then open [http://localhost:8080](http://localhost:8080).

### Option 2: Python simple server

```bash
python -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000).
