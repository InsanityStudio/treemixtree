use futures_util::stream::{FuturesUnordered, StreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::io::{self, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

const PAGE_SIZE: usize = 10;
const SLIDING_CONCURRENCY: usize = 6;

#[derive(Deserialize, Clone, Debug)]
struct RawAuthorObj {
    username: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(untagged)]
enum RawAuthor {
    Name(String),
    Obj(RawAuthorObj),
}

#[derive(Deserialize, Clone, Debug, Default)]
struct RawStats {
    loves: Option<u64>,
    favorites: Option<u64>,
    views: Option<u64>,
    remixes: Option<u64>,
}

#[derive(Deserialize, Clone, Debug, Default)]
struct RawHistory {
    created: Option<String>,
    shared: Option<String>,
}

#[derive(Deserialize, Clone, Debug, Default)]
struct RawRemix {
    parent: Option<u64>,
    root: Option<u64>,
}

#[derive(Deserialize, Clone, Debug)]
struct RawNode {
    id: u64,
    title: Option<String>,
    author: Option<RawAuthor>,
    stats: Option<RawStats>,
    visibility: Option<String>,
    is_published: Option<bool>,
    history: Option<RawHistory>,
    created: Option<String>,
    shared: Option<String>,
    remix: Option<RawRemix>,
    children: Option<Vec<RawNode>>,
}

#[derive(Serialize, Clone, Debug)]
struct CompactStats {
    loves: u64,
    favorites: u64,
    views: u64,
    remixes: u64,
}

#[derive(Serialize, Clone, Debug)]
struct CompactNode {
    id: u64,
    title: String,
    author: String,
    stats: CompactStats,
    visibility: String,
    is_published: bool,
    created: Option<String>,
    shared: Option<String>,
    #[serde(skip)]
    sort_ms: i64,
    children: Vec<CompactNode>,
}

fn parse_iso_ms(s: Option<&str>) -> i64 {
    let s = match s {
        Some(v) if !v.is_empty() => v,
        _ => return i64::MAX,
    };
    // Fast zero-alloc ISO-8601 UTC timestamp parser: YYYY-MM-DDTHH:MM:SS...
    let b = s.as_bytes();
    if b.len() < 10 {
        return i64::MAX;
    }
    let parse_num = |slice: &[u8]| -> Option<i64> {
        let mut val = 0i64;
        for &ch in slice {
            if !ch.is_ascii_digit() {
                return None;
            }
            val = val * 10 + (ch - b'0') as i64;
        }
        Some(val)
    };
    let year = match parse_num(&b[0..4]) {
        Some(v) => v,
        None => return i64::MAX,
    };
    let month = match parse_num(&b[5..7]) {
        Some(v) if (1..=12).contains(&v) => v,
        _ => return i64::MAX,
    };
    let day = match parse_num(&b[8..10]) {
        Some(v) if (1..=31).contains(&v) => v,
        _ => return i64::MAX,
    };
    let (hour, min, sec) = if b.len() >= 19 {
        (
            parse_num(&b[11..13]).unwrap_or(0),
            parse_num(&b[14..16]).unwrap_or(0),
            parse_num(&b[17..19]).unwrap_or(0),
        )
    } else {
        (0, 0, 0)
    };

    // Days since 1970-01-01 using Howard Hinnant's civil-from-days inverse
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let total_secs = days * 86400 + hour * 3600 + min * 60 + sec;
    total_secs * 1000
}

fn compact_node(raw: RawNode) -> CompactNode {
    let title = raw
        .title
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Untitled".to_string());
    let author = match raw.author {
        Some(RawAuthor::Name(s)) if !s.is_empty() => s,
        Some(RawAuthor::Obj(o)) => o
            .username
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Unknown".to_string()),
        _ => "Unknown".to_string(),
    };
    let stats = raw.stats.unwrap_or_default();
    let hist = raw.history.unwrap_or_default();
    let created = hist
        .created
        .clone()
        .or(raw.created)
        .or_else(|| hist.shared.clone())
        .or_else(|| raw.shared.clone());
    let shared = hist.shared.or(created.clone()).or(raw.shared);
    let sort_ms = parse_iso_ms(created.as_deref().or(shared.as_deref()));

    let mut children: Vec<CompactNode> = raw
        .children
        .unwrap_or_default()
        .into_iter()
        .map(compact_node)
        .collect();
    if children.len() > 1 {
        children.sort_unstable_by(|a, b| a.sort_ms.cmp(&b.sort_ms).then_with(|| a.id.cmp(&b.id)));
    }

    CompactNode {
        id: raw.id,
        title,
        author,
        stats: CompactStats {
            loves: stats.loves.unwrap_or(0),
            favorites: stats.favorites.unwrap_or(0),
            views: stats.views.unwrap_or(0),
            remixes: stats.remixes.unwrap_or(0),
        },
        visibility: raw.visibility.unwrap_or_else(|| "visible".to_string()),
        is_published: raw.is_published.unwrap_or(true),
        created,
        shared,
        sort_ms,
        children,
    }
}

fn count_nodes(node: &CompactNode) -> usize {
    let mut total = 1usize;
    for c in &node.children {
        total += count_nodes(c);
    }
    total
}

fn contains_id(node: &CompactNode, target_id: u64) -> bool {
    if node.id == target_id {
        return true;
    }
    for c in &node.children {
        if contains_id(c, target_id) {
            return true;
        }
    }
    false
}

fn attach_child(root: &mut CompactNode, target_parent_id: u64, child: CompactNode) -> bool {
    if root.id == target_parent_id {
        if !root.children.iter().any(|c| c.id == child.id) {
            root.children.push(child);
            root.children
                .sort_unstable_by(|a, b| a.sort_ms.cmp(&b.sort_ms).then_with(|| a.id.cmp(&b.id)));
        }
        return true;
    }
    for c in &mut root.children {
        if attach_child(c, target_parent_id, child.clone()) {
            return true;
        }
    }
    false
}

fn emit_json<T: Serialize>(val: &T) {
    if let Ok(line) = serde_json::to_string(val) {
        let mut stdout = io::stdout().lock();
        let _ = stdout.write_all(line.as_bytes());
        let _ = stdout.write_all(b"\n");
        let _ = stdout.flush();
    }
}

#[derive(Serialize)]
struct ProgressEvent<'a> {
    #[serde(rename = "type")]
    ev_type: &'a str,
    stage: &'a str,
    message: String,
}

#[derive(Serialize)]
struct PartialEvent<'a> {
    #[serde(rename = "type")]
    ev_type: &'a str,
    #[serde(rename = "enteredProject")]
    entered_project: &'a CompactNode,
    #[serde(rename = "rootProject")]
    root_project: &'a CompactNode,
    tree: &'a CompactNode,
}

#[derive(Serialize)]
struct ErrorEvent<'a> {
    #[serde(rename = "type")]
    ev_type: &'a str,
    status: u16,
    message: String,
}

#[derive(Debug)]
struct FetchErr {
    status: u16,
    message: String,
}

async fn fetch_turbowarp_project(client: &Client, id: u64) -> Result<RawNode, FetchErr> {
    let url = format!("https://trampoline.turbowarp.org/api/projects/{}", id);
    let mut last_err = FetchErr {
        status: 500,
        message: "Failed to fetch project".to_string(),
    };
    for attempt in 0..3 {
        match client
            .get(&url)
            .timeout(Duration::from_secs(12))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                if status == 404 {
                    return Err(FetchErr {
                        status: 404,
                        message: "Project not found".to_string(),
                    });
                }
                if !resp.status().is_success() {
                    last_err = FetchErr {
                        status,
                        message: format!("TurboWarp API error: {}", status),
                    };
                } else {
                    match resp.json::<RawNode>().await {
                        Ok(node) => return Ok(node),
                        Err(e) => {
                            last_err = FetchErr {
                                status: 502,
                                message: e.to_string(),
                            };
                        }
                    }
                }
            }
            Err(e) => {
                last_err = FetchErr {
                    status: 504,
                    message: e.to_string(),
                };
            }
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(250 * (attempt + 1) as u64)).await;
        }
    }
    Err(last_err)
}

async fn fetch_quuq_page(
    client: &Client,
    root_id: u64,
    offset: usize,
    refresh: bool,
) -> Result<(usize, RawNode), (usize, String)> {
    let url = format!("https://renderapi.quuq.dev/remixtree/{}?offset={}", root_id, offset);
    let timeouts = [15u64, 22, 30];
    for attempt in 0..3 {
        let mut req = client.get(&url).timeout(Duration::from_secs(timeouts[attempt]));
        if refresh {
            req = req.header("X-RefreshTree", "true");
        }
        match req.send().await {
            Ok(resp) => {
                if resp.status().is_success() {
                    if let Ok(parsed) = resp.json::<RawNode>().await {
                        return Ok((offset, parsed));
                    }
                }
            }
            Err(_) => {}
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(350 * (attempt + 1) as u64)).await;
        }
    }
    Err((offset, format!("Failed offset {}", offset)))
}

struct DisconnectedBranch {
    attach_target_id: u64,
    branch_node: CompactNode,
}

async fn resolve_disconnected_branch(
    client: &Client,
    entered_raw: RawNode,
    root_id: u64,
    refresh: bool,
) -> Option<DisconnectedBranch> {
    if entered_raw.id == root_id {
        return None;
    }

    let mut curr_id = entered_raw.remix.as_ref().and_then(|r| r.parent);
    let mut visited = HashSet::new();
    visited.insert(entered_raw.id);

    let mut chain_meta: Vec<RawNode> = vec![entered_raw];
    let mut highest_reachable_id = chain_meta[0].id;
    let mut broken_parent_id: Option<u64> = None;

    while let Some(pid) = curr_id {
        if pid == root_id || !visited.insert(pid) {
            break;
        }
        match fetch_turbowarp_project(client, pid).await {
            Ok(meta) => {
                highest_reachable_id = meta.id;
                curr_id = meta.remix.as_ref().and_then(|r| r.parent);
                chain_meta.push(meta);
            }
            Err(_) => {
                broken_parent_id = Some(pid);
                break;
            }
        }
    }

    let mut branch_tree = if broken_parent_id.is_some() {
        match fetch_quuq_page(client, highest_reachable_id, 0, refresh).await {
            Ok((_, raw_branch)) => Some(compact_node(raw_branch)),
            Err(_) => None,
        }
    } else {
        None
    };

    if branch_tree.is_none() && !chain_meta.is_empty() {
        let mut acc: Option<CompactNode> = None;
        for raw in chain_meta.iter().cloned() {
            let mut c = compact_node(raw);
            c.children = acc.into_iter().collect();
            acc = Some(c);
        }
        branch_tree = acc;
    } else if let Some(ref mut bt) = branch_tree {
        // Ensure all nodes in chain_meta down to entered are present inside bt
        let entered_id = chain_meta[0].id;
        if !contains_id(bt, entered_id) {
            for raw in chain_meta.iter().rev().cloned() {
                if !contains_id(bt, raw.id) {
                    if let Some(pid) = raw.remix.as_ref().and_then(|r| r.parent) {
                        let c = compact_node(raw);
                        attach_child(bt, pid, c);
                    }
                }
            }
        }
    }

    let bt = branch_tree?;
    let attach_target_id = if broken_parent_id.is_some() {
        root_id
    } else {
        chain_meta
            .last()
            .and_then(|top| top.remix.as_ref().and_then(|r| r.parent))
            .unwrap_or(root_id)
    };

    let node_to_attach = if let Some(bpid) = broken_parent_id {
        if bpid != highest_reachable_id {
            let created = bt.created.clone().or_else(|| bt.shared.clone());
            let shared = bt.shared.clone().or_else(|| bt.created.clone());
            let sort_ms = parse_iso_ms(created.as_deref());
            CompactNode {
                id: bpid,
                title: format!("Unshared Project #{}", bpid),
                author: "Unknown".to_string(),
                stats: CompactStats {
                    loves: 0,
                    favorites: 0,
                    views: 0,
                    remixes: 1,
                },
                visibility: "notvisible".to_string(),
                is_published: false,
                created,
                shared,
                sort_ms,
                children: vec![bt],
            }
        } else {
            bt
        }
    } else {
        bt
    };

    Some(DisconnectedBranch {
        attach_target_id,
        branch_node: node_to_attach,
    })
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        emit_json(&ErrorEvent {
            ev_type: "error",
            status: 400,
            message: "Missing project ID".to_string(),
        });
        std::process::exit(1);
    }
    let start_id: u64 = match args[1].parse() {
        Ok(id) if id > 0 => id,
        _ => {
            emit_json(&ErrorEvent {
                ev_type: "error",
                status: 400,
                message: "Invalid project ID".to_string(),
            });
            std::process::exit(1);
        }
    };
    let refresh = args.iter().any(|a| a == "--refresh");

    let client = Arc::new(
        Client::builder()
            .pool_max_idle_per_host(8)
            .tcp_keepalive(Duration::from_secs(30))
            .http1_only()
            .user_agent("treemixtree-rust/1.0")
            .build()
            .expect("HTTP client init failed"),
    );

    emit_json(&ProgressEvent {
        ev_type: "progress",
        stage: "parent",
        message: format!("Resolving project {}...", start_id),
    });

    let entered_raw = match fetch_turbowarp_project(&client, start_id).await {
        Ok(p) => p,
        Err(e) => {
            emit_json(&ErrorEvent {
                ev_type: "error",
                status: e.status,
                message: e.message,
            });
            return;
        }
    };
    let entered_compact = compact_node(entered_raw.clone());

    // Resolve root metadata immediately (single fast jump when remix.root is present)
    let mut root_raw = entered_raw.clone();
    if let Some(fast_root_id) = entered_raw.remix.as_ref().and_then(|r| r.root) {
        if fast_root_id != entered_raw.id {
            emit_json(&ProgressEvent {
                ev_type: "progress",
                stage: "parent",
                message: format!("Jumping to root project {}...", fast_root_id),
            });
            if let Ok(candidate) = fetch_turbowarp_project(&client, fast_root_id).await {
                root_raw = candidate;
            }
        }
    }

    // Fallback parent climb only if root_raw still has a non-null parent
    let mut visited = HashSet::new();
    visited.insert(entered_raw.id);
    visited.insert(root_raw.id);
    let mut curr_parent = root_raw.remix.as_ref().and_then(|r| r.parent);
    while let Some(pid) = curr_parent {
        if !visited.insert(pid) {
            break;
        }
        emit_json(&ProgressEvent {
            ev_type: "progress",
            stage: "parent",
            message: format!("Climbing parent {}...", pid),
        });
        match fetch_turbowarp_project(&client, pid).await {
            Ok(p) => {
                curr_parent = p.remix.as_ref().and_then(|r| r.parent);
                root_raw = p;
            }
            Err(_) => break,
        }
    }

    let root_id = root_raw.id;
    let root_compact = compact_node(root_raw.clone());
    let est_remixes = root_compact.stats.remixes as usize;

    emit_json(&ProgressEvent {
        ev_type: "progress",
        stage: "tree",
        message: format!(
            "Streaming remix tree for #{} (~{} direct remixes)...",
            root_id, est_remixes
        ),
    });

    // Spawn parallel resolution of entered project's branch if entered_id != root_id
    let branch_handle = if entered_raw.id != root_id {
        let c = client.clone();
        let er = entered_raw.clone();
        Some(tokio::spawn(async move {
            resolve_disconnected_branch(&c, er, root_id, refresh).await
        }))
    } else {
        None
    };

    // Determine initial offsets to pipeline immediately based on est_remixes
    // If est_remixes == 0, still probe offset=0. If est_remixes > 0, queue 0, 10, ..., last_known + 10
    let mut next_offset: usize = 0;
    let initial_end_offset = if est_remixes > 0 {
        ((est_remixes - 1) / PAGE_SIZE) * PAGE_SIZE
    } else {
        0
    };

    let mut in_flight = FuturesUnordered::new();
    let max_initial_queued = initial_end_offset.min(1200); // cap initial blind queue at 120 pages
    while next_offset <= max_initial_queued && in_flight.len() < SLIDING_CONCURRENCY {
        let off = next_offset;
        next_offset += PAGE_SIZE;
        let c = client.clone();
        in_flight.push(tokio::spawn(async move {
            fetch_quuq_page(&c, root_id, off, refresh).await
        }));
    }

    let mut pages_by_offset: HashMap<usize, Vec<CompactNode>> = HashMap::new();
    let mut root_from_quuq: Option<CompactNode> = None;
    let mut saw_short_page = false;
    let mut smallest_short_offset = usize::MAX;
    let mut last_partial_emit = Instant::now() - Duration::from_secs(5);
    let mut emitted_initial_partial = false;
    let mut cached_branch: Option<DisconnectedBranch> = None;
    let mut branch_checked = branch_handle.is_none();
    let mut branch_task = branch_handle;

    // Helper closure-style builder
    let assemble_tree = |base_root: &CompactNode,
                         pages: &HashMap<usize, Vec<CompactNode>>,
                         branch: Option<&DisconnectedBranch>,
                         entered_id: u64|
     -> (CompactNode, usize) {
        let mut tree = base_root.clone();
        let mut seen = HashSet::new();
        let mut direct_children = Vec::new();
        let mut offsets: Vec<usize> = pages.keys().copied().collect();
        offsets.sort_unstable();
        for off in offsets {
            if let Some(list) = pages.get(&off) {
                for ch in list {
                    if seen.insert(ch.id) {
                        direct_children.push(ch.clone());
                    }
                }
            }
        }
        direct_children
            .sort_unstable_by(|a, b| a.sort_ms.cmp(&b.sort_ms).then_with(|| a.id.cmp(&b.id)));
        tree.children = direct_children;

        if !contains_id(&tree, entered_id) {
            if let Some(br) = branch {
                let attached = attach_child(&mut tree, br.attach_target_id, br.branch_node.clone());
                if !attached {
                    attach_child(&mut tree, base_root.id, br.branch_node.clone());
                }
            }
        }
        let total = count_nodes(&tree);
        (tree, total)
    };

    loop {
        if in_flight.is_empty() {
            break;
        }

        let res_opt = tokio::select! {
            branch_res = async { branch_task.as_mut().unwrap().await }, if !branch_checked && branch_task.is_some() => {
                cached_branch = branch_res.ok().flatten();
                branch_checked = true;
                branch_task = None;

                if !emitted_initial_partial && cached_branch.is_some() {
                    let base = root_from_quuq.as_ref().unwrap_or(&root_compact);
                    let (partial_tree, total) = assemble_tree(
                        base,
                        &pages_by_offset,
                        cached_branch.as_ref(),
                        entered_compact.id,
                    );
                    emit_json(&PartialEvent {
                        ev_type: "partial",
                        entered_project: &entered_compact,
                        root_project: base,
                        tree: &partial_tree,
                    });
                    emit_json(&ProgressEvent {
                        ev_type: "progress",
                        stage: "tree",
                        message: format!(
                            "Loaded branch ({} nodes) • streaming full tree...",
                            total
                        ),
                    });
                    emitted_initial_partial = true;
                    last_partial_emit = Instant::now();
                }
                continue;
            }
            page_res = in_flight.next() => page_res,
        };

        let res = match res_opt {
            Some(r) => r,
            None => break,
        };

        if let Ok(Ok((off, raw_page))) = res {
            let children_raw = raw_page.children.clone().unwrap_or_default();
            let raw_len = children_raw.len();
            if off == 0 && root_from_quuq.is_none() {
                let mut r_clean = raw_page;
                r_clean.children = None;
                root_from_quuq = Some(compact_node(r_clean));
            }
            let compacted_list: Vec<CompactNode> =
                children_raw.into_iter().map(compact_node).collect();
            pages_by_offset.insert(off, compacted_list);

            if raw_len < PAGE_SIZE {
                saw_short_page = true;
                if off < smallest_short_offset {
                    smallest_short_offset = off;
                }
            } else if off >= initial_end_offset && !saw_short_page {
                if next_offset <= off + PAGE_SIZE {
                    next_offset = off + PAGE_SIZE;
                }
            }
        }

        let target_limit = if saw_short_page {
            smallest_short_offset
        } else {
            initial_end_offset.max(next_offset)
        };
        while in_flight.len() < SLIDING_CONCURRENCY && next_offset <= target_limit {
            if saw_short_page && next_offset >= smallest_short_offset {
                break;
            }
            let off = next_offset;
            next_offset += PAGE_SIZE;
            let c = client.clone();
            in_flight.push(tokio::spawn(async move {
                fetch_quuq_page(&c, root_id, off, refresh).await
            }));
        }

        let should_emit = (!emitted_initial_partial && !pages_by_offset.is_empty())
            || (last_partial_emit.elapsed() >= Duration::from_millis(750)
                && !pages_by_offset.is_empty());
        if should_emit && !in_flight.is_empty() {
            let base = root_from_quuq.as_ref().unwrap_or(&root_compact);
            let (partial_tree, total) = assemble_tree(
                base,
                &pages_by_offset,
                cached_branch.as_ref(),
                entered_compact.id,
            );
            emit_json(&PartialEvent {
                ev_type: "partial",
                entered_project: &entered_compact,
                root_project: base,
                tree: &partial_tree,
            });
            emit_json(&ProgressEvent {
                ev_type: "progress",
                stage: "tree",
                message: format!(
                    "Streaming remixes: {} / ~{} direct ({} total loaded)...",
                    partial_tree.children.len(),
                    est_remixes.max(partial_tree.children.len()),
                    total
                ),
            });
            emitted_initial_partial = true;
            last_partial_emit = Instant::now();
        }
    }

    if !branch_checked {
        if let Some(bt) = branch_task {
            cached_branch = bt.await.ok().flatten();
        }
    }

    let final_base = root_from_quuq.as_ref().unwrap_or(&root_compact);
    let (final_tree, _) = assemble_tree(
        final_base,
        &pages_by_offset,
        cached_branch.as_ref(),
        entered_compact.id,
    );

    emit_json(&PartialEvent {
        ev_type: "done",
        entered_project: &entered_compact,
        root_project: final_base,
        tree: &final_tree,
    });
}
