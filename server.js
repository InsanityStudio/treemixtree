const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = "0.0.0.0";

const PROJECT_CACHE_TTL_MS = 15 * 60 * 1000;
const TREE_CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_DIR = "/tmp/treemixtree-cache";
const RUST_FETCHER_BIN = path.join(__dirname, "rust", "tree-fetcher", "target", "release", "tree-fetcher");
const HAS_RUST_FETCHER = fs.existsSync(RUST_FETCHER_BIN);

fs.mkdirSync(CACHE_DIR, { recursive: true });

const projectCache = new Map(); // id -> { data, expiresAt }
const responseCache = new Map(); // reqId -> { data, expiresAt }
const treeCache = new Map(); // rootId -> { data, expiresAt }
const inFlightStreams = new Map(); // key (id:refresh) -> { listeners: Set, lastPartial: object|null }

function getCached(map, key) {
    const entry = map.get(String(key));
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        map.delete(String(key));
        return null;
    }
    return entry.data;
}

function setCached(map, key, data, ttlMs) {
    if (map.size > 3000) {
        const firstKey = map.keys().next().value;
        map.delete(firstKey);
    }
    map.set(String(key), { data, expiresAt: Date.now() + ttlMs });
}

async function readDiskCache(key, ttlMs, allowStale = false) {
    const filePath = path.join(CACHE_DIR, `${key}.json`);
    try {
        const stat = await fsp.stat(filePath);
        const isStale = Date.now() - stat.mtimeMs > ttlMs;
        if (isStale && !allowStale) {
            return null;
        }
        const raw = await fsp.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        return allowStale ? { data: parsed, stale: isStale } : parsed;
    } catch {
        return null;
    }
}

async function writeDiskCache(key, payload) {
    const filePath = path.join(CACHE_DIR, `${key}.json`);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        await fsp.writeFile(tmpPath, JSON.stringify(payload));
        await fsp.rename(tmpPath, filePath);
    } catch {
        // Ignore non-fatal disk cache errors
    }
}

function parseShareTime(shared) {
    if (!shared) return Number.MAX_SAFE_INTEGER;
    const ms = Date.parse(shared);
    return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

function compactAndSortNode(node) {
    const rawChildren = Array.isArray(node.children) ? node.children : [];
    const children = rawChildren.map(compactAndSortNode);
    children.sort((a, b) => {
        const dt = parseShareTime(a.created || a.shared) - parseShareTime(b.created || b.shared);
        return dt !== 0 ? dt : Number(a.id) - Number(b.id);
    });

    return {
        id: node.id,
        title: node.title || "Untitled",
        author: typeof node.author === "string" ? node.author : node.author?.username || "Unknown",
        stats: {
            loves: node.stats?.loves ?? 0,
            favorites: node.stats?.favorites ?? 0,
            views: node.stats?.views ?? 0,
            remixes: node.stats?.remixes ?? 0,
        },
        visibility: node.visibility || "visible",
        is_published: node.is_published !== undefined ? Boolean(node.is_published) : true,
        created: node.history?.created || node.created || node.history?.shared || node.shared || null,
        shared: node.history?.shared || node.history?.created || node.shared || null,
        children,
    };
}

function containsNodeId(root, targetId) {
    const target = String(targetId);
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (String(node.id) === target) return true;
        if (Array.isArray(node.children)) {
            for (let i = 0; i < node.children.length; i++) {
                stack.push(node.children[i]);
            }
        }
    }
    return false;
}

function findNodeById(root, targetId) {
    const target = String(targetId);
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (String(node.id) === target) return node;
        if (Array.isArray(node.children)) {
            for (let i = 0; i < node.children.length; i++) {
                stack.push(node.children[i]);
            }
        }
    }
    return null;
}

function stripChildrenForMeta(node) {
    return {
        id: node.id,
        title: node.title,
        author: node.author,
        stats: node.stats,
        visibility: node.visibility,
        is_published: node.is_published,
        created: node.created,
        shared: node.shared,
        children: [],
    };
}

async function fetchProjectMetadata(id, bypassCache = false) {
    if (!bypassCache) {
        const cached = getCached(projectCache, id);
        if (cached) return cached;
    }
    const res = await fetch(`https://trampoline.turbowarp.org/api/projects/${id}`, {
        signal: AbortSignal.timeout(12000),
    });
    if (res.status === 404) {
        const err = new Error("Project not found");
        err.status = 404;
        throw err;
    }
    if (!res.ok) {
        const err = new Error(`TurboWarp API error: ${res.status}`);
        err.status = res.status;
        throw err;
    }
    const data = await res.json();
    setCached(projectCache, id, data, PROJECT_CACHE_TTL_MS);
    return data;
}

async function checkCachedTreeForRequest(id, refresh) {
    if (refresh) return null;

    const mem = getCached(responseCache, id);
    if (mem) return { payload: mem, stale: false };

    const diskReq = await readDiskCache(`req_${id}`, TREE_CACHE_TTL_MS, true);
    if (diskReq && diskReq.data?.tree) {
        if (!diskReq.stale) {
            setCached(responseCache, id, diskReq.data, TREE_CACHE_TTL_MS);
            setCached(treeCache, diskReq.data.rootProject.id, diskReq.data.tree, TREE_CACHE_TTL_MS);
        }
        return { payload: diskReq.data, stale: diskReq.stale };
    }

    // Fast path: check if we already know its root from TurboWarp and that root tree is cached!
    try {
        const meta = await fetchProjectMetadata(id, false);
        const rootId = meta.remix?.root ?? meta.id;
        let rootTree = getCached(treeCache, rootId);
        let rootStale = false;
        if (!rootTree) {
            const diskRoot = await readDiskCache(`root_${rootId}`, TREE_CACHE_TTL_MS, true);
            if (diskRoot?.data) {
                rootTree = diskRoot.data;
                rootStale = diskRoot.stale;
                if (!rootStale) setCached(treeCache, rootId, rootTree, TREE_CACHE_TTL_MS);
            }
        }
        if (rootTree && containsNodeId(rootTree, id)) {
            const payload = {
                enteredProject: compactAndSortNode({ ...meta, children: [] }),
                rootProject: stripChildrenForMeta(rootTree),
                tree: rootTree,
            };
            if (!rootStale) setCached(responseCache, id, payload, TREE_CACHE_TTL_MS);
            return { payload, stale: rootStale };
        }
    } catch {
        // Let full fetcher handle errors or missing projects
    }

    return null;
}

function persistTreeCaches(reqId, payload) {
    setCached(responseCache, reqId, payload, TREE_CACHE_TTL_MS);
    setCached(treeCache, payload.rootProject.id, payload.tree, TREE_CACHE_TTL_MS);
    writeDiskCache(`req_${reqId}`, payload);
    writeDiskCache(`root_${payload.rootProject.id}`, payload.tree);
}

// JS fallback tree fetcher if Rust binary is unavailable
async function fetchTreeWithJsFallback(id, refresh, onEvent) {
    onEvent({ type: "progress", stage: "parent", message: `Loading project ${id}...` });
    const enteredRaw = await fetchProjectMetadata(id, refresh);
    let rootRaw = enteredRaw;
    const fastRootId = enteredRaw.remix?.root;
    if (fastRootId != null && String(fastRootId) !== String(enteredRaw.id)) {
        try {
            rootRaw = await fetchProjectMetadata(fastRootId, refresh);
        } catch {
            // ignore
        }
    }
    const rootId = rootRaw.id;
    const estRemixes = rootRaw.stats?.remixes ?? 0;
    const PAGE_SIZE = 10;
    const CONCURRENCY = 8;

    const fetchPage = async (targetId, offset) => {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const r = await fetch(`https://renderapi.quuq.dev/remixtree/${targetId}?offset=${offset}`, {
                    headers: refresh ? { "X-RefreshTree": "true" } : undefined,
                    signal: AbortSignal.timeout(45000),
                });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return await r.json();
            } catch (err) {
                if (attempt === 2) throw err;
                await new Promise((res) => setTimeout(res, 350 * (attempt + 1)));
            }
        }
    };

    const enteredProject = compactAndSortNode({ ...enteredRaw, children: [] });
    const rootProject = compactAndSortNode({ ...rootRaw, children: [] });

    const seen = new Set();
    const directChildren = [];
    const totalOffsets = estRemixes > 0 ? Math.floor((estRemixes - 1) / PAGE_SIZE) * PAGE_SIZE : 0;
    let nextOffset = 0;
    let stopOffset = Infinity;

    const worker = async () => {
        while (true) {
            if (nextOffset > Math.max(totalOffsets, 0) && stopOffset === Infinity) {
                break;
            }
            const off = nextOffset;
            if (off >= stopOffset) break;
            nextOffset += PAGE_SIZE;

            try {
                const page = await fetchPage(rootId, off);
                const list = Array.isArray(page?.children) ? page.children : [];
                for (const c of list) {
                    if (!seen.has(c.id)) {
                        seen.add(c.id);
                        directChildren.push(compactAndSortNode(c));
                    }
                }
                if (list.length < PAGE_SIZE && off < stopOffset) {
                    stopOffset = off;
                } else if (off >= totalOffsets && list.length >= PAGE_SIZE && stopOffset === Infinity) {
                    // Keep probing
                }
            } catch {
                // ignore failed page
            }
        }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    directChildren.sort((a, b) => {
        const dt = parseShareTime(a.created || a.shared) - parseShareTime(b.created || b.shared);
        return dt !== 0 ? dt : Number(a.id) - Number(b.id);
    });

    const tree = { ...rootProject, children: directChildren };
    if (!containsNodeId(tree, enteredProject.id)) {
        tree.children = [...tree.children, enteredProject];
    }

    const donePayload = { enteredProject, rootProject, tree };
    onEvent({ type: "done", ...donePayload });
    return donePayload;
}

function runTreeFetchStream(id, refresh, onEvent) {
    const key = `${id}:${refresh ? "1" : "0"}`;
    let shared = inFlightStreams.get(key);
    if (shared) {
        const listener = (ev) => onEvent(ev);
        shared.listeners.add(listener);
        if (shared.lastPartial) {
            listener(shared.lastPartial);
        }
        return () => shared.listeners.delete(listener);
    }

    shared = {
        listeners: new Set([onEvent]),
        lastPartial: null,
    };
    inFlightStreams.set(key, shared);

    const broadcast = (ev) => {
        if (ev.type === "partial") {
            shared.lastPartial = ev;
        }
        for (const fn of shared.listeners) {
            try {
                fn(ev);
            } catch {
                // ignore closed stream listener
            }
        }
    };

    if (HAS_RUST_FETCHER) {
        const args = [String(id)];
        if (refresh) args.push("--refresh");
        const child = spawn(RUST_FETCHER_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
        let buf = "";
        let finished = false;

        child.stdout.on("data", (chunk) => {
            buf += chunk.toString();
            let nlIdx;
            while ((nlIdx = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, nlIdx).trim();
                buf = buf.slice(nlIdx + 1);
                if (!line) continue;
                try {
                    const ev = JSON.parse(line);
                    if (ev.type === "done") {
                        finished = true;
                        persistTreeCaches(id, {
                            enteredProject: ev.enteredProject,
                            rootProject: ev.rootProject,
                            tree: ev.tree,
                        });
                    }
                    broadcast(ev);
                } catch {
                    // ignore malformed line
                }
            }
        });

        child.on("error", async (err) => {
            inFlightStreams.delete(key);
            if (!finished) {
                try {
                    const done = await fetchTreeWithJsFallback(id, refresh, broadcast);
                    persistTreeCaches(id, done);
                } catch (e2) {
                    broadcast({ type: "error", status: e2.status || 500, message: err.message });
                }
            }
        });

        child.on("close", (code) => {
            if (buf.trim()) {
                try {
                    const ev = JSON.parse(buf.trim());
                    if (ev.type === "done") {
                        finished = true;
                        persistTreeCaches(id, {
                            enteredProject: ev.enteredProject,
                            rootProject: ev.rootProject,
                            tree: ev.tree,
                        });
                    }
                    broadcast(ev);
                } catch {
                    // ignore trailing partial
                }
            }
            inFlightStreams.delete(key);
            if (!finished && code !== 0) {
                broadcast({ type: "error", status: 500, message: "Tree fetcher exited unexpectedly" });
            }
        });
    } else {
        fetchTreeWithJsFallback(id, refresh, broadcast)
            .then((done) => {
                persistTreeCaches(id, done);
            })
            .catch((err) => {
                broadcast({ type: "error", status: err.status || 500, message: err.message || "Failed to load" });
            })
            .finally(() => {
                inFlightStreams.delete(key);
            });
    }

    return () => shared.listeners.delete(onEvent);
}

app.get("/api/project/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || id <= 0) {
        return res.status(400).json({ error: "Invalid project ID" });
    }
    // Check if cached inside any tree first
    const cachedResp = getCached(responseCache, id);
    if (cachedResp) {
        const node = findNodeById(cachedResp.tree, id);
        if (node) return res.json(node);
    }
    try {
        const data = await fetchProjectMetadata(id, false);
        res.json(data);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || "Failed to fetch project" });
    }
});

app.get("/api/tree/:id/stream", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || id <= 0) {
        return res.status(400).json({ error: "Invalid project ID" });
    }

    const refresh = req.query.refresh === "1" || req.query.refresh === "true";

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    let closed = false;
    let detach = null;
    req.on("close", () => {
        closed = true;
        if (detach) detach();
    });

    const sendEvent = (payload) => {
        if (!closed) {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
    };

    try {
        const cached = await checkCachedTreeForRequest(id, refresh);
        if (cached && !cached.stale) {
            sendEvent({ type: "done", ...cached.payload });
            if (!closed) res.end();
            return;
        }
        if (cached && cached.stale) {
            sendEvent({ type: "partial", ...cached.payload });
        }

        detach = runTreeFetchStream(id, refresh, (ev) => {
            sendEvent(ev);
            if (ev.type === "done" || ev.type === "error") {
                if (!closed) res.end();
                if (detach) detach();
            }
        });
    } catch (err) {
        sendEvent({
            type: "error",
            status: err.status || 500,
            message: err.message || "Failed to load remix tree",
        });
        if (!closed) res.end();
    }
});

app.get("/api/tree/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || id <= 0) {
        return res.status(400).json({ error: "Invalid project ID" });
    }
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";

    try {
        const cached = await checkCachedTreeForRequest(id, refresh);
        if (cached) {
            if (cached.stale) {
                const detachBg = runTreeFetchStream(id, false, (ev) => {
                    if (ev.type === "done" || ev.type === "error") detachBg();
                });
            }
            return res.json(cached.payload);
        }

        const result = await new Promise((resolve, reject) => {
            let settled = false;
            const detach = runTreeFetchStream(id, refresh, (ev) => {
                if (settled) return;
                if (ev.type === "done") {
                    settled = true;
                    detach();
                    resolve({
                        enteredProject: ev.enteredProject,
                        rootProject: ev.rootProject,
                        tree: ev.tree,
                    });
                } else if (ev.type === "error") {
                    settled = true;
                    detach();
                    const err = new Error(ev.message || "Failed to load remix tree");
                    err.status = ev.status || 500;
                    reject(err);
                }
            });
            req.on("close", () => {
                if (!settled) {
                    settled = true;
                    detach();
                }
            });
        });

        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || "Failed to load remix tree" });
    }
});

app.use(
    express.static(__dirname, {
        extensions: ["html"],
    })
);

app.get("/tree", (_req, res) => {
    res.sendFile(path.join(__dirname, "tree.html"));
});

app.listen(PORT, HOST, () => {
    console.log(
        `Server running at http://${HOST}:${PORT} (Rust fetcher: ${HAS_RUST_FETCHER ? "enabled" : "fallback"})`
    );
});
