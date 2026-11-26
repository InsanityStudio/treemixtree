(function (global) {
    const NODE_W = 72;
    const NODE_H = 54;
    const GAP_X = 18;
    const LAYER_H = 120;
    const MAX_CONCURRENT_IMAGES = 16;
    const MAX_SEARCH_RESULTS = 30;
    const MAX_QUERY_BYTES = 256;

    const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

    let wasmExports = null;
    const wasmReady = (async () => {
        try {
            if (typeof WebAssembly === "undefined") return null;
            const url = new URL("tree_layout.wasm", document.currentScript ? document.currentScript.src : new URL("assets/", location.href)).href;
            let instance;
            try {
                // Compiles while downloading (needs application/wasm, which GitHub Pages sends).
                ({ instance } = await WebAssembly.instantiateStreaming(fetch(url), {}));
            } catch (_) {
                const res = await fetch(url);
                if (!res.ok) return null;
                ({ instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {}));
            }
            wasmExports = instance.exports;
            return wasmExports;
        } catch (err) {
            console.warn("WASM layout unavailable, using JS fallback:", err);
            return null;
        }
    })();

    function parseShareTime(shared) {
        if (!shared) return Number.MAX_VALUE;
        const ms = Date.parse(shared);
        return Number.isFinite(ms) ? ms : Number.MAX_VALUE;
    }

    function lowerBoundX(layerNodes, minX) {
        let lo = 0;
        let hi = layerNodes.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (layerNodes[mid].x < minX) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    class CanvasRemixTree {
        constructor(container, data, options = {}) {
            this.container = container;
            this.data = data;
            this.focusId = options.focusId != null ? String(options.focusId) : String(data.id);
            this.selectedId = this.focusId;
            this.hoveredNode = null;
            this.onSelectNode = options.onSelectNode || null;
            this.onHoverNode = options.onHoverNode || null;

            this.canvas = document.createElement("canvas");
            this.canvas.style.width = "100%";
            this.canvas.style.height = "100%";
            this.canvas.style.display = "block";
            this.canvas.style.cursor = "grab";
            this.container.innerHTML = "";
            this.container.appendChild(this.canvas);
            this.ctx = this.canvas.getContext("2d");

            this.nodes = [];
            this.nodeById = new Map();
            this.layers = [];
            this.maxDepth = 0;
            this.ancestorIds = new Set();
            this.bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
            this._wasm = null;
            this._searchIndex = [];

            this.zoom = 1;
            this.panX = 0;
            this.panY = 0;
            this.userMovedCamera = false;
            this._hadFocusInitially = false;

            this.images = new Map();
            this.imageQueue = [];
            this.activeImageLoads = 0;

            this.rafPending = false;
            this.isDragging = false;
            this.dragMoved = false;
            this.dragStartX = 0;
            this.dragStartY = 0;
            this.panStartX = 0;
            this.panStartY = 0;

            this._rebuildTreeState();
            this._bindEvents();
            this._resizeCanvas();

            this._applyInitialCamera();
            this.requestRender();
        }

        _applyInitialCamera() {
            const focusNode = this.nodeById.get(this.focusId);
            this._hadFocusInitially = Boolean(focusNode);
            this.fitTree(false, true);
            if (this.zoom < 0.35) {
                if (focusNode && focusNode !== this.root) {
                    this.centerOnNode(focusNode, 0.75, false);
                } else {
                    this.zoom = 0.7;
                    this.panX = this.width / 2 - this.root.x * this.zoom;
                    this.panY = this.height - 90 - this.root.y * this.zoom;
                }
            }
        }

        updateData(newData) {
            this.data = newData;
            this._rebuildTreeState();
            const focusNode = this.nodeById.get(this.focusId);
            if (!this.userMovedCamera) {
                if (!this._hadFocusInitially && focusNode && focusNode !== this.root) {
                    this._hadFocusInitially = true;
                    this.centerOnNode(focusNode, 0.75, false);
                } else if (this.nodes.length <= 250) {
                    this.fitTree(false, true);
                }
            }
            this.requestRender();
        }

        _rebuildTreeState() {
            this._freeWasmState();
            this.nodes = [];
            this.nodeById = new Map();
            this.layers = [];
            this.ancestorIds = new Set();
            this._searchIndex = [];

            if (wasmExports && textEncoder) {
                try {
                    this._buildLayoutWasm(wasmExports);
                } catch (err) {
                    console.warn("WASM layout error, falling back to JS:", err);
                    this._freeWasmState();
                    this.nodes = [];
                    this.nodeById = new Map();
                    this._buildLayoutJS();
                }
            } else {
                this._buildLayoutJS();
            }

            let curr = this.nodeById.get(this.focusId);
            while (curr) {
                this.ancestorIds.add(curr.id);
                curr = curr.parent;
            }
            this.ancestorIds.add(String(this.data.id));
        }

        _freeWasmState() {
            const w = this._wasm;
            if (!w || !wasmExports) return;
            wasmExports.dealloc(w.depthPtr, w.i32Bytes);
            wasmExports.dealloc(w.parentPtr, w.i32Bytes);
            wasmExports.dealloc(w.xPtr, w.f64Bytes);
            wasmExports.dealloc(w.yPtr, w.f64Bytes);
            wasmExports.dealloc(w.layerOrderPtr, w.i32Bytes);
            wasmExports.dealloc(w.layerStartPtr, w.i32Bytes);
            wasmExports.dealloc(w.layerLenPtr, w.i32Bytes);
            wasmExports.dealloc(w.visNodesPtr, w.i32Bytes);
            wasmExports.dealloc(w.visEdgesPtr, w.i32Bytes);
            wasmExports.dealloc(w.countsPtr, 8);
            wasmExports.dealloc(w.arenaPtr, w.arenaLen);
            wasmExports.dealloc(w.idOffPtr, w.i32Bytes);
            wasmExports.dealloc(w.idLenPtr, w.i32Bytes);
            wasmExports.dealloc(w.titleOffPtr, w.i32Bytes);
            wasmExports.dealloc(w.titleLenPtr, w.i32Bytes);
            wasmExports.dealloc(w.authorOffPtr, w.i32Bytes);
            wasmExports.dealloc(w.authorLenPtr, w.i32Bytes);
            wasmExports.dealloc(w.queryPtr, MAX_QUERY_BYTES);
            wasmExports.dealloc(w.outIdxPtr, MAX_SEARCH_RESULTS * 4);
            wasmExports.dealloc(w.outScorePtr, MAX_SEARCH_RESULTS * 4);
            wasmExports.dealloc(w.outTotalPtr, 4);
            this._wasm = null;
        }

        _buildLayoutWasm(wasm) {
            const flat = [];
            const stack = [{ raw: this.data, depth: 0, parentIdx: -1 }];
            const childrenSlots = [];
            const rawMeta = [];

            while (stack.length > 0) {
                const item = stack.pop();
                const idx = flat.length;
                const raw = item.raw;
                const rawChildren = Array.isArray(raw.children) ? raw.children : [];
                const title = raw.title || "Untitled";
                const author =
                    typeof raw.author === "string" ? raw.author : raw.author?.username || "Unknown";

                const node = {
                    idx,
                    id: String(raw.id),
                    raw,
                    title,
                    author,
                    depth: item.depth,
                    parentIdx: item.parentIdx,
                    parent: item.parentIdx >= 0 ? flat[item.parentIdx] : null,
                    x: 0,
                    y: 0,
                    totalDescendants: 0,
                };
                flat.push(node);
                this.nodes.push(node);
                this.nodeById.set(node.id, node);
                rawMeta.push({
                    createdMs: parseShareTime(raw.created || raw.shared),
                    numId: Number(raw.id) || 0,
                });

                childrenSlots.push([]);
                if (item.parentIdx >= 0) {
                    childrenSlots[item.parentIdx].push(idx);
                }
                for (let i = rawChildren.length - 1; i >= 0; i--) {
                    stack.push({ raw: rawChildren[i], depth: item.depth + 1, parentIdx: idx });
                }
            }

            const n = flat.length;
            const depthArr = new Int32Array(n);
            const parentArr = new Int32Array(n);
            const createdArr = new Float64Array(n);
            const idArr = new Float64Array(n);
            const startArr = new Int32Array(n);
            const lenArr = new Int32Array(n);
            const rawChildrenList = [];

            // Also build UTF-8 byte arena for Rust search_nodes
            const idOffArr = new Int32Array(n);
            const idLenArr = new Int32Array(n);
            const titleOffArr = new Int32Array(n);
            const titleLenArr = new Int32Array(n);
            const authorOffArr = new Int32Array(n);
            const authorLenArr = new Int32Array(n);
            const chunks = [];
            let totalArenaBytes = 0;

            for (let i = 0; i < n; i++) {
                const nd = flat[i];
                depthArr[i] = nd.depth;
                parentArr[i] = nd.parentIdx;
                createdArr[i] = rawMeta[i].createdMs;
                idArr[i] = rawMeta[i].numId;

                const slots = childrenSlots[i];
                startArr[i] = rawChildrenList.length;
                lenArr[i] = slots.length;
                for (let j = 0; j < slots.length; j++) {
                    rawChildrenList.push(slots[j]);
                }

                const idB = textEncoder.encode(nd.id);
                const tB = textEncoder.encode(nd.title.toLowerCase());
                const aB = textEncoder.encode(nd.author.toLowerCase());

                idOffArr[i] = totalArenaBytes;
                idLenArr[i] = idB.length;
                totalArenaBytes += idB.length;

                titleOffArr[i] = totalArenaBytes;
                titleLenArr[i] = tB.length;
                totalArenaBytes += tB.length;

                authorOffArr[i] = totalArenaBytes;
                authorLenArr[i] = aB.length;
                totalArenaBytes += aB.length;

                chunks.push(idB, tB, aB);
            }

            const arenaBytes = new Uint8Array(Math.max(1, totalArenaBytes));
            let cursor = 0;
            for (let i = 0; i < chunks.length; i++) {
                arenaBytes.set(chunks[i], cursor);
                cursor += chunks[i].length;
            }

            const listArr = new Int32Array(rawChildrenList);
            const i32Bytes = n * 4;
            const f64Bytes = n * 8;
            const listBytes = Math.max(4, listArr.length * 4);
            const arenaAllocLen = Math.max(1, arenaBytes.length);

            // Temporary inputs
            const createdPtr = wasm.alloc(f64Bytes);
            const idPtr = wasm.alloc(f64Bytes);
            const startPtr = wasm.alloc(i32Bytes);
            const lenPtr = wasm.alloc(i32Bytes);
            const listPtr = wasm.alloc(listBytes);
            const outDescPtr = wasm.alloc(i32Bytes);
            const outBoundsPtr = wasm.alloc(32);
            const outMaxDepthPtr = wasm.alloc(4);

            // Persistent state kept in WASM linear memory for 60fps culling, hit-test & search
            const depthPtr = wasm.alloc(i32Bytes);
            const parentPtr = wasm.alloc(i32Bytes);
            const xPtr = wasm.alloc(f64Bytes);
            const yPtr = wasm.alloc(f64Bytes);
            const layerOrderPtr = wasm.alloc(i32Bytes);
            const layerStartPtr = wasm.alloc(i32Bytes);
            const layerLenPtr = wasm.alloc(i32Bytes);
            const visNodesPtr = wasm.alloc(i32Bytes);
            const visEdgesPtr = wasm.alloc(i32Bytes);
            const countsPtr = wasm.alloc(8);
            const arenaPtr = wasm.alloc(arenaAllocLen);
            const idOffPtr = wasm.alloc(i32Bytes);
            const idLenPtr = wasm.alloc(i32Bytes);
            const titleOffPtr = wasm.alloc(i32Bytes);
            const titleLenPtr = wasm.alloc(i32Bytes);
            const authorOffPtr = wasm.alloc(i32Bytes);
            const authorLenPtr = wasm.alloc(i32Bytes);
            const queryPtr = wasm.alloc(MAX_QUERY_BYTES);
            const outIdxPtr = wasm.alloc(MAX_SEARCH_RESULTS * 4);
            const outScorePtr = wasm.alloc(MAX_SEARCH_RESULTS * 4);
            const outTotalPtr = wasm.alloc(4);

            try {
                // Copy inputs AFTER all allocs so memory.buffer cannot detach mid-write
                new Int32Array(wasm.memory.buffer, depthPtr, n).set(depthArr);
                new Int32Array(wasm.memory.buffer, parentPtr, n).set(parentArr);
                new Float64Array(wasm.memory.buffer, createdPtr, n).set(createdArr);
                new Float64Array(wasm.memory.buffer, idPtr, n).set(idArr);
                new Int32Array(wasm.memory.buffer, startPtr, n).set(startArr);
                new Int32Array(wasm.memory.buffer, lenPtr, n).set(lenArr);
                if (listArr.length > 0) {
                    new Int32Array(wasm.memory.buffer, listPtr, listArr.length).set(listArr);
                }

                new Uint8Array(wasm.memory.buffer, arenaPtr, arenaBytes.length).set(arenaBytes);
                new Int32Array(wasm.memory.buffer, idOffPtr, n).set(idOffArr);
                new Int32Array(wasm.memory.buffer, idLenPtr, n).set(idLenArr);
                new Int32Array(wasm.memory.buffer, titleOffPtr, n).set(titleOffArr);
                new Int32Array(wasm.memory.buffer, titleLenPtr, n).set(titleLenArr);
                new Int32Array(wasm.memory.buffer, authorOffPtr, n).set(authorOffArr);
                new Int32Array(wasm.memory.buffer, authorLenPtr, n).set(authorLenArr);

                wasm.compute_layout(
                    n,
                    depthPtr,
                    createdPtr,
                    idPtr,
                    startPtr,
                    lenPtr,
                    listPtr,
                    listArr.length,
                    xPtr,
                    yPtr,
                    outDescPtr,
                    outBoundsPtr,
                    outMaxDepthPtr,
                    layerOrderPtr,
                    layerStartPtr,
                    layerLenPtr
                );

                const xs = new Float64Array(wasm.memory.buffer, xPtr, n);
                const ys = new Float64Array(wasm.memory.buffer, yPtr, n);
                const descs = new Int32Array(wasm.memory.buffer, outDescPtr, n);
                const bnds = new Float64Array(wasm.memory.buffer, outBoundsPtr, 4);
                this.maxDepth = new Int32Array(wasm.memory.buffer, outMaxDepthPtr, 1)[0];

                for (let i = 0; i < n; i++) {
                    flat[i].x = xs[i];
                    flat[i].y = ys[i];
                    flat[i].totalDescendants = descs[i];
                }
                this.bounds = {
                    minX: bnds[0],
                    maxX: bnds[1],
                    minY: bnds[2],
                    maxY: bnds[3],
                };
                this.root = flat[0];

                this._wasm = {
                    n,
                    maxDepth: this.maxDepth,
                    i32Bytes,
                    f64Bytes,
                    depthPtr,
                    parentPtr,
                    xPtr,
                    yPtr,
                    layerOrderPtr,
                    layerStartPtr,
                    layerLenPtr,
                    visNodesPtr,
                    visEdgesPtr,
                    countsPtr,
                    arenaPtr,
                    arenaLen: arenaBytes.length,
                    idOffPtr,
                    idLenPtr,
                    titleOffPtr,
                    titleLenPtr,
                    authorOffPtr,
                    authorLenPtr,
                    queryPtr,
                    outIdxPtr,
                    outScorePtr,
                    outTotalPtr,
                };
            } finally {
                wasm.dealloc(createdPtr, f64Bytes);
                wasm.dealloc(idPtr, f64Bytes);
                wasm.dealloc(startPtr, i32Bytes);
                wasm.dealloc(lenPtr, i32Bytes);
                wasm.dealloc(listPtr, listBytes);
                wasm.dealloc(outDescPtr, i32Bytes);
                wasm.dealloc(outBoundsPtr, 32);
                wasm.dealloc(outMaxDepthPtr, 4);
            }
        }

        _buildLayoutJS() {
            const stackSort = [this.data];
            while (stackSort.length > 0) {
                const curr = stackSort.pop();
                if (Array.isArray(curr.children) && curr.children.length > 1) {
                    curr.children.sort((a, b) => {
                        const dt = parseShareTime(a.created || a.shared) - parseShareTime(b.created || b.shared);
                        return dt !== 0 ? dt : Number(a.id) - Number(b.id);
                    });
                }
                if (Array.isArray(curr.children)) {
                    for (let i = 0; i < curr.children.length; i++) {
                        stackSort.push(curr.children[i]);
                    }
                }
            }

            const slotW = NODE_W + GAP_X;
            const flat = [];
            const childrenOf = [];
            const stack = [{ raw: this.data, depth: 0, parentIdx: -1 }];

            while (stack.length > 0) {
                const item = stack.pop();
                const idx = flat.length;
                const rawChildren = Array.isArray(item.raw.children) ? item.raw.children : [];
                const title = item.raw.title || "Untitled";
                const author =
                    typeof item.raw.author === "string" ? item.raw.author : item.raw.author?.username || "Unknown";

                const node = {
                    idx,
                    id: String(item.raw.id),
                    raw: item.raw,
                    title,
                    author,
                    depth: item.depth,
                    parentIdx: item.parentIdx,
                    parent: item.parentIdx >= 0 ? flat[item.parentIdx] : null,
                    x: 0,
                    y: -item.depth * LAYER_H,
                    totalDescendants: 0,
                };
                flat.push(node);
                this.nodes.push(node);
                this.nodeById.set(node.id, node);
                this._searchIndex.push({
                    node,
                    idStr: node.id,
                    title,
                    author,
                    titleLower: title.toLowerCase(),
                    authorLower: author.toLowerCase(),
                });
                childrenOf.push([]);
                if (item.parentIdx >= 0) {
                    childrenOf[item.parentIdx].push(idx);
                }
                for (let i = rawChildren.length - 1; i >= 0; i--) {
                    stack.push({ raw: rawChildren[i], depth: item.depth + 1, parentIdx: idx });
                }
            }

            const n = flat.length;
            const subtreeWidth = new Float64Array(n);
            for (let i = n - 1; i >= 0; i--) {
                const kids = childrenOf[i];
                if (kids.length === 0) {
                    subtreeWidth[i] = slotW;
                    continue;
                }
                let sumW = 0;
                let desc = 0;
                for (let j = 0; j < kids.length; j++) {
                    const c = kids[j];
                    sumW += subtreeWidth[c];
                    desc += 1 + flat[c].totalDescendants;
                }
                flat[i].totalDescendants = desc;
                subtreeWidth[i] = Math.max(slotW, sumW);
            }

            const posStack = [{ idx: 0, leftX: 0 }];
            while (posStack.length > 0) {
                const { idx, leftX } = posStack.pop();
                const kids = childrenOf[idx];
                if (kids.length === 0) {
                    flat[idx].x = leftX + subtreeWidth[idx] * 0.5;
                    continue;
                }
                let cursorX = leftX;
                const childPosts = [];
                for (let j = 0; j < kids.length; j++) {
                    const c = kids[j];
                    childPosts.push({ idx: c, leftX: cursorX });
                    cursorX += subtreeWidth[c];
                }
                for (let j = childPosts.length - 1; j >= 0; j--) {
                    posStack.push(childPosts[j]);
                }
            }

            for (let i = n - 1; i >= 0; i--) {
                const kids = childrenOf[i];
                if (kids.length > 0) {
                    flat[i].x = (flat[kids[0]].x + flat[kids[kids.length - 1]].x) * 0.5;
                }
            }

            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;
            let maxD = 0;
            const hw = NODE_W / 2;
            const hh = NODE_H / 2;
            for (let i = 0; i < n; i++) {
                const nd = flat[i];
                if (nd.depth > maxD) maxD = nd.depth;
                if (nd.x - hw < minX) minX = nd.x - hw;
                if (nd.x + hw > maxX) maxX = nd.x + hw;
                if (nd.y - hh < minY) minY = nd.y - hh;
                if (nd.y + hh + 26 > maxY) maxY = nd.y + hh + 26;
                if (!this.layers[nd.depth]) this.layers[nd.depth] = [];
                this.layers[nd.depth].push(nd);
            }
            this.maxDepth = maxD;
            for (let d = 0; d <= maxD; d++) {
                if (this.layers[d]) this.layers[d].sort((a, b) => a.x - b.x);
                else this.layers[d] = [];
            }

            this.bounds = {
                minX: minX - 100,
                maxX: maxX + 100,
                minY: minY - 80,
                maxY: maxY + 80,
            };
            this.root = flat[0];
        }

        _bindEvents() {
            this._onResize = () => {
                this._resizeCanvas();
                this.requestRender();
            };
            window.addEventListener("resize", this._onResize);

            this.canvas.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;
                this.isDragging = true;
                this.dragMoved = false;
                this.dragStartX = e.clientX;
                this.dragStartY = e.clientY;
                this.panStartX = this.panX;
                this.panStartY = this.panY;
                this.canvas.style.cursor = "grabbing";
            });

            window.addEventListener("mousemove", (e) => {
                if (this.isDragging) {
                    const dx = e.clientX - this.dragStartX;
                    const dy = e.clientY - this.dragStartY;
                    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
                        this.dragMoved = true;
                        this.userMovedCamera = true;
                    }
                    this.panX = this.panStartX + dx;
                    this.panY = this.panStartY + dy;
                    this.requestRender();
                }
            });

            this.canvas.addEventListener("mousemove", (e) => {
                if (this.isDragging) return;
                const hit = this._hitTest(e.clientX, e.clientY);
                if (hit !== this.hoveredNode) {
                    this.hoveredNode = hit;
                    this.canvas.style.cursor = hit ? "pointer" : "grab";
                    if (this.onHoverNode) this.onHoverNode(hit ? hit.raw : null, e);
                    this.requestRender();
                } else if (hit && this.onHoverNode) {
                    this.onHoverNode(hit.raw, e);
                }
            });

            this.canvas.addEventListener("mouseleave", () => {
                if (this.hoveredNode) {
                    this.hoveredNode = null;
                    if (this.onHoverNode) this.onHoverNode(null);
                    this.requestRender();
                }
            });

            window.addEventListener("mouseup", (e) => {
                if (!this.isDragging) return;
                const moved = this.dragMoved;
                this.isDragging = false;
                this.canvas.style.cursor = this.hoveredNode ? "pointer" : "grab";
                if (!moved && e.target === this.canvas) {
                    const hit = this._hitTest(e.clientX, e.clientY);
                    if (hit) {
                        this.selectedId = hit.id;
                        if (this.onSelectNode) this.onSelectNode(hit.raw, hit);
                        this.requestRender();
                    }
                }
            });

            this.canvas.addEventListener("dblclick", (e) => {
                const hit = this._hitTest(e.clientX, e.clientY);
                if (hit) {
                    this.centerOnNode(hit, Math.max(this.zoom, 1.0));
                }
            });

            this.canvas.addEventListener(
                "wheel",
                (e) => {
                    e.preventDefault();
                    this.userMovedCamera = true;
                    const rect = this.canvas.getBoundingClientRect();
                    const mx = e.clientX - rect.left;
                    const my = e.clientY - rect.top;
                    const factor = Math.exp(-e.deltaY * 0.0015);
                    this.zoomAt(mx, my, this.zoom * factor);
                },
                { passive: false }
            );

            let lastTouchDist = null;
            this.canvas.addEventListener(
                "touchstart",
                (e) => {
                    if (e.touches.length === 1) {
                        this.isDragging = true;
                        this.dragMoved = false;
                        this.dragStartX = e.touches[0].clientX;
                        this.dragStartY = e.touches[0].clientY;
                        this.panStartX = this.panX;
                        this.panStartY = this.panY;
                    } else if (e.touches.length === 2) {
                        this.isDragging = false;
                        lastTouchDist = Math.hypot(
                            e.touches[0].clientX - e.touches[1].clientX,
                            e.touches[0].clientY - e.touches[1].clientY
                        );
                    }
                },
                { passive: true }
            );

            this.canvas.addEventListener(
                "touchmove",
                (e) => {
                    e.preventDefault();
                    if (e.touches.length === 1 && this.isDragging) {
                        const dx = e.touches[0].clientX - this.dragStartX;
                        const dy = e.touches[0].clientY - this.dragStartY;
                        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
                            this.dragMoved = true;
                            this.userMovedCamera = true;
                        }
                        this.panX = this.panStartX + dx;
                        this.panY = this.panStartY + dy;
                        this.requestRender();
                    } else if (e.touches.length === 2 && lastTouchDist) {
                        this.userMovedCamera = true;
                        const dist = Math.hypot(
                            e.touches[0].clientX - e.touches[1].clientX,
                            e.touches[0].clientY - e.touches[1].clientY
                        );
                        const rect = this.canvas.getBoundingClientRect();
                        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
                        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
                        this.zoomAt(mx, my, this.zoom * (dist / lastTouchDist));
                        lastTouchDist = dist;
                    }
                },
                { passive: false }
            );

            this.canvas.addEventListener("touchend", () => {
                this.isDragging = false;
                lastTouchDist = null;
            });
        }

        _resizeCanvas() {
            const dpr = window.devicePixelRatio || 1;
            const rect = this.container.getBoundingClientRect();
            this.width = Math.max(1, rect.width);
            this.height = Math.max(1, rect.height);
            this.canvas.width = Math.floor(this.width * dpr);
            this.canvas.height = Math.floor(this.height * dpr);
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        _hitTest(clientX, clientY) {
            const rect = this.canvas.getBoundingClientRect();
            const sx = clientX - rect.left;
            const sy = clientY - rect.top;
            const wx = (sx - this.panX) / this.zoom;
            const wy = (sy - this.panY) / this.zoom;
            const hw = NODE_W / 2;
            const hh = NODE_H / 2;

            if (this._wasm && wasmExports) {
                const w = this._wasm;
                const idx = wasmExports.hit_test_layers(
                    w.n,
                    w.maxDepth,
                    w.layerStartPtr,
                    w.layerLenPtr,
                    w.layerOrderPtr,
                    w.xPtr,
                    wx,
                    wy,
                    hw,
                    hh
                );
                return idx >= 0 ? this.nodes[idx] : null;
            }

            const depth = Math.round(-wy / LAYER_H);
            if (depth >= 0 && depth < this.layers.length && Math.abs(wy + depth * LAYER_H) <= hh) {
                const layer = this.layers[depth];
                let idx = lowerBoundX(layer, wx - hw);
                if (idx < layer.length) {
                    const cand = layer[idx];
                    if (wx >= cand.x - hw && wx <= cand.x + hw) {
                        return cand;
                    }
                }
            }
            return null;
        }

        zoomAt(screenX, screenY, newZoom) {
            const clamped = Math.min(4.0, Math.max(0.01, newZoom));
            const wx = (screenX - this.panX) / this.zoom;
            const wy = (screenY - this.panY) / this.zoom;
            this.zoom = clamped;
            this.panX = screenX - wx * this.zoom;
            this.panY = screenY - wy * this.zoom;
            this.requestRender();
        }

        zoomIn() {
            this.userMovedCamera = true;
            this.zoomAt(this.width / 2, this.height / 2, this.zoom * 1.35);
        }

        zoomOut() {
            this.userMovedCamera = true;
            this.zoomAt(this.width / 2, this.height / 2, this.zoom / 1.35);
        }

        zoomReset() {
            this.userMovedCamera = true;
            const target = this.nodeById.get(this.selectedId) || this.nodeById.get(this.focusId) || this.root;
            this.centerOnNode(target, 1.0);
        }

        fitTree(render = true, keepAutoFlag = false) {
            if (!keepAutoFlag) this.userMovedCamera = true;
            const bw = Math.max(200, this.bounds.maxX - this.bounds.minX);
            const bh = Math.max(200, this.bounds.maxY - this.bounds.minY);
            const scale = Math.min(this.width / bw, this.height / bh) * 0.92;
            this.zoom = Math.min(1.4, Math.max(0.01, scale));
            const cx = (this.bounds.minX + this.bounds.maxX) / 2;
            const cy = (this.bounds.minY + this.bounds.maxY) / 2;
            this.panX = this.width / 2 - cx * this.zoom;
            this.panY = this.height / 2 - cy * this.zoom;
            if (render) this.requestRender();
        }

        centerOnNode(node, targetZoom = 1.0, markMoved = true) {
            if (!node) return;
            if (markMoved) this.userMovedCamera = true;
            this.zoom = Math.min(4.0, Math.max(0.01, targetZoom));
            this.panX = this.width / 2 - node.x * this.zoom;
            this.panY = this.height / 2 - node.y * this.zoom;
            this.selectedId = node.id;
            if (this.onSelectNode) this.onSelectNode(node.raw, node);
            this.requestRender();
        }

        focusProject() {
            const node = this.nodeById.get(this.focusId) || this.root;
            this.centerOnNode(node, Math.max(this.zoom, 0.85));
        }

        focusRoot() {
            this.centerOnNode(this.root, Math.max(this.zoom, 0.75));
        }

        search(query) {
            const raw = (query || "").trim().toLowerCase();
            if (!raw) return { total: 0, items: [] };

            if (this._wasm && wasmExports && textEncoder) {
                const w = this._wasm;
                const qBytes = textEncoder.encode(raw);
                const qLen = Math.min(MAX_QUERY_BYTES, qBytes.length);
                new Uint8Array(wasmExports.memory.buffer, w.queryPtr, qLen).set(qBytes.subarray(0, qLen));

                const count = wasmExports.search_nodes(
                    w.n,
                    w.depthPtr,
                    w.arenaPtr,
                    w.arenaLen,
                    w.idOffPtr,
                    w.idLenPtr,
                    w.titleOffPtr,
                    w.titleLenPtr,
                    w.authorOffPtr,
                    w.authorLenPtr,
                    w.queryPtr,
                    qLen,
                    MAX_SEARCH_RESULTS,
                    w.outIdxPtr,
                    w.outScorePtr,
                    w.outTotalPtr
                );

                const total = new Int32Array(wasmExports.memory.buffer, w.outTotalPtr, 1)[0];
                const idxs = new Int32Array(wasmExports.memory.buffer, w.outIdxPtr, count);
                const scores = new Int32Array(wasmExports.memory.buffer, w.outScorePtr, count);
                const items = new Array(count);
                for (let k = 0; k < count; k++) {
                    const nd = this.nodes[idxs[k]];
                    items[k] = {
                        node: nd,
                        id: nd.id,
                        title: nd.title,
                        author: nd.author,
                        depth: nd.depth,
                        score: scores[k],
                    };
                }
                return { total, items };
            }

            // JS fallback
            const terms = raw
                .split(/\s+/)
                .map((t) => {
                    const urlMatch = t.match(/projects\/(\d+)/);
                    if (urlMatch) return urlMatch[1];
                    return t.replace(/^[@#]+/, "");
                })
                .filter(Boolean);
            if (terms.length === 0) return { total: 0, items: [] };

            const scored = [];
            for (let i = 0; i < this._searchIndex.length; i++) {
                const entry = this._searchIndex[i];
                let allMatch = true;
                let score = 0;

                for (let j = 0; j < terms.length; j++) {
                    const term = terms[j];
                    const inTitle = entry.titleLower.indexOf(term);
                    const inAuthor = entry.authorLower.indexOf(term);
                    const inId = entry.idStr.indexOf(term);
                    if (inTitle === -1 && inAuthor === -1 && inId === -1) {
                        allMatch = false;
                        break;
                    }
                    if (entry.idStr === term) score += 200;
                    else if (entry.titleLower === term || entry.authorLower === term) score += 100;
                    else if (inId === 0) score += 60;
                    else if (inTitle === 0 || inAuthor === 0) score += 40;
                    else score += 10;
                }

                if (allMatch) {
                    scored.push({
                        node: entry.node,
                        id: entry.idStr,
                        title: entry.title,
                        author: entry.author,
                        depth: entry.node.depth,
                        score,
                    });
                }
            }

            scored.sort((a, b) => b.score - a.score || a.depth - b.depth);
            return {
                total: scored.length,
                items: scored.slice(0, MAX_SEARCH_RESULTS),
            };
        }

        _queueImage(id) {
            let entry = this.images.get(id);
            if (entry) return entry;
            entry = { img: null, status: "queued" };
            this.images.set(id, entry);
            this.imageQueue.push(id);
            this._pumpImages();
            return entry;
        }

        _pumpImages() {
            while (this.activeImageLoads < MAX_CONCURRENT_IMAGES && this.imageQueue.length > 0) {
                const id = this.imageQueue.pop();
                const entry = this.images.get(id);
                if (!entry || entry.status !== "queued") continue;

                entry.status = "loading";
                this.activeImageLoads++;
                const img = new Image();
                img.decoding = "async";
                img.onload = () => {
                    entry.img = img;
                    entry.status = "loaded";
                    this.activeImageLoads--;
                    this._pumpImages();
                    this.requestRender();
                };
                img.onerror = () => {
                    entry.status = "error";
                    this.activeImageLoads--;
                    this._pumpImages();
                };
                img.src = `https://cdn2.scratch.mit.edu/get_image/project/${id}_100x80.png`;
            }
        }

        requestRender() {
            if (this.rafPending) return;
            this.rafPending = true;
            requestAnimationFrame(() => {
                this.rafPending = false;
                this._render();
            });
        }

        _renderNode(ctx, n, hw, hh, fastMode, showImages, showLabels) {
            const isFocus = n.id === this.focusId;
            const isSelected = n.id === this.selectedId;
            const isHovered = n === this.hoveredNode;
            const isUnshared = n.raw.is_published === false || n.raw.visibility !== "visible";

            const nx = n.x - hw;
            const ny = n.y - hh;

            if (fastMode) {
                ctx.fillStyle = isFocus
                    ? "#f59e0b"
                    : isSelected
                      ? "#2563eb"
                      : isUnshared
                        ? "#94a3b8"
                        : n.depth === 0
                          ? "#1d4ed8"
                          : "#64748b";
                ctx.fillRect(nx, ny, NODE_W, NODE_H);
                return;
            }

            if (isFocus || isSelected) {
                ctx.strokeStyle = isFocus ? "#f59e0b" : "#2563eb";
                ctx.lineWidth = Math.max(3, 4 / this.zoom);
                ctx.beginPath();
                ctx.roundRect(nx - 3, ny - 3, NODE_W + 6, NODE_H + 6, 6);
                ctx.stroke();
            }

            ctx.save();
            ctx.fillStyle = isUnshared ? "#f8fafc" : "#ffffff";
            ctx.strokeStyle = isHovered ? "#2563eb" : "#94a3b8";
            ctx.lineWidth = isHovered ? 2 : 1;
            if (isUnshared) {
                ctx.setLineDash([4, 3]);
            }
            ctx.beginPath();
            ctx.roundRect(nx, ny, NODE_W, NODE_H, 4);
            ctx.fill();
            ctx.stroke();
            ctx.restore();

            if (isUnshared) {
                ctx.fillStyle = "#e2e8f0";
                ctx.fillRect(nx + 2, ny + 2, NODE_W - 4, NODE_H - 4);
                if (this.zoom >= 0.35) {
                    ctx.font = "600 9px sans-serif";
                    ctx.fillStyle = "#475569";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText("Unshared", n.x, n.y);
                }
            } else if (showImages) {
                const entry = this._queueImage(n.id);
                if (entry.status === "loaded" && entry.img) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.roundRect(nx + 1, ny + 1, NODE_W - 2, NODE_H - 2, 3);
                    ctx.clip();
                    ctx.drawImage(entry.img, nx + 1, ny + 1, NODE_W - 2, NODE_H - 2);
                    ctx.restore();
                } else {
                    ctx.fillStyle = n.depth === 0 ? "#dbeafe" : "#e2e8f0";
                    ctx.fillRect(nx + 2, ny + 2, NODE_W - 4, NODE_H - 4);
                }
            }

            if (n.totalDescendants > 0 && this.zoom >= 0.25) {
                const badge = String(n.totalDescendants);
                ctx.font = "bold 10px sans-serif";
                const bw = Math.max(16, ctx.measureText(badge).width + 8);
                ctx.fillStyle = "#0f172a";
                ctx.beginPath();
                ctx.roundRect(nx + NODE_W - bw + 4, ny - 7, bw, 14, 7);
                ctx.fill();
                ctx.fillStyle = "#ffffff";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(badge, nx + NODE_W - bw / 2 + 4, ny);
            }

            if (showLabels) {
                ctx.font = "600 10px sans-serif";
                ctx.fillStyle = "#0f172a";
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                const shortTitle = n.title.length > 14 ? n.title.slice(0, 13) + "…" : n.title;
                ctx.fillText(shortTitle, n.x, ny + NODE_H + 4);
            }
        }

        _render() {
            const ctx = this.ctx;
            const w = this.width;
            const h = this.height;

            ctx.fillStyle = "#f1f5f9";
            ctx.fillRect(0, 0, w, h);

            const hw = NODE_W / 2;
            const hh = NODE_H / 2;

            const pad = 120 / this.zoom;
            const viewMinX = -this.panX / this.zoom - pad;
            const viewMaxX = (w - this.panX) / this.zoom + pad;
            const viewMinY = -this.panY / this.zoom - pad;
            const viewMaxY = (h - this.panY) / this.zoom + pad;

            const minLayer = Math.max(0, Math.floor(-viewMaxY / LAYER_H));
            const maxLayer = Math.min(this.maxDepth, Math.ceil(-viewMinY / LAYER_H));

            ctx.save();
            ctx.translate(this.panX, this.panY);
            ctx.scale(this.zoom, this.zoom);

            for (let d = minLayer; d <= maxLayer; d++) {
                const ly = -d * LAYER_H;
                ctx.fillStyle = d % 2 === 0 ? "rgba(255, 255, 255, 0.55)" : "rgba(226, 232, 240, 0.35)";
                ctx.fillRect(viewMinX, ly - LAYER_H * 0.5, viewMaxX - viewMinX, LAYER_H);
            }

            const edgeStrokeW = Math.max(0.8, Math.min(2.6, 1.5 / Math.sqrt(this.zoom)));
            ctx.lineCap = "round";

            const fastMode = NODE_W * this.zoom < 12;
            const showImages = !fastMode;
            const showLabels = this.zoom >= 0.42;

            if (this._wasm && wasmExports) {
                const wm = this._wasm;
                wasmExports.cull_visible_layers(
                    wm.n,
                    wm.maxDepth,
                    wm.layerStartPtr,
                    wm.layerLenPtr,
                    wm.layerOrderPtr,
                    wm.parentPtr,
                    wm.xPtr,
                    viewMinX,
                    viewMaxX,
                    minLayer,
                    maxLayer,
                    hw,
                    wm.visNodesPtr,
                    wm.visEdgesPtr,
                    wm.countsPtr
                );

                const counts = new Int32Array(wasmExports.memory.buffer, wm.countsPtr, 2);
                const visNodeCount = counts[0];
                const visEdgeCount = counts[1];
                const visNodes = new Int32Array(wasmExports.memory.buffer, wm.visNodesPtr, visNodeCount);
                const visEdges = new Int32Array(wasmExports.memory.buffer, wm.visEdgesPtr, visEdgeCount);

                // Batch normal edges in one stroke, then highlighted ancestor edges
                const highlightedEdges = [];
                ctx.strokeStyle = "rgba(100, 116, 139, 0.45)";
                ctx.lineWidth = edgeStrokeW;
                ctx.beginPath();
                for (let i = 0; i < visEdgeCount; i++) {
                    const child = this.nodes[visEdges[i]];
                    const parent = child.parent;
                    if (!parent) continue;
                    if (this.ancestorIds.has(parent.id) && this.ancestorIds.has(child.id)) {
                        highlightedEdges.push(child);
                        continue;
                    }
                    ctx.moveTo(parent.x, parent.y - hh);
                    ctx.lineTo(child.x, child.y + hh);
                }
                ctx.stroke();

                if (highlightedEdges.length > 0) {
                    ctx.strokeStyle = "#f59e0b";
                    ctx.lineWidth = edgeStrokeW * 2.0;
                    ctx.beginPath();
                    for (let i = 0; i < highlightedEdges.length; i++) {
                        const child = highlightedEdges[i];
                        const parent = child.parent;
                        ctx.moveTo(parent.x, parent.y - hh);
                        ctx.lineTo(child.x, child.y + hh);
                    }
                    ctx.stroke();
                }

                for (let i = 0; i < visNodeCount; i++) {
                    this._renderNode(ctx, this.nodes[visNodes[i]], hw, hh, fastMode, showImages, showLabels);
                }
            } else {
                for (let d = minLayer; d <= maxLayer; d++) {
                    const layer = this.layers[d];
                    if (!layer || layer.length === 0) continue;

                    for (let i = 0; i < layer.length; i++) {
                        const child = layer[i];
                        const parent = child.parent;
                        if (!parent) continue;
                        const minEX = Math.min(parent.x, child.x);
                        const maxEX = Math.max(parent.x, child.x);
                        if (maxEX < viewMinX || minEX > viewMaxX) continue;

                        const isHighlighted = this.ancestorIds.has(parent.id) && this.ancestorIds.has(child.id);
                        ctx.strokeStyle = isHighlighted ? "#f59e0b" : "rgba(100, 116, 139, 0.45)";
                        ctx.lineWidth = isHighlighted ? edgeStrokeW * 2.0 : edgeStrokeW;

                        ctx.beginPath();
                        ctx.moveTo(parent.x, parent.y - hh);
                        ctx.lineTo(child.x, child.y + hh);
                        ctx.stroke();
                    }
                }

                for (let d = minLayer; d <= maxLayer; d++) {
                    const layer = this.layers[d];
                    if (!layer || layer.length === 0) continue;

                    const startIdx = lowerBoundX(layer, viewMinX - hw);
                    for (let i = startIdx; i < layer.length; i++) {
                        const n = layer[i];
                        if (n.x - hw > viewMaxX) break;
                        this._renderNode(ctx, n, hw, hh, fastMode, showImages, showLabels);
                    }
                }
            }

            ctx.restore();
        }

        destroy() {
            window.removeEventListener("resize", this._onResize);
            this._freeWasmState();
        }
    }

    CanvasRemixTree.ready = wasmReady;
    global.CanvasRemixTree = CanvasRemixTree;
})(window);
