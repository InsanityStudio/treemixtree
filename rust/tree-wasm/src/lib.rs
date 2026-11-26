use std::alloc::{alloc as std_alloc, dealloc as std_dealloc, Layout};
use std::cmp::Ordering;
use std::slice;

const NODE_W: f64 = 72.0;
const NODE_H: f64 = 54.0;
const GAP_X: f64 = 18.0;
const LAYER_H: f64 = 120.0;

#[no_mangle]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return std::ptr::null_mut();
    }
    let layout = Layout::from_size_align(size, 8).expect("invalid layout");
    unsafe { std_alloc(layout) }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    let layout = Layout::from_size_align(size, 8).expect("invalid layout");
    unsafe { std_dealloc(ptr, layout) }
}

#[inline]
fn cmp_f64(a: f64, b: f64) -> Ordering {
    a.total_cmp(&b)
}

/// Strict bottom-to-top layered planar tidy-tree layout:
/// - Sorts each node's children chronologically by (created_ms, id) in-place.
/// - Root (depth 0) on Layer 1 at y = 0, Layer 2 at y = -120, etc.
/// - Disjoint subtree spans & centered parents -> zero intersecting edges.
/// - Outputs x, y, descendant counts, bounds, and binary-searchable per-layer order.
#[no_mangle]
pub extern "C" fn compute_layout(
    n: usize,
    depth_ptr: *const i32,
    created_ptr: *const f64,
    id_ptr: *const f64,
    children_start_ptr: *const i32,
    children_len_ptr: *const i32,
    children_list_ptr: *mut i32,
    children_list_len: usize,
    out_x_ptr: *mut f64,
    out_y_ptr: *mut f64,
    out_desc_ptr: *mut i32,
    out_bounds_ptr: *mut f64,
    out_max_depth_ptr: *mut i32,
    out_layer_order_ptr: *mut i32,
    out_layer_start_ptr: *mut i32,
    out_layer_len_ptr: *mut i32,
) {
    if n == 0 {
        return;
    }

    let depth = unsafe { slice::from_raw_parts(depth_ptr, n) };
    let created = unsafe { slice::from_raw_parts(created_ptr, n) };
    let ids = unsafe { slice::from_raw_parts(id_ptr, n) };
    let children_start = unsafe { slice::from_raw_parts(children_start_ptr, n) };
    let children_len = unsafe { slice::from_raw_parts(children_len_ptr, n) };
    let children_list = if children_list_len > 0 {
        unsafe { slice::from_raw_parts_mut(children_list_ptr, children_list_len) }
    } else {
        &mut []
    };

    let out_x = unsafe { slice::from_raw_parts_mut(out_x_ptr, n) };
    let out_y = unsafe { slice::from_raw_parts_mut(out_y_ptr, n) };
    let out_desc = unsafe { slice::from_raw_parts_mut(out_desc_ptr, n) };
    let out_bounds = unsafe { slice::from_raw_parts_mut(out_bounds_ptr, 4) };
    let out_max_depth = unsafe { slice::from_raw_parts_mut(out_max_depth_ptr, 1) };
    let out_layer_order = unsafe { slice::from_raw_parts_mut(out_layer_order_ptr, n) };
    let out_layer_start = unsafe { slice::from_raw_parts_mut(out_layer_start_ptr, n) };
    let out_layer_len = unsafe { slice::from_raw_parts_mut(out_layer_len_ptr, n) };

    // Sort children at every node by creation timestamp ascending, then numeric ID
    for u in 0..n {
        let len = children_len[u] as usize;
        if len > 1 {
            let start = children_start[u] as usize;
            children_list[start..start + len].sort_unstable_by(|&a_i, &b_i| {
                let a = a_i as usize;
                let b = b_i as usize;
                cmp_f64(created[a], created[b]).then_with(|| cmp_f64(ids[a], ids[b]))
            });
        }
    }

    let slot_w = NODE_W + GAP_X;
    let mut subtree_width = vec![slot_w; n];

    // Iterative DFS order (root first, sorted children left-to-right)
    let mut order = Vec::with_capacity(n);
    let mut stack = Vec::with_capacity(n);
    stack.push(0usize);
    while let Some(u) = stack.pop() {
        order.push(u);
        let start = children_start[u] as usize;
        let len = children_len[u] as usize;
        let mut i = len;
        while i > 0 {
            i -= 1;
            stack.push(children_list[start + i] as usize);
        }
    }

    // Bottom-up pass: compute descendant counts and disjoint subtree widths
    for &u in order.iter().rev() {
        let start = children_start[u] as usize;
        let len = children_len[u] as usize;
        if len == 0 {
            out_desc[u] = 0;
            subtree_width[u] = slot_w;
            continue;
        }

        let mut desc_sum: i32 = 0;
        let mut width_sum: f64 = 0.0;
        for i in 0..len {
            let c = children_list[start + i] as usize;
            desc_sum += 1 + out_desc[c];
            width_sum += subtree_width[c];
        }
        out_desc[u] = desc_sum;
        subtree_width[u] = slot_w.max(width_sum);
    }

    // Top-down pass: assign strictly disjoint horizontal intervals
    let mut pos_stack: Vec<(usize, f64)> = Vec::with_capacity(n);
    pos_stack.push((0, 0.0));

    while let Some((u, left_x)) = pos_stack.pop() {
        out_y[u] = -(depth[u] as f64) * LAYER_H;
        let start = children_start[u] as usize;
        let len = children_len[u] as usize;
        if len == 0 {
            out_x[u] = left_x + subtree_width[u] * 0.5;
            continue;
        }

        let mut child_left = left_x;
        let base_stack_len = pos_stack.len();
        pos_stack.resize(base_stack_len + len, (0, 0.0));
        for j in 0..len {
            let c = children_list[start + j] as usize;
            pos_stack[base_stack_len + (len - 1 - j)] = (c, child_left);
            child_left += subtree_width[c];
        }
    }

    // Bottom-up pass: center every parent strictly over its first and last child
    for &u in order.iter().rev() {
        let len = children_len[u] as usize;
        if len == 0 {
            continue;
        }
        let start = children_start[u] as usize;
        let first_c = children_list[start] as usize;
        let last_c = children_list[start + len - 1] as usize;
        out_x[u] = (out_x[first_c] + out_x[last_c]) * 0.5;
    }

    // Compute world bounds & max depth
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut max_depth: i32 = 0;
    let hw = NODE_W * 0.5;
    let hh = NODE_H * 0.5;

    for i in 0..n {
        let x = out_x[i];
        let y = out_y[i];
        let d = depth[i];
        if d > max_depth {
            max_depth = d;
        }
        if x - hw < min_x {
            min_x = x - hw;
        }
        if x + hw > max_x {
            max_x = x + hw;
        }
        if y - hh < min_y {
            min_y = y - hh;
        }
        if y + hh + 26.0 > max_y {
            max_y = y + hh + 26.0;
        }
    }

    out_bounds[0] = min_x - 100.0;
    out_bounds[1] = max_x + 100.0;
    out_bounds[2] = min_y - 80.0;
    out_bounds[3] = max_y + 80.0;
    out_max_depth[0] = max_depth;

    // Build contiguous per-layer CSR index sorted strictly by X for O(log K) hit-test & culling
    let num_layers = (max_depth as usize) + 1;
    for l in 0..num_layers {
        out_layer_len[l] = 0;
    }
    for i in 0..n {
        out_layer_len[depth[i] as usize] += 1;
    }
    let mut running = 0i32;
    let mut cursors = vec![0i32; num_layers];
    for l in 0..num_layers {
        out_layer_start[l] = running;
        cursors[l] = running;
        running += out_layer_len[l];
    }
    for &u in order.iter() {
        let l = depth[u] as usize;
        let pos = cursors[l] as usize;
        out_layer_order[pos] = u as i32;
        cursors[l] = (pos + 1) as i32;
    }
    for l in 0..num_layers {
        let s = out_layer_start[l] as usize;
        let len = out_layer_len[l] as usize;
        if len > 1 {
            out_layer_order[s..s + len].sort_unstable_by(|&a, &b| {
                cmp_f64(out_x[a as usize], out_x[b as usize])
            });
        }
    }
}

#[inline]
fn lower_bound_layer(layer: &[i32], xs: &[f64], target_x: f64) -> usize {
    layer.partition_point(|&idx| xs[idx as usize] < target_x)
}

#[no_mangle]
pub extern "C" fn hit_test_layers(
    n: usize,
    max_depth: i32,
    layer_start_ptr: *const i32,
    layer_len_ptr: *const i32,
    layer_order_ptr: *const i32,
    x_ptr: *const f64,
    wx: f64,
    wy: f64,
    hw: f64,
    hh: f64,
) -> i32 {
    if n == 0 || max_depth < 0 {
        return -1;
    }
    let depth = (-wy / LAYER_H).round() as i32;
    if depth < 0 || depth > max_depth {
        return -1;
    }
    if (wy + (depth as f64) * LAYER_H).abs() > hh {
        return -1;
    }

    let num_layers = (max_depth as usize) + 1;
    let layer_start = unsafe { slice::from_raw_parts(layer_start_ptr, num_layers) };
    let layer_len = unsafe { slice::from_raw_parts(layer_len_ptr, num_layers) };
    let layer_order = unsafe { slice::from_raw_parts(layer_order_ptr, n) };
    let xs = unsafe { slice::from_raw_parts(x_ptr, n) };

    let d = depth as usize;
    let s = layer_start[d] as usize;
    let len = layer_len[d] as usize;
    if len == 0 {
        return -1;
    }
    let layer = &layer_order[s..s + len];
    let pos = lower_bound_layer(layer, xs, wx - hw);
    if pos < len {
        let cand = layer[pos];
        let cx = xs[cand as usize];
        if wx >= cx - hw && wx <= cx + hw {
            return cand;
        }
    }
    -1
}

/// Writes visible node indices (in layer order) and visible edge child indices
/// within the viewport rectangle, using O(log K) per-layer binary search.
#[no_mangle]
pub extern "C" fn cull_visible_layers(
    n: usize,
    max_depth: i32,
    layer_start_ptr: *const i32,
    layer_len_ptr: *const i32,
    layer_order_ptr: *const i32,
    parent_ptr: *const i32,
    x_ptr: *const f64,
    view_min_x: f64,
    view_max_x: f64,
    min_layer_in: i32,
    max_layer_in: i32,
    hw: f64,
    out_vis_nodes_ptr: *mut i32,
    out_vis_edges_ptr: *mut i32,
    out_counts_ptr: *mut i32,
) {
    let out_counts = unsafe { slice::from_raw_parts_mut(out_counts_ptr, 2) };
    out_counts[0] = 0;
    out_counts[1] = 0;
    if n == 0 || max_depth < 0 {
        return;
    }

    let min_l = min_layer_in.max(0);
    let max_l = max_layer_in.min(max_depth);
    if min_l > max_l {
        return;
    }

    let num_layers = (max_depth as usize) + 1;
    let layer_start = unsafe { slice::from_raw_parts(layer_start_ptr, num_layers) };
    let layer_len = unsafe { slice::from_raw_parts(layer_len_ptr, num_layers) };
    let layer_order = unsafe { slice::from_raw_parts(layer_order_ptr, n) };
    let parents = unsafe { slice::from_raw_parts(parent_ptr, n) };
    let xs = unsafe { slice::from_raw_parts(x_ptr, n) };
    let out_nodes = unsafe { slice::from_raw_parts_mut(out_vis_nodes_ptr, n) };
    let out_edges = unsafe { slice::from_raw_parts_mut(out_vis_edges_ptr, n) };

    let mut vn = 0usize;
    let mut ve = 0usize;
    let search_left = view_min_x - hw;

    for l in (min_l as usize)..=(max_l as usize) {
        let s = layer_start[l] as usize;
        let len = layer_len[l] as usize;
        if len == 0 {
            continue;
        }
        let layer = &layer_order[s..s + len];

        // Edges into this layer (child on layer l -> parent on layer l-1)
        if l > 0 {
            for &c_i in layer.iter() {
                let c = c_i as usize;
                let p = parents[c];
                if p < 0 {
                    continue;
                }
                let cx = xs[c];
                let px = xs[p as usize];
                let min_ex = if cx < px { cx } else { px };
                let max_ex = if cx > px { cx } else { px };
                if max_ex >= view_min_x && min_ex <= view_max_x {
                    out_edges[ve] = c_i;
                    ve += 1;
                }
            }
        }

        // Visible nodes via binary search on X
        let start_idx = lower_bound_layer(layer, xs, search_left);
        for &node_i in &layer[start_idx..] {
            if xs[node_i as usize] - hw > view_max_x {
                break;
            }
            out_nodes[vn] = node_i;
            vn += 1;
        }
    }

    out_counts[0] = vn as i32;
    out_counts[1] = ve as i32;
}

#[inline]
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[inline]
fn normalize_term<'a>(mut term: &'a [u8]) -> &'a [u8] {
    if let Some(pos) = find_subslice(term, b"projects/") {
        let rest = &term[pos + 9..];
        let end = rest.iter().position(|b| !b.is_ascii_digit()).unwrap_or(rest.len());
        if end > 0 {
            return &rest[..end];
        }
    }
    while let Some(&b) = term.first() {
        if b == b'@' || b == b'#' {
            term = &term[1..];
        } else {
            break;
        }
    }
    term
}

/// High-speed byte-arena search across all tree nodes inside WASM memory.
#[no_mangle]
pub extern "C" fn search_nodes(
    n: usize,
    depth_ptr: *const i32,
    arena_ptr: *const u8,
    arena_len: usize,
    id_off_ptr: *const i32,
    id_len_ptr: *const i32,
    title_off_ptr: *const i32,
    title_len_ptr: *const i32,
    author_off_ptr: *const i32,
    author_len_ptr: *const i32,
    query_ptr: *const u8,
    query_len: usize,
    max_results: usize,
    out_indices_ptr: *mut i32,
    out_scores_ptr: *mut i32,
    out_total_matches_ptr: *mut i32,
) -> usize {
    let out_total = unsafe { slice::from_raw_parts_mut(out_total_matches_ptr, 1) };
    out_total[0] = 0;
    if n == 0 || query_len == 0 || max_results == 0 {
        return 0;
    }

    let depth = unsafe { slice::from_raw_parts(depth_ptr, n) };
    let arena = unsafe { slice::from_raw_parts(arena_ptr, arena_len) };
    let id_off = unsafe { slice::from_raw_parts(id_off_ptr, n) };
    let id_len = unsafe { slice::from_raw_parts(id_len_ptr, n) };
    let title_off = unsafe { slice::from_raw_parts(title_off_ptr, n) };
    let title_len = unsafe { slice::from_raw_parts(title_len_ptr, n) };
    let author_off = unsafe { slice::from_raw_parts(author_off_ptr, n) };
    let author_len = unsafe { slice::from_raw_parts(author_len_ptr, n) };
    let query_bytes = unsafe { slice::from_raw_parts(query_ptr, query_len) };

    // Split lowercase query on ASCII whitespace into normalized terms
    let mut terms: Vec<&[u8]> = Vec::with_capacity(4);
    for raw_term in query_bytes.split(|b| b.is_ascii_whitespace()) {
        if raw_term.is_empty() {
            continue;
        }
        let norm = normalize_term(raw_term);
        if !norm.is_empty() {
            terms.push(norm);
        }
    }
    if terms.is_empty() {
        return 0;
    }

    let mut matches: Vec<(i32, i32, usize)> = Vec::new(); // (score, depth, node_idx)

    for i in 0..n {
        let id_s = &arena[id_off[i] as usize..(id_off[i] + id_len[i]) as usize];
        let title_s = &arena[title_off[i] as usize..(title_off[i] + title_len[i]) as usize];
        let author_s = &arena[author_off[i] as usize..(author_off[i] + author_len[i]) as usize];

        let mut all_match = true;
        let mut score: i32 = 0;

        for &term in &terms {
            let in_id = find_subslice(id_s, term);
            let in_title = find_subslice(title_s, term);
            let in_author = find_subslice(author_s, term);

            if in_id.is_none() && in_title.is_none() && in_author.is_none() {
                all_match = false;
                break;
            }

            if id_s == term {
                score += 200;
            } else if title_s == term || author_s == term {
                score += 100;
            } else if in_id == Some(0) {
                score += 60;
            } else if in_title == Some(0) || in_author == Some(0) {
                score += 40;
            } else {
                score += 10;
            }
        }

        if all_match {
            matches.push((score, depth[i], i));
        }
    }

    let total = matches.len();
    out_total[0] = total as i32;
    if total == 0 {
        return 0;
    }

    matches.sort_unstable_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)).then_with(|| a.2.cmp(&b.2)));

    let count = total.min(max_results);
    let out_indices = unsafe { slice::from_raw_parts_mut(out_indices_ptr, max_results) };
    let out_scores = unsafe { slice::from_raw_parts_mut(out_scores_ptr, max_results) };

    for k in 0..count {
        out_indices[k] = matches[k].2 as i32;
        out_scores[k] = matches[k].0;
    }
    count
}
