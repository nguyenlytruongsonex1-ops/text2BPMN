#!/usr/bin/env python3
"""Translate Luồng text IR into BPMN 2.0 XML (model + DI).

The model writes this intermediate syntax only. This compiler — not the model —
emits interchange XML that bpmn.io, Camunda Modeler and draw.io can open.

    process "Tên quy trình"
    lane "Vai trò"
    start id "Nhãn" lane "Vai trò"
    end id "Nhãn"
    task id "Nhãn"
    user id "Nhãn"
    service id "Nhãn"
    xor id "Câu hỏi?"
    and id "Nhánh song song"
    or id "Một hoặc nhiều nhánh?"
    id -> id "Nhãn luồng"
"""

from __future__ import annotations

import html
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict

LANG = "vi"

MESSAGES = {
    "vi": {
        "default_process": "Quy trình",
        "shared_lane": "Chung",
        "missing_process": "Dòng {line}: thiếu process — đã mở một quy trình mặc định.",
        "bad_flow": "Dòng {line}: luồng không đọc được.",
        "self_flow": "Dòng {line}: bỏ qua luồng tự thân {src}.",
        "skipped": "Dòng {line}: bỏ qua «{raw}».",
        "no_process": 'Chưa có quy trình. Thêm một dòng process "Tên" và các bước.',
        "cap": "Chỉ giữ 40 bước đầu của quy trình.",
        "renamed": "Trùng id {raw_id} — đã đổi thành {final}.",
        "dup_drop": "Bỏ bước trùng id {raw_id}.",
        "fuzzy": "Dòng {line}: «{ref}» được nối với bước gần giống.",
        "missing_step": "Dòng {line}: không thấy bước {ref}.",
        "no_flows": "Không thấy luồng — đã nối tuần tự theo thứ tự khai báo.",
        "empty": "Bỏ qua quy trình trống «{name}».",
        "unlinked": "Bước «{label}» chưa được nối.",
        "no_end": "Nhánh không có điểm kết thúc sau «{label}» — đã tự thêm end.",
        "auto_end": "Kết thúc",
        "no_steps": "IR không có bước nào. Thêm start, task hoặc end.",
        "dup_ids": "Trùng id BPMN: {ids}",
        "bad_xml": "Không dựng được XML hợp lệ ({detail}).",
        "crash": "Lỗi dịch BPMN: {detail}",
    },
    "en": {
        "default_process": "Process",
        "shared_lane": "Shared",
        "missing_process": "Line {line}: missing process — opened a default process.",
        "bad_flow": "Line {line}: could not read the flow.",
        "self_flow": "Line {line}: skipped a flow from {src} to itself.",
        "skipped": "Line {line}: skipped «{raw}».",
        "no_process": 'No process yet. Add a process "Name" line and the steps.',
        "cap": "Kept only the first 40 steps.",
        "renamed": "Duplicate id {raw_id} — renamed to {final}.",
        "dup_drop": "Dropped a duplicate step {raw_id}.",
        "fuzzy": "Line {line}: «{ref}» was linked to a similar step.",
        "missing_step": "Line {line}: step {ref} was not found.",
        "no_flows": "No flows found — connected the steps in the order they were declared.",
        "empty": "Skipped empty process «{name}».",
        "unlinked": "Step «{label}» is not connected.",
        "no_end": "Branch after «{label}» has no end event — added one.",
        "auto_end": "End",
        "no_steps": "The IR has no steps. Add a start, task, or end.",
        "dup_ids": "Duplicate BPMN id: {ids}",
        "bad_xml": "Could not build valid XML ({detail}).",
        "crash": "BPMN translation failed: {detail}",
    },
}


def set_lang(lang: str) -> None:
    global LANG
    LANG = "en" if lang == "en" else "vi"


def say(key: str, **kw: object) -> str:
    return MESSAGES[LANG][key].format(**kw)


KIND_ALIAS = {
    "start": "start",
    "startevent": "start",
    "begin": "start",
    "end": "end",
    "endevent": "end",
    "terminate": "end",
    "task": "task",
    "activity": "task",
    "manual": "task",
    "usertask": "user",
    "user": "user",
    "human": "user",
    "servicetask": "service",
    "service": "service",
    "system": "service",
    "script": "service",
    "scripttask": "service",
    "xor": "xor",
    "exclusive": "xor",
    "exclusivegateway": "xor",
    "gateway": "xor",
    "and": "and",
    "parallel": "and",
    "parallelgateway": "and",
    "or": "or",
    "inclusive": "or",
    "inclusivegateway": "or",
}

BPMN_TAG = {
    "start": "startEvent",
    "end": "endEvent",
    "task": "task",
    "user": "userTask",
    "service": "serviceTask",
    "xor": "exclusiveGateway",
    "and": "parallelGateway",
    "or": "inclusiveGateway",
}

STEM = {
    "start": "StartEvent",
    "end": "EndEvent",
    "task": "Task",
    "user": "UserTask",
    "service": "ServiceTask",
    "xor": "Gateway",
    "and": "Gateway",
    "or": "Gateway",
}

NS = (
    'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" '
    'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" '
    'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" '
    'xmlns:di="http://www.omg.org/spec/DD/20100524/DI"'
)

COL_GAP = 80
ROW_GAP = 52
LANE_PAD_Y = 36
LEFT_PAD = 28
RIGHT_PAD = 56
HEADER = 30


def rint(n: float) -> int:
    return int(math.floor(n + 0.5))


def esc(value: str) -> str:
    return html.escape(value, quote=True)


def tokenize(source: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    i = 0
    n = len(source)
    while i < n:
        if source[i].isspace():
            i += 1
            continue
        if source[i] == '"':
            i += 1
            buf: list[str] = []
            while i < n:
                if source[i] == "\\" and i + 1 < n:
                    buf.append(source[i + 1])
                    i += 2
                    continue
                if source[i] == '"':
                    i += 1
                    break
                buf.append(source[i])
                i += 1
            tokens.append(("str", "".join(buf)))
            continue
        j = i
        while j < n and not source[j].isspace() and source[j] != '"':
            j += 1
        tokens.append(("word", source[i:j]))
        i = j
    return tokens


def edit_distance(left: str, right: str) -> int:
    if abs(len(left) - len(right)) > 2:
        return 3
    previous = list(range(len(right) + 1))
    for i, ca in enumerate(left, 1):
        current = [i]
        for j, cb in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def resolve_ref(token: str, used: dict[str, str]) -> tuple[str | None, bool]:
    if token in used:
        return used[token], False
    folded: dict[str, str] = {}
    ambiguous = False
    for raw, final in used.items():
        key = raw.lower()
        if key in folded and folded[key] != final:
            ambiguous = True
        else:
            folded[key] = final
    if not ambiguous and token.lower() in folded:
        return folded[token.lower()], True
    close = [final for raw, final in used.items() if edit_distance(token, raw) == 1]
    if len(close) == 1:
        return close[0], True
    return None, False


def sanitize_id(raw: str) -> str:
    cleaned = []
    for ch in raw.strip():
        if ("A" <= ch <= "Z") or ("a" <= ch <= "z") or ("0" <= ch <= "9") or ch == "_":
            cleaned.append(ch)
        else:
            cleaned.append("_")
    slug = "".join(cleaned).strip("_") or "n"
    if slug[0].isdigit():
        slug = "n_" + slug
    return slug


def node_size(kind: str, label: str) -> tuple[int, int]:
    if kind in ("start", "end"):
        return 36, 36
    if kind in ("xor", "and", "or"):
        return 50, 50
    width_px = max(1, len(label)) * 12 * 0.56
    width = rint(min(240, max(148, width_px + 36)))
    inner = max(40, width - 28)
    lines = max(1, math.ceil(width_px / inner))
    height = min(116, max(80, 64 + (lines - 1) * 18))
    return width, height


def is_flow(tokens: list[tuple[str, str]]) -> bool:
    for typ, value in tokens:
        if typ == "word" and ("->" in value or value == "→"):
            return True
    return False


def kv_after(tokens: list[tuple[str, str]], start: int) -> dict[str, str]:
    found: dict[str, str] = {}
    i = start
    while i < len(tokens):
        typ, value = tokens[i]
        if typ == "word" and value.lower() in ("lane", "lan") and i + 1 < len(tokens) and tokens[i + 1][0] == "str":
            found["lane"] = tokens[i + 1][1].strip()
            i += 2
            continue
        if typ == "word" and "=" in value:
            key, rest = value.split("=", 1)
            key = key.lower()
            if rest.startswith('"') and rest.endswith('"') and len(rest) >= 2:
                rest = rest[1:-1]
            if i + 1 < len(tokens) and tokens[i + 1][0] == "str" and rest == "":
                found[key] = tokens[i + 1][1].strip()
                i += 2
                continue
            if key in ("lane", "lan", "label"):
                found["lane" if key in ("lane", "lan") else "label"] = rest.strip().strip('"')
            i += 1
            continue
        i += 1
    return found


def parse_flow(tokens: list[tuple[str, str]]) -> tuple[str, str, str | None] | None:
    body = tokens
    if body and body[0][0] == "word" and body[0][1].lower() in ("flow", "luong", "edge"):
        body = body[1:]
    label = next((v for t, v in body if t == "str"), None)
    extras = kv_after(body, 0)
    if extras.get("label"):
        label = extras["label"]
    flat: list[str] = []
    for typ, value in body:
        if typ != "word":
            continue
        if value.lower().startswith("label=") or value.lower().startswith("lane="):
            continue
        if "->" in value and value != "->":
            left, right = value.split("->", 1)
            if left:
                flat.append(left)
            flat.append("->")
            if right:
                flat.append(right)
        else:
            flat.append(value)
    if "->" not in flat:
        return None
    index = flat.index("->")
    if index == 0 or index + 1 >= len(flat):
        return None
    src = flat[index - 1]
    dst = flat[index + 1]
    if label is None and index + 2 < len(flat):
        label = " ".join(flat[index + 2 :]).strip() or None
    if not src or not dst:
        return None
    return src, dst, label


def blank_process(name: str) -> dict:
    return {"name": name[:180] or say("default_process"), "lanes": [], "nodes": [], "flows": [], "warnings": []}


def header_name(raw: str, tokens: list[tuple[str, str]]) -> str:
    for typ, value in tokens:
        if typ == "str" and value.strip():
            return value.strip()[:180]
    parts = raw.strip().split(None, 1)
    if len(parts) == 2:
        return parts[1].lstrip(":").strip().strip('"')[:180] or say("default_process")
    return say("default_process")


def parse_ir(text: str) -> tuple[list[dict], str | None]:
    chunks: list[dict] = []
    current: dict | None = None
    implicit = False

    def ensure(lineno: int) -> dict:
        nonlocal current, implicit
        if current is None:
            current = blank_process(say("default_process"))
            current["warnings"].append(say("missing_process", line=lineno))
            chunks.append(current)
            implicit = True
        return current

    for lineno, line in enumerate(text.splitlines(), 1):
        raw = line.strip()
        if not raw or raw.startswith("#") or raw.startswith("//"):
            continue
        raw = raw.replace("→", "->").replace("⇒", "->").replace("➔", "->")
        tokens = tokenize(raw)
        if not tokens:
            continue
        head = tokens[0][1].lower() if tokens[0][0] == "word" else ""
        head = head.rstrip(":")

        if head in ("process", "quytrinh", "pool", "participant"):
            current = blank_process(header_name(raw, tokens))
            chunks.append(current)
            continue

        if head in ("lane", "lan", "role", "vaitro"):
            proc = ensure(lineno)
            name = header_name(raw, tokens)
            if name and name not in proc["lanes"]:
                proc["lanes"].append(name)
            continue

        if is_flow(tokens):
            proc = ensure(lineno)
            parsed = parse_flow(tokens)
            if not parsed:
                proc["warnings"].append(say("bad_flow", line=lineno))
                continue
            src, dst, label = parsed
            if src == dst:
                proc["warnings"].append(say("self_flow", line=lineno, src=src))
                continue
            proc["flows"].append(
                {"src": src, "dst": dst, "label": (label or "").strip()[:120] or None, "line": lineno}
            )
            continue

        kind = KIND_ALIAS.get(head)
        if not kind:
            proc = ensure(lineno)
            proc["warnings"].append(say("skipped", line=lineno, raw=raw[:72]))
            continue

        proc = ensure(lineno)
        nid = ""
        if len(tokens) > 1 and tokens[1][0] == "word" and tokens[1][1] not in ("lane", "lan"):
            nid = tokens[1][1]
        label = ""
        for typ, value in tokens[1:]:
            if typ == "str":
                label = value.strip()
                break
        if not label:
            words = []
            for typ, value in tokens[2:]:
                if typ != "word":
                    continue
                low = value.lower()
                if low in ("lane", "lan") or low.startswith("lane=") or low.startswith("label="):
                    break
                words.append(value)
            label = " ".join(words).strip()
        meta = kv_after(tokens, 2 if nid else 1)
        lane = meta.get("lane") or None
        if not nid:
            nid = f"n{len(proc['nodes']) + 1}"
        proc["nodes"].append(
            {
                "raw_id": nid,
                "kind": kind,
                "label": (label or nid)[:180],
                "lane": lane[:120] if lane else None,
                "line": lineno,
            }
        )

    if not chunks:
        return [], say("no_process")

    processes = []
    for proc in chunks:
        used: dict[str, str] = {}
        taken: set[str] = set()
        nodes = []
        if len(proc["nodes"]) > 40:
            proc["warnings"].append(say("cap"))
            proc["nodes"] = proc["nodes"][:40]
        for node in proc["nodes"]:
            base = sanitize_id(node["raw_id"])
            final = base
            n = 2
            while final in taken:
                final = f"{base}_{n}"
                n += 1
            if node["raw_id"] in used and used[node["raw_id"]] != final:
                proc["warnings"].append(say("renamed", raw_id=node["raw_id"], final=final))
            elif node["raw_id"] in used:
                proc["warnings"].append(say("dup_drop", raw_id=node["raw_id"]))
                continue
            used[node["raw_id"]] = final
            taken.add(final)
            node = dict(node)
            node["id"] = final
            nodes.append(node)
        flows = []
        seen_flow = set()
        for flow in proc["flows"]:
            src, src_fuzzy = resolve_ref(flow["src"], used)
            dst, dst_fuzzy = resolve_ref(flow["dst"], used)
            if src_fuzzy:
                proc["warnings"].append(say("fuzzy", line=flow["line"], ref=flow["src"]))
            if dst_fuzzy:
                proc["warnings"].append(say("fuzzy", line=flow["line"], ref=flow["dst"]))
            if not src or not dst:
                missing = flow["src"] if not src else flow["dst"]
                proc["warnings"].append(say("missing_step", line=flow["line"], ref=missing))
                continue
            key = (src, dst, flow["label"] or "")
            if key in seen_flow:
                continue
            seen_flow.add(key)
            flows.append({"src": src, "dst": dst, "label": flow["label"]})
        if nodes and not flows:
            proc["warnings"].append(say("no_flows"))
            for left, right in zip(nodes, nodes[1:]):
                flows.append({"src": left["id"], "dst": right["id"], "label": None})
        keep = {n["id"] for n in nodes}
        flows = [f for f in flows if f["src"] in keep and f["dst"] in keep]
        # Safety net: every branch must finish at an end event.
        for node in list(nodes):
            if node["kind"] == "end" or any(f["src"] == node["id"] for f in flows):
                continue
            if not any(f["dst"] == node["id"] for f in flows):
                continue
            end_id = "end_" + node["id"]
            while end_id in keep:
                end_id += "_"
            keep.add(end_id)
            nodes.append({"id": end_id, "kind": "end", "label": say("auto_end"), "lane": node["lane"]})
            flows.append({"src": node["id"], "dst": end_id, "label": None})
            proc["warnings"].append(say("no_end", label=node["label"]))
        if not nodes:
            proc["warnings"].append(say("empty", name=proc["name"]))
            continue
        lane_names = list(proc["lanes"])
        for node in nodes:
            if node["lane"] and node["lane"] not in lane_names:
                lane_names.append(node["lane"])
        if lane_names and any(node["lane"] is None for node in nodes):
            shared = say("shared_lane")
            if shared not in lane_names:
                lane_names.insert(0, shared)
            for node in nodes:
                if node["lane"] is None:
                    node["lane"] = shared
        processes.append(
            {
                "name": proc["name"],
                "lanes": lane_names,
                "nodes": nodes,
                "flows": flows,
                "warnings": proc["warnings"],
            }
        )

    if not processes:
        return [], say("no_steps")
    return processes, None


def assign_ranks(ids: list[str], flows: list[dict]) -> dict[str, int]:
    idset = set(ids)
    outgoing: dict[str, list[str]] = {i: [] for i in ids}
    seen = set()
    for flow in flows:
        key = (flow["src"], flow["dst"])
        if key in seen or flow["src"] not in idset or flow["dst"] not in idset:
            continue
        if flow["src"] == flow["dst"]:
            continue
        seen.add(key)
        outgoing[flow["src"]].append(flow["dst"])
    color = {i: 0 for i in ids}
    back: set[tuple[str, str]] = set()

    def dfs(node: str) -> None:
        color[node] = 1
        for nxt in outgoing[node]:
            state = color[nxt]
            if state == 0:
                dfs(nxt)
            elif state == 1:
                back.add((node, nxt))
        color[node] = 2

    for node in ids:
        if color[node] == 0:
            dfs(node)

    succ: dict[str, list[str]] = {i: [] for i in ids}
    indeg = {i: 0 for i in ids}
    for src in ids:
        for dst in outgoing[src]:
            if (src, dst) in back:
                continue
            succ[src].append(dst)
            indeg[dst] += 1
    order = {node: index for index, node in enumerate(ids)}
    queue = sorted([node for node in ids if indeg[node] == 0], key=lambda n: order[n])
    topo: list[str] = []
    while queue:
        current = queue.pop(0)
        topo.append(current)
        for nxt in succ[current]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                queue.append(nxt)
        queue.sort(key=lambda n: order[n])
    seen_topo = set(topo)
    for node in ids:
        if node not in seen_topo:
            topo.append(node)
    rank = {node: 0 for node in ids}
    for src in topo:
        for dst in succ[src]:
            if rank[src] + 1 > rank[dst]:
                rank[dst] = rank[src] + 1
    return rank


def order_columns(ids: list[str], flows: list[dict], rank: dict[str, int]) -> dict[int, list[str]]:
    columns: dict[int, list[str]] = defaultdict(list)
    for node in ids:
        columns[rank[node]].append(node)
    order = {node: index for index, node in enumerate(ids)}
    pred: dict[str, list[str]] = defaultdict(list)
    succ: dict[str, list[str]] = defaultdict(list)
    for flow in flows:
        pred[flow["dst"]].append(flow["src"])
        succ[flow["src"]].append(flow["dst"])

    def position_map() -> dict[str, int]:
        placed: dict[str, int] = {}
        for grouped in columns.values():
            for index, node in enumerate(grouped):
                placed[node] = index
        return placed

    def bary(node: str, links: list[str], placed: dict[str, int]) -> tuple[float, int]:
        values = [placed[item] for item in links if item in placed]
        if not values:
            return (float(order[node]), order[node])
        return (sum(values) / len(values), order[node])

    for _ in range(4):
        placed = position_map()
        for key in sorted(columns):
            columns[key].sort(key=lambda node: bary(node, pred[node], placed))
        placed = position_map()
        for key in sorted(columns, reverse=True):
            columns[key].sort(key=lambda node: bary(node, succ[node], placed))
    return columns


def dedupe_points(points: list[tuple[float, float]]) -> list[tuple[int, int]]:
    cleaned: list[tuple[int, int]] = []
    for x, y in points:
        point = (rint(x), rint(y))
        if not cleaned or cleaned[-1] != point:
            cleaned.append(point)
    if len(cleaned) == 1:
        cleaned.append((cleaned[0][0] + 16, cleaned[0][1]))
    return cleaned


def compile_process(proc: dict, prefix: str) -> dict:
    nodes = proc["nodes"]
    flows = proc["flows"]
    by_id = {node["id"]: node for node in nodes}
    ids = [node["id"] for node in nodes]
    rank = assign_ranks(ids, flows)
    columns = order_columns(ids, flows, rank)
    ranks = sorted(columns)
    col_width: dict[int, int] = {}
    for key in ranks:
        col_width[key] = max(node_size(by_id[node]["kind"], by_id[node]["label"])[0] for node in columns[key])
    x_of: dict[int, int] = {}
    cursor = LEFT_PAD
    for key in ranks:
        x_of[key] = cursor
        cursor += col_width[key] + COL_GAP
    content_w = max(180, (cursor - COL_GAP) if ranks else 180)

    use_lanes = bool(proc["lanes"])
    if use_lanes:
        bands = [(name, [node for node in nodes if node["lane"] == name]) for name in proc["lanes"]]
    else:
        bands = [("", nodes)]

    bounds: dict[str, list[float]] = {}
    lane_boxes: list[dict] = []
    y_cursor = 0.0
    for lane_name, lane_nodes in bands:
        present = {node["id"] for node in lane_nodes}
        stacks: list[tuple[int, list[dict]]] = []
        heights: list[float] = []
        for key in ranks:
            group = [by_id[node] for node in columns[key] if node in present]
            stacks.append((key, group))
            if not group:
                heights.append(0)
                continue
            height = sum(node_size(node["kind"], node["label"])[1] for node in group)
            height += ROW_GAP * (len(group) - 1)
            heights.append(height)
        content_h = max([h for h in heights if h > 0] or [80])
        band_h = content_h + LANE_PAD_Y * 2
        for key, group in stacks:
            if not group:
                continue
            stack_h = sum(node_size(node["kind"], node["label"])[1] for node in group)
            stack_h += ROW_GAP * (len(group) - 1)
            cy = y_cursor + LANE_PAD_Y + (content_h - stack_h) / 2
            for node in group:
                width, height = node_size(node["kind"], node["label"])
                nx = x_of[key] + (col_width[key] - width) / 2
                bounds[node["id"]] = [nx, cy, float(width), float(height)]
                cy += height + ROW_GAP
        lane_boxes.append({"name": lane_name, "y": y_cursor, "h": band_h})
        y_cursor += band_h
    local_h = y_cursor

    pool_header = HEADER if use_lanes else 0
    lane_header = HEADER if use_lanes else 0
    origin_x = 56 + pool_header + lane_header
    origin_y = 48
    for box in bounds.values():
        box[0] += origin_x
        box[1] += origin_y

    pair_total: dict[tuple[str, str], int] = defaultdict(int)
    for flow in flows:
        pair_total[(flow["src"], flow["dst"])] += 1
    pair_seen: dict[tuple[str, str], int] = defaultdict(int)

    routed: list[tuple[dict, list[tuple[int, int]]]] = []
    deferred: list[tuple[dict, int]] = []
    for flow in flows:
        key = (flow["src"], flow["dst"])
        slot = pair_seen[key]
        pair_seen[key] += 1
        center = (pair_total[key] - 1) / 2
        shift = rint((slot - center) * 12)
        src_box = bounds[flow["src"]]
        dst_box = bounds[flow["dst"]]
        delta = rank[flow["dst"]] - rank[flow["src"]]
        sx = src_box[0] + src_box[2]
        sy = src_box[1] + src_box[3] / 2
        tx = dst_box[0]
        ty = dst_box[1] + dst_box[3] / 2
        if delta == 1 and tx > sx + 12:
            elbow = tx - 28 - shift
            if elbow < sx + 18:
                elbow = (sx + tx) / 2
            routed.append((flow, dedupe_points([(sx, sy), (elbow, sy), (elbow, ty), (tx, ty)])))
        else:
            deferred.append((flow, shift))

    extra = 0
    if deferred:
        extra = 20 + len(deferred) * 18 + 16
    base_bottom = origin_y + local_h
    for index, (flow, shift) in enumerate(deferred):
        src_box = bounds[flow["src"]]
        dst_box = bounds[flow["dst"]]
        sx = src_box[0] + src_box[2]
        sy = src_box[1] + src_box[3] / 2
        tx = dst_box[0]
        ty = dst_box[1] + dst_box[3] / 2
        channel = base_bottom + 18 + index * 18
        out_x = sx + 24 + max(0, shift)
        in_x = tx - 24 + min(0, shift)
        routed.append(
            (
                flow,
                dedupe_points([(sx, sy), (out_x, sy), (out_x, channel), (in_x, channel), (in_x, ty), (tx, ty)]),
            )
        )

    if use_lanes:
        px, py = 56, 48
        pw = pool_header + lane_header + content_w + RIGHT_PAD
        ph = local_h + extra
        if lane_boxes:
            lane_boxes[-1]["h"] += extra
        participant = {
            "x": px,
            "y": py,
            "w": rint(pw),
            "h": rint(ph),
        }
        for lane in lane_boxes:
            lane["x"] = px + pool_header
            lane["y"] = py + lane["y"]
            lane["w"] = rint(pw - pool_header)
            lane["h"] = rint(lane["h"])
    else:
        participant = None

    warnings = list(proc["warnings"])
    connected = set()
    for flow in flows:
        connected.add(flow["src"])
        connected.add(flow["dst"])
    for node in nodes:
        if node["id"] not in connected and len(nodes) > 1:
            warnings.append(say("unlinked", label=node["label"]))

    xml_parts = render_xml(
        proc=proc,
        prefix=prefix,
        bounds={key: [rint(v[0]), rint(v[1]), rint(v[2]), rint(v[3])] for key, v in bounds.items()},
        routed=routed,
        participant=participant,
        lane_boxes=lane_boxes if use_lanes else [],
        use_lanes=use_lanes,
    )
    return {"name": proc["name"], "warnings": warnings, "parts": xml_parts}


def label_box(text: str, anchor_x: float, anchor_y: float, anchor_w: float, anchor_h: float) -> tuple[int, int, int, int]:
    width = rint(min(160, max(28, len(text) * 6.4)))
    x = rint(anchor_x + anchor_w / 2 - width / 2)
    y = rint(anchor_y + anchor_h + 4)
    return x, y, width, 14


def flow_label_box(text: str, points: list[tuple[int, int]]) -> tuple[int, int, int, int]:
    width = rint(min(140, max(24, len(text) * 6.4)))
    best = 0.0
    mx, my = points[0]
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        length = math.hypot(x2 - x1, y2 - y1)
        if length >= best:
            best = length
            mx = (x1 + x2) / 2
            my = (y1 + y2) / 2
    return rint(mx - width / 2), rint(my - 18), width, 14


def render_xml(
    proc: dict,
    prefix: str,
    bounds: dict[str, list[int]],
    routed: list[tuple[dict, list[tuple[int, int]]]],
    participant: dict | None,
    lane_boxes: list[dict],
    use_lanes: bool,
) -> dict[str, str]:
    p = prefix
    process_id = f"{p}Process_1"
    collab_id = f"{p}Collaboration_1"
    participant_id = f"{p}Participant_1"
    plane_id = f"{p}BPMNPlane_1"
    diagram_id = f"{p}BPMNDiagram_1"
    bpmn_of = {node["id"]: f"{p}{STEM[node['kind']]}_{node['id']}" for node in proc["nodes"]}

    incoming: dict[str, list[str]] = defaultdict(list)
    outgoing: dict[str, list[str]] = defaultdict(list)
    flow_ids: list[str] = []
    for index, (flow, _points) in enumerate(routed, 1):
        fid = f"{p}Flow_{index}"
        flow_ids.append(fid)
        outgoing[flow["src"]].append(fid)
        incoming[flow["dst"]].append(fid)

    collab_xml = ""
    if use_lanes and participant:
        collab_xml = (
            f'  <bpmn:collaboration id="{collab_id}" name="{esc(proc["name"])}">\n'
            f'    <bpmn:participant id="{participant_id}" name="{esc(proc["name"])}" processRef="{process_id}" />\n'
            f"  </bpmn:collaboration>"
        )

    lines = [f'  <bpmn:process id="{process_id}" name="{esc(proc["name"])}" isExecutable="false">']
    if use_lanes and lane_boxes:
        lines.append(f'    <bpmn:laneSet id="{p}LaneSet_1">')
        groups: dict[str, list[str]] = defaultdict(list)
        for node in proc["nodes"]:
            groups[node["lane"]].append(bpmn_of[node["id"]])
        for index, lane in enumerate(lane_boxes, 1):
            lines.append(f'      <bpmn:lane id="{p}Lane_{index}" name="{esc(lane["name"])}">')
            for ref in groups.get(lane["name"], []):
                lines.append(f"        <bpmn:flowNodeRef>{ref}</bpmn:flowNodeRef>")
            lines.append("      </bpmn:lane>")
        lines.append("    </bpmn:laneSet>")

    for node in proc["nodes"]:
        tag = BPMN_TAG[node["kind"]]
        bid = bpmn_of[node["id"]]
        lines.append(f'    <bpmn:{tag} id="{bid}" name="{esc(node["label"])}">')
        for fid in incoming.get(node["id"], []):
            lines.append(f"      <bpmn:incoming>{fid}</bpmn:incoming>")
        for fid in outgoing.get(node["id"], []):
            lines.append(f"      <bpmn:outgoing>{fid}</bpmn:outgoing>")
        lines.append(f"    </bpmn:{tag}>")

    for (flow, _points), fid in zip(routed, flow_ids):
        name = f' name="{esc(flow["label"])}"' if flow["label"] else ""
        lines.append(
            f'    <bpmn:sequenceFlow id="{fid}" sourceRef="{bpmn_of[flow["src"]]}" targetRef="{bpmn_of[flow["dst"]]}"{name} />'
        )
    lines.append("  </bpmn:process>")

    shapes: list[str] = []
    if participant:
        shapes.append(
            f'      <bpmndi:BPMNShape id="{participant_id}_di" bpmnElement="{participant_id}" isHorizontal="true">\n'
            f'        <dc:Bounds x="{participant["x"]}" y="{participant["y"]}" width="{participant["w"]}" height="{participant["h"]}" />\n'
            f"      </bpmndi:BPMNShape>"
        )
        for index, lane in enumerate(lane_boxes, 1):
            lid = f"{p}Lane_{index}"
            shapes.append(
                f'      <bpmndi:BPMNShape id="{lid}_di" bpmnElement="{lid}" isHorizontal="true">\n'
                f'        <dc:Bounds x="{lane["x"]}" y="{rint(lane["y"])}" width="{lane["w"]}" height="{lane["h"]}" />\n'
                f"      </bpmndi:BPMNShape>"
            )
    for node in proc["nodes"]:
        bid = bpmn_of[node["id"]]
        x, y, w, h = bounds[node["id"]]
        label_xml = ""
        if node["kind"] in ("start", "end", "xor", "and", "or") and node["label"]:
            lx, ly, lw, lh = label_box(node["label"], x, y, w, h)
            label_xml = (
                f"\n        <bpmndi:BPMNLabel>\n"
                f'          <dc:Bounds x="{lx}" y="{ly}" width="{lw}" height="{lh}" />\n'
                f"        </bpmndi:BPMNLabel>"
            )
        shapes.append(
            f'      <bpmndi:BPMNShape id="{bid}_di" bpmnElement="{bid}">\n'
            f'        <dc:Bounds x="{x}" y="{y}" width="{w}" height="{h}" />'
            f"{label_xml}\n"
            f"      </bpmndi:BPMNShape>"
        )
    edges: list[str] = []
    for (flow, points), fid in zip(routed, flow_ids):
        waypoints = "\n".join(f'        <di:waypoint x="{x}" y="{y}" />' for x, y in points)
        label_xml = ""
        if flow["label"]:
            lx, ly, lw, lh = flow_label_box(flow["label"], points)
            label_xml = (
                f"\n        <bpmndi:BPMNLabel>\n"
                f'          <dc:Bounds x="{lx}" y="{ly}" width="{lw}" height="{lh}" />\n'
                f"        </bpmndi:BPMNLabel>"
            )
        edges.append(
            f'      <bpmndi:BPMNEdge id="{fid}_di" bpmnElement="{fid}">\n'
            f"{waypoints}{label_xml}\n"
            f"      </bpmndi:BPMNEdge>"
        )
    plane_element = collab_id if use_lanes else process_id
    diagram = (
        f'  <bpmndi:BPMNDiagram id="{diagram_id}">\n'
        f'    <bpmndi:BPMNPlane id="{plane_id}" bpmnElement="{plane_element}">\n'
        + "\n".join(shapes + edges)
        + "\n    </bpmndi:BPMNPlane>\n"
        f"  </bpmndi:BPMNDiagram>"
    )
    return {"collaboration": collab_xml, "process": "\n".join(lines), "diagram": diagram}


def wrap(body: list[str]) -> str:
    inner = "\n".join(part for part in body if part)
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f"<bpmn:definitions {NS} id=\"Definitions_1\" "
        'targetNamespace="http://text2bpmn.app/bpmn" exporter="text2BPMN" exporterVersion="1.0">\n'
        f"{inner}\n"
        "</bpmn:definitions>\n"
    )
    ET.fromstring(xml)
    ids = re.findall(r'\bid="([^"]+)"', xml)
    if len(ids) != len(set(ids)):
        dupes = sorted({item for item in ids if ids.count(item) > 1})
        raise ValueError(say("dup_ids", ids=", ".join(dupes[:6])))
    return xml


def translate(text: str, lang: str = "vi") -> dict:
    set_lang(lang)
    processes, error = parse_ir(text or "")
    if error:
        return {"ok": False, "error": error}
    compiled = []
    try:
        for index, proc in enumerate(processes, 1):
            compiled.append(compile_process(proc, f"P{index}_"))
        diagrams = []
        for item in compiled:
            parts = item["parts"]
            xml = wrap([parts["collaboration"], parts["process"], parts["diagram"]])
            diagrams.append({"name": item["name"], "xml": xml, "warnings": item["warnings"]})
        combined_parts: list[str] = []
        for item in compiled:
            combined_parts.append(item["parts"]["collaboration"])
            combined_parts.append(item["parts"]["process"])
        for item in compiled:
            combined_parts.append(item["parts"]["diagram"])
        combined = wrap(combined_parts)
    except (ET.ParseError, ValueError) as exc:
        return {"ok": False, "error": say("bad_xml", detail=exc)}
    return {"ok": True, "diagrams": diagrams, "combinedXml": combined}


def main() -> None:
    set_lang(os.environ.get("LUONG_LANG", "vi"))
    raw = sys.stdin.read()
    try:
        result = translate(raw, LANG)
    except Exception as exc:  # noqa: BLE001 — surface a JSON error to the caller
        result = {"ok": False, "error": say("crash", detail=exc)}
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
