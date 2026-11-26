// OPTIONAL Cloudflare Worker. Only needed if the browser blocks
// https://renderapi.quuq.dev/remixtree/ with a CORS error on your Pages domain.
//
// Deploy: Cloudflare dashboard -> Workers -> Create -> paste this file.
// Then set TREE_API_PROXY in assets/config.js to
//   "https://<your-worker>.workers.dev/remixtree/"
//
// Set ALLOWED_ORIGIN to your Pages origin, e.g. "https://insanitystudio.github.io".
const ALLOWED_ORIGIN = "https://insanitystudio.github.io";
const UPSTREAM = "https://renderapi.quuq.dev/remixtree/";

export default {
    async fetch(request) {
        const cors = {
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "*",
        };
        if (request.method === "OPTIONS") return new Response(null, { headers: cors });

        const url = new URL(request.url);
        const m = url.pathname.match(/^\/remixtree\/(\d+)$/);
        if (!m) return new Response("Not found", { status: 404, headers: cors });

        const offset = parseInt(url.searchParams.get("offset") || "0", 10) || 0;
        const refresh = url.searchParams.get("refresh") === "1";
        const upstream = await fetch(`${UPSTREAM}${m[1]}?offset=${offset}`, {
            headers: refresh ? { "X-RefreshTree": "true" } : {},
            cf: { cacheTtl: refresh ? 0 : 900, cacheEverything: !refresh },
        });
        const headers = new Headers(upstream.headers);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        headers.set("Cache-Control", refresh ? "no-store" : "public, max-age=900");
        return new Response(upstream.body, { status: upstream.status, headers });
    },
};
