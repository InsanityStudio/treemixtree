// Browser port of server.js + rust/tree-fetcher: fetches, compacts, sorts and
// streams a remix tree straight from the public APIs. No backend needed.
(function (global) {
    const CFG = global.TMT_CONFIG;

    /* ---------- tiny IndexedDB cache (stale-while-revalidate) ---------- */
    let dbPromise = null;
    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve) => {
            try {
                const req = indexedDB.open("treemixtree", 1);
                req.onupgradeneeded = () => req.result.createObjectStore("trees");
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
        return dbPromise;
    }
    async function cacheGet(key) {
        const db = await openDb();
        if (!db) return null;
        return new Promise((resolve) => {
            try {
                const r = db.transaction("trees").objectStore("trees").get(key);
                r.onsuccess = () => resolve(r.result || null);
                r.onerror = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }
    async function cachePut(key, payload) {
        const db = await openDb();
        if (!db) return;
        try {
            db.transaction("trees", "readwrite").objectStore("trees").put({ at: Date.now(), payload }, key);
        } catch {
            /* ignore quota errors */
        }
    }

    /* ---------- helpers ported from server.js / main.rs ---------- */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const timeOf = (s) => {
        if (!s) return Infinity;
        const ms = Date.parse(s);
        return Number.isFinite(ms) ? ms : Infinity;
    };
    const cmpNodes = (a, b) => {
        const ta = timeOf(a.created || a.shared);
        const tb = timeOf(b.created || b.shared);
        if (ta !== tb) return ta < tb ? -1 : 1;
        return Number(a.id) - Number(b.id);
    };

    function compact(node) {
        const raw = Array.isArray(node.children) ? node.children : [];
        const children = new Array(raw.length);
        for (let i = 0; i < raw.length; i++) children[i] = compact(raw[i]);
        if (children.length > 1) children.sort(cmpNodes);
        const h = node.history || {};
        const created = h.created || node.created || h.shared || node.shared || null;
        return {
            id: node.id,
            title: node.title || "Untitled",
            author: typeof node.author === "string" ? node.author : (node.author && node.author.username) || "Unknown",
            stats: {
                loves: (node.stats && node.stats.loves) || 0,
                favorites: (node.stats && node.stats.favorites) || 0,
                views: (node.stats && node.stats.views) || 0,
                remixes: (node.stats && node.stats.remixes) || 0,
            },
            visibility: node.visibility || "visible",
            is_published: node.is_published !== undefined ? Boolean(node.is_published) : true,
            created,
            shared: h.shared || h.created || node.shared || null,
            children,
        };
    }

    function findNode(root, id) {
        const target = String(id);
        const stack = [root];
        while (stack.length) {
            const n = stack.pop();
            if (String(n.id) === target) return n;
            for (let i = 0; i < n.children.length; i++) stack.push(n.children[i]);
        }
        return null;
    }

    function attachChild(root, parentId, child) {
        const parent = findNode(root, parentId);
        if (!parent) return false;
        if (!parent.children.some((c) => c.id === child.id)) {
            parent.children.push(child);
            parent.children.sort(cmpNodes);
        }
        return true;
    }

    function shallow(node) {
        return Object.assign({}, node, { children: [] });
    }

    /* ---------- network ---------- */
    const projectMemo = new Map();
    async function fetchProject(id) {
        if (projectMemo.has(id)) return projectMemo.get(id);
        const p = (async () => {
            let lastErr;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const res = await fetch(CFG.PROJECT_API + id, { signal: AbortSignal.timeout(12000) });
                    if (res.status === 404) {
                        const e = new Error("Project not found");
                        e.status = 404;
                        throw e;
                    }
                    if (!res.ok) {
                        const e = new Error("TurboWarp API error: " + res.status);
                        e.status = res.status;
                        throw e;
                    }
                    return await res.json();
                } catch (err) {
                    lastErr = err;
                    if (err.status === 404) break;
                    await sleep(250 * (attempt + 1));
                }
            }
            throw lastErr;
        })();
        projectMemo.set(id, p);
        p.catch(() => projectMemo.delete(id));
        return p;
    }

    async function fetchPage(rootId, offset, refresh) {
        const timeouts = [15000, 22000, 30000];
        const base = CFG.TREE_API_PROXY || CFG.TREE_API;
        const url = base + rootId + "?offset=" + offset + (refresh && CFG.TREE_API_PROXY ? "&refresh=1" : "");
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                // Only add the custom header when refreshing: it forces a CORS preflight.
                const opts = { signal: AbortSignal.timeout(timeouts[attempt]) };
                if (refresh && !CFG.TREE_API_PROXY) opts.headers = { "X-RefreshTree": "true" };
                const res = await fetch(url, opts);
                if (res.ok) return await res.json();
            } catch {
                /* retry */
            }
            await sleep(350 * (attempt + 1));
        }
        return null;
    }

    // Walks up from an entered project that is not reachable from the root's pages.
    async function resolveBranch(enteredRaw, rootId, refresh) {
        const chain = [enteredRaw];
        const seen = new Set([enteredRaw.id]);
        let cur = enteredRaw.remix && enteredRaw.remix.parent;
        let broken = null;
        while (cur && cur !== rootId && !seen.has(cur)) {
            seen.add(cur);
            try {
                const m = await fetchProject(cur);
                chain.push(m);
                cur = m.remix && m.remix.parent;
            } catch {
                broken = cur;
                break;
            }
        }
        const top = chain[chain.length - 1];
        let branch = null;
        if (broken != null) {
            const page = await fetchPage(top.id, 0, refresh);
            if (page) branch = compact(page);
        }
        if (!branch) {
            let acc = null;
            for (const raw of chain) {
                const c = compact(Object.assign({}, raw, { children: [] }));
                if (acc) c.children = [acc];
                acc = c;
            }
            branch = acc;
        }
        let attachTo = rootId;
        let node = branch;
        if (broken != null) {
            if (broken !== top.id) {
                node = {
                    id: broken,
                    title: "Unshared Project #" + broken,
                    author: "Unknown",
                    stats: { loves: 0, favorites: 0, views: 0, remixes: 1 },
                    visibility: "notvisible",
                    is_published: false,
                    created: branch.created || branch.shared,
                    shared: branch.shared || branch.created,
                    children: [branch],
                };
            }
        } else {
            attachTo = (top.remix && top.remix.parent) || rootId;
        }
        return { attachTo, node };
    }

    /* ---------- main entry: streams partial/progress/done events ---------- */
    async function loadTree(id, opts) {
        opts = opts || {};
        const refresh = Boolean(opts.refresh);
        const onEvent = opts.onEvent || function () {};
        const key = "req_" + id;

        // 1) Instant paint from cache (stale-while-revalidate).
        if (!refresh) {
            const hit = await cacheGet(key);
            if (hit && hit.payload && hit.payload.tree) {
                const fresh = Date.now() - hit.at < CFG.CACHE_TTL_MS;
                if (fresh) {
                    onEvent({ type: "done", ...hit.payload });
                    return hit.payload;
                }
                onEvent({ type: "partial", ...hit.payload });
            }
        }

        onEvent({ type: "progress", message: "Resolving project " + id + "..." });
        const enteredRaw = await fetchProject(id);

        // 2) Resolve root. The first tree page is requested in parallel with
        //    the root metadata whenever remix.root is already known.
        let rootId = enteredRaw.id;
        const fastRoot = enteredRaw.remix && enteredRaw.remix.root;
        if (fastRoot != null && fastRoot !== enteredRaw.id) rootId = fastRoot;
        const firstRoot = rootId;
        let firstPage = fetchPage(rootId, 0, refresh);
        let rootRaw = enteredRaw;
        if (rootId !== enteredRaw.id) {
            try {
                rootRaw = await fetchProject(rootId);
            } catch {
                /* fall through, keep entered as root */
            }
        }
        // Fallback climb if the "root" still has a parent.
        const visited = new Set([enteredRaw.id, rootRaw.id]);
        let parent = rootRaw.remix && rootRaw.remix.parent;
        while (parent && !visited.has(parent)) {
            visited.add(parent);
            try {
                const p = await fetchProject(parent);
                rootRaw = p;
                parent = p.remix && p.remix.parent;
            } catch {
                break;
            }
        }
        rootId = rootRaw.id;
        if (rootId !== firstRoot) firstPage = fetchPage(rootId, 0, refresh);

        const enteredProject = compact(Object.assign({}, enteredRaw, { children: [] }));
        const rootProject = compact(Object.assign({}, rootRaw, { children: [] }));
        const est = rootProject.stats.remixes;
        const PAGE = CFG.PAGE_SIZE;
        const lastOffset = est > 0 ? Math.floor((est - 1) / PAGE) * PAGE : 0;

        onEvent({
            type: "progress",
            message: "Streaming remix tree for #" + rootId + " (~" + est + " direct remixes)...",
        });

        const branchPromise =
            enteredRaw.id !== rootId ? resolveBranch(enteredRaw, rootId, refresh).catch(() => null) : Promise.resolve(null);

        // 3) Sliding-window page fetching.
        const pages = new Map();
        let branch = null;
        let nextOffset = 0;
        let stopAt = Infinity; // first short page offset
        let rootFromPage = null;
        let lastEmit = 0;

        const assemble = () => {
            const base = rootFromPage || rootProject;
            const seen = new Set();
            const direct = [];
            const offs = Array.from(pages.keys()).sort((a, b) => a - b);
            for (const o of offs) {
                for (const c of pages.get(o)) {
                    if (!seen.has(c.id)) {
                        seen.add(c.id);
                        direct.push(c);
                    }
                }
            }
            direct.sort(cmpNodes);
            const tree = Object.assign({}, base, { children: direct });
            if (!findNode(tree, enteredProject.id) && branch) {
                const copy = JSON.parse(JSON.stringify(branch.node));
                if (!attachChild(tree, branch.attachTo, copy)) attachChild(tree, tree.id, copy);
            }
            return { enteredProject, rootProject: base, tree };
        };

        const emitPartial = (force) => {
            const now = performance.now();
            if (!force && now - lastEmit < 750) return;
            if (!pages.size) return;
            lastEmit = now;
            const snap = assemble();
            onEvent({ type: "partial", ...snap });
            onEvent({
                type: "progress",
                message:
                    "Streaming remixes: " + snap.tree.children.length + " / ~" + Math.max(est, snap.tree.children.length) + " direct...",
            });
        };

        branchPromise.then((b) => {
            branch = b;
            if (b) emitPartial(true);
        });

        const ingest = (off, page) => {
            if (!page) return;
            const list = Array.isArray(page.children) ? page.children : [];
            if (off === 0 && !rootFromPage) {
                rootFromPage = compact(Object.assign({}, page, { children: [] }));
            }
            pages.set(off, list.map(compact));
            if (list.length < PAGE && off < stopAt) stopAt = off;
        };

        const pageJobs = new Map(); // offset -> promise (so probing can wait on the estimate boundary)
        const run = (off) => {
            const job = (off === 0 ? firstPage : fetchPage(rootId, off, refresh)).then((page) => {
                ingest(off, page);
                emitPartial(false);
            });
            pageJobs.set(off, job);
            return job;
        };

        const worker = async () => {
            for (;;) {
                const off = nextOffset;
                if (off >= stopAt) break;
                nextOffset += PAGE;
                // Beyond the estimate, only continue if the last expected page was full.
                if (off > lastOffset) {
                    await pageJobs.get(lastOffset);
                    if (off >= stopAt) break;
                }
                await run(off);
            }
        };

        const workers = [];
        for (let i = 0; i < CFG.CONCURRENCY; i++) workers.push(worker());
        await Promise.all(workers);
        if (pages.size === 0 && est > 0) {
            const e = new Error(
                "Could not reach the remix tree API. If you see a CORS error in the console, set TREE_API_PROXY in assets/config.js."
            );
            e.status = 502;
            throw e;
        }
        const b = await branchPromise;
        if (b) branch = b;

        const done = assemble();
        cachePut(key, done);
        onEvent({ type: "done", ...done });
        return done;
    }

    global.TreeLoader = { loadTree, fetchProject, compact };
})(window);
