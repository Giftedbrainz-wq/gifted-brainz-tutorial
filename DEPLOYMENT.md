# Gifted Brainz — deployment notes

Deploy from the repository root with Git-connected Netlify deployment.

Required structure:
- netlify.toml
- public/
- netlify/functions/api.mjs
- netlify/functions/api-core.mjs
- netlify/functions/ping.js
- netlify/functions/ping-core.mjs
- netlify/lib/seed.mjs

The app-update channel stores published runtime assets in the dedicated `gifted-brainz-runtime` Netlify Blobs store. Core application data remains in the `gifted-brainz` store.

Production Functions use Netlify's automatic Blobs runtime context. Do not put Blobs credentials in the repository.

After deployment, verify:
- /api/health returns JSON 200
- /api/status returns JSON and reports persistent storage
- admin login works
- a small admin upload completes
- App Update validation accepts a package containing public/, netlify/functions/api.mjs and api-core.mjs
