# Retree
A recreation of Scratch's remixtree feature because it was removed.

Runs as a fully static site (GitHub Pages). The browser talks directly to the
TurboWarp project API and the remix tree API; the layout / search / culling
engine is Rust compiled to WebAssembly (`rust/tree-wasm`).

## Deploy to GitHub Pages
1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main`. `.github/workflows/pages.yml` rebuilds the WASM and deploys.
3. If the tree never loads and the console shows a CORS error for `renderapi.quuq.dev`,
   deploy `worker/cors-proxy.js` to Cloudflare Workers and set `TREE_API_PROXY`
   in `assets/config.js`.

## Local dev
`npm run dev` then open http://localhost:3000

\
Some code from https://github.com/CST1229/treemix under the MIT license, modified by me.
The license for that code is [here](https://github.com/redspacecat/retree/blob/45bc1aff7117051631b93c058853bd2d9cf18092/assets/main.js#L303-L326)
