window.onhashchange = () => location.reload();
window.onerror = function (msg) {
    if (!String(msg).includes("projectbox") && !String(msg).includes("App")) {
        console.error("Error: " + msg);
    }
};

window.onresize = () => handleResize();

document.querySelector("#prev").addEventListener("click", () => move(-10));
document.querySelector("#next").addEventListener("click", () => move(10));

function move(amount) {
    const params = new URLSearchParams(location.search);
    params.set("offset", parseInt(window.offset || 0, 10) + amount);
    location.search = "?" + params.toString();
}

function switchViewer(target) {
    const params = new URLSearchParams(location.search);
    params.set("viewer", target);
    location.search = "?" + params.toString();
}

function refresh() {
    const params = new URLSearchParams(location.search);
    params.set("new", true);
    location.search = "?" + params.toString();
}

function handleResize() {
    if (window.viewer == "scratch") {
        let { width, height } = getComputedStyle(document.querySelector("#container"));
        width = parseFloat(width.replace("px", ""));
        height = parseFloat(height.replace("px", ""));
        const treeEl = document.querySelector("#tree-container");
        const scaleWidth = width / 940;
        const scaleHeight = height / 500;
        const scale = Math.min(scaleWidth, scaleHeight);
        treeEl.style.scale = scale;

        const zoomEl = document.querySelector("#zoomContainer");
        zoomEl.style.scale = 1 / scale;
    }
}

function handleSubmit(evt) {
    evt.preventDefault();
    if (!document.querySelector("#idPicker").value) return;
    const params = new URLSearchParams(location.search);
    const paramsString = `?viewer=${params.get("viewer") || "canvas"}`;
    window.history.replaceState({}, "", `${location.origin}${location.pathname}${paramsString}${location.hash}`);
    location.hash = `#${document.querySelector("#idPicker").value}`;
}

function validate(evt) {
    const theEvent = evt || window.event;
    if (evt.key == "Enter") return;

    let key;
    if (theEvent.type === "paste") {
        key = evt.clipboardData.getData("text/plain");
    } else {
        const charCode = theEvent.keyCode || theEvent.which;
        key = String.fromCharCode(charCode);
    }
    const regex = /[0-9]|\./;
    if (!regex.test(key)) {
        theEvent.returnValue = false;
        if (theEvent.preventDefault) theEvent.preventDefault();
    }
}

function countTreeStats(node, depth = 0) {
    if (!node) return { count: 0, maxDepth: depth };
    let count = 1;
    let maxDepth = depth;
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
        const sub = countTreeStats(child, depth + 1);
        count += sub.count;
        if (sub.maxDepth > maxDepth) maxDepth = sub.maxDepth;
    }
    return { count, maxDepth };
}

function updateHeaderInfo(enteredProject, rootProject, tree, isStreaming = false, progressMsg = "") {
    const info = document.querySelector("#info");
    window.rootId = rootProject.id;

    const titleLink = info.querySelector("#title-link");
    titleLink.innerText = enteredProject.title;
    titleLink.href = `https://scratch.mit.edu/projects/${enteredProject.id}`;

    const rootInfo = info.querySelector("#root-info");
    if (rootInfo) {
        if (rootProject.id !== enteredProject.id) {
            rootInfo.innerHTML = "";
            rootInfo.append(" (root: ");
            const rootLink = document.createElement("a");
            rootLink.target = "_blank";
            rootLink.href = `https://scratch.mit.edu/projects/${rootProject.id}`;
            rootLink.innerText = rootProject.title;
            rootInfo.append(rootLink, ")");
        } else {
            rootInfo.innerHTML = "";
        }
    }

    const statsEl = document.querySelector("#tree-stats");
    if (statsEl && tree) {
        const { count, maxDepth } = countTreeStats(tree);
        const suffix = isStreaming ? ` • ${progressMsg || "streaming..."}` : "";
        statsEl.textContent = `${count} projects • ${maxDepth + 1} layers${suffix}`;
    }

    document.querySelector("#buttons").hidden = true;
}

function showPreviewFromNode(nodeData) {
    const preview = document.querySelector("#project-preview");
    if (!nodeData) {
        preview.hidden = true;
        return;
    }

    preview.hidden = false;
    const isUnshared = nodeData.is_published === false || nodeData.visibility !== "visible";
    const previewImg = document.querySelector("#preview-img");
    if (isUnshared) {
        previewImg.src =
            "data:image/svg+xml;utf8," +
            encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150"><rect width="200" height="150" fill="#e2e8f0"/><text x="100" y="75" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="14" font-weight="600" fill="#475569">Unshared / Unavailable</text></svg>'
            );
    } else {
        previewImg.src = `https://cdn2.scratch.mit.edu/get_image/project/${nodeData.id}_200x150.png`;
    }
    const titleEl = document.querySelector("#preview-title");
    titleEl.innerText = nodeData.title || "Untitled";
    titleEl.href = `https://scratch.mit.edu/projects/${nodeData.id}`;

    const authorName = typeof nodeData.author === "string" ? nodeData.author : nodeData.author?.username || "Unknown";
    document.querySelector("#preview-author").innerText = "by " + authorName;

    const dateStr = nodeData.created || nodeData.history?.created || nodeData.shared || nodeData.history?.shared;
    document.querySelector("#preview-created").innerText = dateStr
        ? "Created " + new Date(dateStr).toLocaleDateString()
        : "";

    const stats = nodeData.stats || {};
    document.querySelector("#preview-loves").innerText = `${stats.loves ?? 0} ❤️`;
    document.querySelector("#preview-faves").innerText = `${stats.favorites ?? 0} ⭐`;
    document.querySelector("#preview-views").innerText = `${stats.views ?? 0} 👁️`;
    const childCount = Array.isArray(nodeData.children) ? nodeData.children.length : stats.remixes ?? 0;
    document.querySelector("#preview-remixes").innerText = `${childCount}`;
}

function consolidateData(scratchTree, level = 0) {
    let size;
    if (level < 2) {
        size = 50;
    } else {
        size = Math.max(10, 30 - level * 2);
    }

    const myVal = {
        image: `https://uploads.scratch.mit.edu/get_image/project/${scratchTree.id}_${size}x${Math.round(size * (3 / 4))}.png`,
        link: {
            href: `https://scratch.mit.edu/projects/${scratchTree.id}`,
            target: "_blank",
        },
    };
    if (scratchTree.id == window.id) {
        myVal.HTMLclass = "focused-node";
    }
    if (Array.isArray(scratchTree.children) && scratchTree.children.length > 0) {
        myVal.children = scratchTree.children.map((child) => consolidateData(child, level + 1));
    }
    return myVal;
}

function checkLoad() {
    if (document.querySelector(".Treant-loaded")) {
        const nodes = Array.from(document.querySelectorAll(".Treant > .node"));
        const targetNode = document.querySelector(".Treant > .node.focused-node") || nodes.at(-1);
        if (targetNode) {
            targetNode.scrollIntoView({
                behavior: "auto",
                block: "center",
                inline: "center",
            });
        }
        document.querySelector("#loading-container").hidden = true;
    } else {
        setTimeout(checkLoad, 50);
    }
}

async function showProjectInfo(event) {
    if (window.scheduleHide) clearInterval(window.scheduleHide);
    window.scheduleHide = null;

    document.querySelector("#project-preview").hidden = false;
    const id = event.target.href.split("/").at("-1");
    window.fetchTarget = id;
    document.querySelector("#preview-img").src = `https://cdn2.scratch.mit.edu/get_image/project/${id}_200x150.png`;
    let response;
    try {
        response = TreeLoader.compact(Object.assign({}, await TreeLoader.fetchProject(parseInt(id, 10)), { children: [] }));
    } catch {
        return;
    }
    if (window.fetchTarget == id) {
        showPreviewFromNode(response);
    }
}

function scheduleHideProjectInfo() {
    window.scheduleHide = setTimeout(hideProjectInfo, 1000);
}

function hideProjectInfo() {
    document.querySelector("#project-preview").hidden = true;
    document.querySelector("#preview-img").src = "";
    document.querySelectorAll("#preview-title, #preview-author, #preview-created").forEach((el) => (el.innerText = ""));
}

function convertDataForScratch(data, newData, parentId) {
    const children = Array.isArray(data.children) ? data.children : [];
    const authorName = typeof data.author === "string" ? data.author : data.author?.username || "Unknown";
    newData[data.id.toString()] = {
        title: data.title || "Untitled",
        creator: authorName,
        favorite_count: data.stats?.favorites ?? 0,
        love_count: data.stats?.loves ?? 0,
        parent_id: parentId,
        visibility: data.visibility || "visible",
        moderation_status: "safe",
        is_published: data.is_published !== undefined ? data.is_published : true,
        children: children.map((r) => r.id.toString()),
    };
    for (const remix of children) {
        convertDataForScratch(remix, newData, data.id);
    }
}

function fetchTreeStream(id, refreshFlag, onPartial, onProgress) {
    const loadingInfo = document.querySelector("#loading-info");
    return TreeLoader.loadTree(id, {
        refresh: refreshFlag,
        onEvent: (payload) => {
            if (payload.type === "progress") {
                loadingInfo.textContent = payload.message;
                if (onProgress) onProgress(payload.message);
            } else if (payload.type === "partial") {
                if (onPartial) onPartial(payload);
            }
        },
    });
}

/* Load heavy legacy-viewer libraries only when that viewer is selected. */
function loadScriptOnce(src) {
    window._loadedScripts = window._loadedScripts || {};
    if (window._loadedScripts[src]) return window._loadedScripts[src];
    return (window._loadedScripts[src] = new Promise((res, rej) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = res;
        script.onerror = () => rej(new Error("Failed to load " + src));
        document.head.appendChild(script);
    }));
}

async function loadTreantLibs() {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdn.jsdelivr.net/npm/treant-js@1.0.1/Treant.css";
    document.head.appendChild(css);
    // Same order as the original page: jQuery (CDN), Treant, Raphael, local jQuery.
    await loadScriptOnce("https://cdn.jsdelivr.net/npm/jquery@3.7.1");
    await loadScriptOnce("https://cdn.jsdelivr.net/npm/treant-js@1.0.1/Treant.js");
    await loadScriptOnce("assets/libraries/raphael.js");
    await loadScriptOnce("assets/libraries/jquery.min.js");
}

async function setupCanvasViewer(treeData) {
    const wrapper = document.querySelector("#canvas-wrapper");
    const container = document.querySelector("#canvas-container");
    wrapper.hidden = false;

    if (window.CanvasRemixTree.ready) {
        await window.CanvasRemixTree.ready;
    }

    const tree = new window.CanvasRemixTree(container, treeData, {
        focusId: window.id,
        onSelectNode: (node) => showPreviewFromNode(node),
        onHoverNode: (node) => {
            if (node) {
                showPreviewFromNode(node);
            } else {
                const selected = tree.nodeById.get(tree.selectedId);
                if (selected) showPreviewFromNode(selected.raw);
                else showPreviewFromNode(null);
            }
        },
    });
    window.canvasTree = tree;

    const initialSelected = tree.nodeById.get(tree.selectedId);
    if (initialSelected) {
        showPreviewFromNode(initialSelected.raw);
    }

    document.querySelector("#hud-zoom-in").onclick = () => tree.zoomIn();
    document.querySelector("#hud-zoom-reset").onclick = () => tree.zoomReset();
    document.querySelector("#hud-zoom-out").onclick = () => tree.zoomOut();
    document.querySelector("#hud-fit").onclick = () => tree.fitTree();
    document.querySelector("#hud-focus").onclick = () => tree.focusProject();
    document.querySelector("#hud-root").onclick = () => tree.focusRoot();

    const searchBox = document.querySelector("#search-box");
    const searchInput = document.querySelector("#tree-search");
    const searchResults = document.querySelector("#search-results");
    searchBox.hidden = false;
    let searchMatches = [];
    let activeIdx = 0;

    function selectMatch(idx, hideDropdown = false) {
        if (!searchMatches.length) return;
        activeIdx = ((idx % searchMatches.length) + searchMatches.length) % searchMatches.length;
        const match = searchMatches[activeIdx];
        tree.centerOnNode(match.node, Math.max(tree.zoom, 0.85));
        const items = searchResults.querySelectorAll(".search-item");
        items.forEach((el, i) => el.classList.toggle("active", i === activeIdx));
        if (items[activeIdx]) {
            items[activeIdx].scrollIntoView({ block: "nearest" });
        }
        if (hideDropdown) {
            searchResults.hidden = true;
        }
    }

    function renderSearchDropdown() {
        const q = searchInput.value.trim();
        if (!q) {
            searchResults.hidden = true;
            searchResults.innerHTML = "";
            return;
        }

        const searchRes = tree.search(q);
        const total = searchRes.total ?? searchRes.length ?? 0;
        searchMatches = searchRes.items || searchRes;
        activeIdx = 0;
        searchResults.innerHTML = "";

        const summary = document.createElement("div");
        summary.className = "search-summary";
        summary.textContent =
            total === 0
                ? "No matching projects or creators"
                : `${total} match${total === 1 ? "" : "es"}${
                      total > searchMatches.length ? ` (showing top ${searchMatches.length})` : ""
                  }`;
        searchResults.appendChild(summary);

        const limit = searchMatches.length;
        for (let i = 0; i < limit; i++) {
            const m = searchMatches[i];
            const item = document.createElement("div");
            item.className = "search-item" + (i === 0 ? " active" : "");

            const titleEl = document.createElement("div");
            titleEl.className = "search-item-title";
            titleEl.textContent = m.title;

            const metaEl = document.createElement("div");
            metaEl.className = "search-item-meta";
            metaEl.textContent = `by ${m.author} • Layer ${m.depth + 1} • #${m.id}`;

            item.append(titleEl, metaEl);
            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                selectMatch(i, true);
            });
            searchResults.appendChild(item);
        }

        searchResults.hidden = false;
    }

    window._refreshCanvasSearch = () => {
        if (searchInput.value.trim() && document.activeElement === searchInput) {
            renderSearchDropdown();
        }
    };

    searchInput.addEventListener("input", () => {
        renderSearchDropdown();
    });

    searchInput.addEventListener("focus", () => {
        if (searchInput.value.trim()) {
            renderSearchDropdown();
        }
    });

    searchInput.addEventListener("blur", () => {
        setTimeout(() => {
            searchResults.hidden = true;
        }, 120);
    });

    searchInput.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            if (searchMatches.length > 0) selectMatch(activeIdx + 1, false);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (searchMatches.length > 0) selectMatch(activeIdx - 1, false);
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (searchMatches.length === 0 && searchInput.value.trim()) {
                renderSearchDropdown();
            }
            if (searchMatches.length > 0) {
                selectMatch(activeIdx, false);
                activeIdx = (activeIdx + 1) % searchMatches.length;
            }
        } else if (e.key === "Escape") {
            searchResults.hidden = true;
            searchInput.blur();
        }
    });

    document.querySelector("#loading-container").hidden = true;
}

function patchScratchPageturners() {
    // Make sure pageturners (e.g. "611 more >") sit above project boxes and their SVG text doesn't swallow clicks
    if (window.App && window.App.rootView) {
        const queue = [window.App.rootView];
        while (queue.length > 0) {
            const branchView = queue.pop();
            if (branchView.pageturners) {
                branchView.pageturners.sprite.toFront();
                for (const textSet of [branchView.pageturners.leftText, branchView.pageturners.rightText]) {
                    textSet?.forEach?.((el) => {
                        if (el?.node) el.node.setAttribute("pointer-events", "none");
                    });
                }
            }
            if (Array.isArray(branchView.myBranches)) {
                for (const child of branchView.myBranches) queue.push(child);
            }
        }
    }
}

(async function () {
    window.id = parseInt(location.hash.slice(1), 10);
    if (!window.id) {
        location.href = "./";
        return;
    }
    const params = new URLSearchParams(location.search);
    window.offset = params.get("offset") ?? 0;
    window.viewer = params.get("viewer") ?? "canvas";
    document.querySelector("select").value = window.viewer;
    const getNew = params.get("new");
    params.delete("new");
    let paramsString = "?" + params.toString();
    if (paramsString == "?") {
        paramsString = "";
    }
    window.history.replaceState({}, "", `${location.origin}${location.pathname}${paramsString}${location.hash}`);
    document.querySelector("#idPicker").value = window.id;

    let canvasInitialized = false;
    let latestPartialMeta = null;
    let latestProgressMsg = "streaming...";
    let partialChain = Promise.resolve();

    const applyPartialPayload = async (payload) => {
        if (window.viewer !== "canvas") return;
        latestPartialMeta = payload;
        window.data = payload.tree;
        updateHeaderInfo(payload.enteredProject, payload.rootProject, payload.tree, true, latestProgressMsg);
        if (!canvasInitialized) {
            canvasInitialized = true;
            await setupCanvasViewer(payload.tree);
        } else if (window.canvasTree) {
            window.canvasTree.updateData(payload.tree);
            if (window._refreshCanvasSearch) window._refreshCanvasSearch();
        }
    };

    let result;
    try {
        result = await fetchTreeStream(
            window.id,
            Boolean(getNew),
            (payload) => {
                partialChain = partialChain.then(() => applyPartialPayload(payload));
                return partialChain;
            },
            (msg) => {
                latestProgressMsg = msg;
                if (canvasInitialized && latestPartialMeta) {
                    updateHeaderInfo(
                        latestPartialMeta.enteredProject,
                        latestPartialMeta.rootProject,
                        window.data,
                        true,
                        msg
                    );
                }
            }
        );
        await partialChain;
    } catch (err) {
        console.error(err);
        const msg = err.status === 404 ? "Project not found." : err.status === 502 ? err.message : "Failed to load remix tree.";
        document.querySelector("#loading-info").innerHTML = `<div>${msg}</div><div><a href="./">Go back</a></div>`;
        return;
    }

    const { enteredProject, rootProject, tree } = result;
    window.data = tree;
    updateHeaderInfo(enteredProject, rootProject, tree, false);

    if (window.viewer == "canvas") {
        if (!canvasInitialized) {
            document.querySelector("#loading-info").innerHTML = "Rendering remix tree...";
            await setupCanvasViewer(tree);
        } else if (window.canvasTree) {
            window.canvasTree.updateData(tree);
            if (window._refreshCanvasSearch) window._refreshCanvasSearch();
        }
    } else if (window.viewer == "treant") {
        await loadTreantLibs();
        document.querySelector("#treant-remixtree").hidden = false;
        const chart_config = {
            chart: {
                container: "#treant-remixtree",
                rootOrientation: "SOUTH",
                maxDepth: 10000,
                levelSeparation: 10,
                siblingSeparation: 5,
                connectors: {},
            },
            nodeStructure: consolidateData(tree),
        };

        setTimeout(checkLoad, 100);

        window.tree = new Treant(chart_config);
        const nodes = Array.from(document.querySelectorAll(".Treant > .node"));
        for (const node of nodes) {
            const str = node.children[0].src;
            const idx = str.lastIndexOf("_") + 1;
            const idx2 = str.lastIndexOf(".png");
            const targetSize = str.slice(idx, idx2).split("x");
            node.style.width = targetSize[0] + "px";
            node.style.height = targetSize[1] + "px";

            node.addEventListener("mouseenter", showProjectInfo);
            node.addEventListener("mouseleave", scheduleHideProjectInfo);
        }
        const targetNode = document.querySelector(".Treant > .node.focused-node") || nodes.at(-1);
        if (targetNode) {
            targetNode.scrollIntoView({
                behavior: "auto",
                block: "center",
                inline: "center",
            });
        }
    } else if (window.viewer == "scratch") {
        document.querySelector("#container").style.display = "flex";
        await treeScratch(tree);
        patchScratchPageturners();
        handleResize();
        setTimeout(() => {
            document.querySelector("#container").style.backgroundColor = "#92b5ca";
            document.querySelector("#zoomContainer").hidden = false;
            document.querySelector("#loading-container").hidden = true;
        }, 0);
    }
})();

async function treeScratch(data) {
    /*
    Some code from https://github.com/CST1229/treemix under the MIT license, modified by me
    */
    let treeURL = "";

    const newData = {};
    newData.id = window.id;
    newData.root_id = data.id;
    convertDataForScratch(data, newData, null);

    window.scratchTreeData = newData;

    window.navData = [];
    window.Scratch = {};
    Scratch.INIT_DATA = {};
    Scratch.INIT_DATA.GLOBAL_URLS = {
        media_url: "https://uploads.scratch.mit.edu/",
        static_url: "https://cdn.scratch.mit.edu/scratchr2/static/__5b3e40ec58a840b41702360e9891321b__/",
        static_path: "https://scratch.mit.edu/scratchr2/static/__5b3e40ec58a840b41702360e9891321b__/",
    };
    treeURL = URL.createObjectURL(new Blob([JSON.stringify(newData)], { type: "text/plain" }));

    await loadScriptOnce("assets/libraries/jquery.min.js");
    await loadScriptOnce("assets/libraries/treejs.js");
    window.buildTree(treeURL, window.id);
}
