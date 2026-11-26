// Runtime configuration. Edit this file only if you need to change API endpoints.
window.TMT_CONFIG = {
    // Public TurboWarp project metadata API (sends CORS headers).
    PROJECT_API: "https://trampoline.turbowarp.org/api/projects/",
    // Remix tree page API used by the original server.
    TREE_API: "https://renderapi.quuq.dev/remixtree/",
    // OPTIONAL: if the browser blocks TREE_API with a CORS error, deploy
    // worker/cors-proxy.js to Cloudflare Workers and put its URL here,
    // e.g. "https://treemixtree-proxy.yourname.workers.dev/remixtree/"
    TREE_API_PROXY: "",
    PAGE_SIZE: 10,
    CONCURRENCY: 8,
    CACHE_TTL_MS: 15 * 60 * 1000,
};
