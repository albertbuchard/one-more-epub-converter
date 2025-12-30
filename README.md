# one-more-epub-converter

Client-side EPUB → TXT / printable HTML converter that runs entirely in the browser using epub.js.
Designed for Cloudflare Workers static assets with an optional Docker Compose setup for local use.

## Cloudflare Workers (static assets)

This repo is fully static. Configure Workers to serve `public/` as static assets.
There is no build step because assets are committed directly in `public/`.

- Build command: (leave empty)
- Assets directory: `public`

A `wrangler.toml` is included with `[assets]` configured for `wrangler deploy` workflows.

### Step-by-step: set up Cloudflare Workers

1. In the Cloudflare dashboard, go to **Workers & Pages**.
2. Click **Create application** and choose **Workers**.
3. Select **Import a repository** and pick this repo.
4. In **Build settings**:
   - **Build command**: _(leave empty)_
   - **Assets directory**: `public`
5. Click **Save and Deploy**.
6. After the first deploy finishes, open the provided `.workers.dev` URL to verify the site loads.

### Wrangler commands

```bash
# Local dev (serves static assets)
npx wrangler dev

# Deploy to Workers
npx wrangler deploy
```

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
