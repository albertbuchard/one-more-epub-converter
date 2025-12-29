# one-more-epub-converter

Client-side EPUB → TXT / printable HTML converter that runs entirely in the browser using epub.js.
Designed for Cloudflare Pages (static hosting only) with an optional Docker Compose setup for local use.

## Cloudflare Pages

This repo is static. Configure Pages to serve `public/` as the output directory.

- Framework preset: None
- Build command: (leave empty)
- Output directory: `public`

A `wrangler.toml` is included with `pages_build_output_dir = "public"` for `wrangler pages` workflows.

### Step-by-step: set up Cloudflare Pages

1. In the Cloudflare dashboard, go to **Pages**.
2. Click **Create a project**.
3. Choose **Connect to Git** (recommended) and select this repository.
4. In **Set up builds and deployments**:
   - **Framework preset**: `None`
   - **Build command**: _(leave empty)_
   - **Build output directory**: `public`
5. Click **Save and Deploy**.
6. After the first deploy finishes, open the provided `.pages.dev` URL to verify the site loads.

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
