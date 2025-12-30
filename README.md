# one-more-epub-converter

Client-side EPUB → TXT / printable HTML converter that runs entirely in the browser using epub.js.
Designed for Cloudflare Workers static assets with a Vite + React front-end.

## Cloudflare Workers (static assets)

This repo is fully static. Build assets into `public/` and configure Workers to serve `public/`.

- Build command: `npm run build`
- Assets directory: `public`

A `wrangler.toml` is included with `[assets]` configured for `wrangler deploy` workflows.

### Step-by-step: set up Cloudflare Workers

1. In the Cloudflare dashboard, go to **Workers & Pages**.
2. Click **Create application** and choose **Workers**.
3. Select **Import a repository** and pick this repo.
4. In **Build settings**:
   - **Build command**: `npm run build`
   - **Assets directory**: `public`
5. Click **Save and Deploy**.
6. After the first deploy finishes, open the provided `.workers.dev` URL to verify the site loads.

### Wrangler commands

```bash
# Local dev (serves built static assets)
npm run build
npx wrangler dev

# Deploy to Workers
npm run build
npx wrangler deploy
```

## Local development

```bash
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

## Build

```bash
npm run build
```

Build output is written to `public/`, which is what Cloudflare Workers serves.

## Manual testing (EPUB images)

1. Run the app locally (`npm run dev`) and open [http://localhost:5173](http://localhost:5173).
2. Upload an EPUB that contains multiple chapters and image assets.
3. Download **Single HTML file** and open the saved `.html` offline — images should render.
4. Download **ZIP (index.html only)**, unzip it, open `index.html` offline — images should render.
