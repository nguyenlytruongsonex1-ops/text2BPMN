import type { Lang } from "./lang";

/** JavaScript port of ir_to_bpmn.py. Python is preferred at runtime; this runs when Python cannot. */

export type DiagramFile = {
  name: string;
  xml: string;
  warnings: string[];
};

export type TranslateResult =
  | { ok: true; diagrams: DiagramFile[]; combinedXml: string }
  | { ok: false; error: string };

type Kind = "start" | "end" | "task" | "user" | "service" | "xor" | "and" | "or";
type Token = { t: "word" | "str"; v: string };
type Flow = { src: string; dst: string; label: string | null; line?: number };
type Node = { id: string; kind: Kind; label: string; lane: string | null };
type Proc = { name: string; lanes: string[]; nodes: Node[]; flows: Flow[]; warnings: string[] };
type Box = { x: number; y: number; w: number; h: number };
type LaneBox = { name: string; x: number; y: number; w: number; h: number };

const KIND_ALIAS: Record<string, Kind> = {
  start: "start",
  startevent: "start",
  begin: "start",
  end: "end",
  endevent: "end",
  terminate: "end",
  task: "task",
  activity: "task",
  manual: "task",
  usertask: "user",
  user: "user",
  human: "user",
  servicetask: "service",
  service: "service",
  system: "service",
  script: "service",
  scripttask: "service",
  xor: "xor",
  exclusive: "xor",
  exclusivegateway: "xor",
  gateway: "xor",
  and: "and",
  parallel: "and",
  parallelgateway: "and",
  or: "or",
  inclusive: "or",
  inclusivegateway: "or",
};

const BPMN_TAG: Record<Kind, string> = {
  start: "startEvent",
  end: "endEvent",
  task: "task",
  user: "userTask",
  service: "serviceTask",
  xor: "exclusiveGateway",
  and: "parallelGateway",
  or: "inclusiveGateway",
};

const STEM: Record<Kind, string> = {
  start: "StartEvent",
  end: "EndEvent",
  task: "Task",
  user: "UserTask",
  service: "ServiceTask",
  xor: "Gateway",
  and: "Gateway",
  or: "Gateway",
};

const NS =
  'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" ' +
  'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" ' +
  'xmlns:di="http://www.omg.org/spec/DD/20100524/DI"';

const COL_GAP = 80;
const ROW_GAP = 52;
const LANE_PAD_Y = 36;
const LEFT_PAD = 28;
const RIGHT_PAD = 56;
const HEADER = 30;

function rint(n: number): number {
  return Math.floor(n + 0.5);
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&" + "amp;")
    .replace(/</g, "&" + "lt;")
    .replace(/>/g, "&" + "gt;")
    .replace(/"/g, "&" + "quot;")
    .replace(/'/g, "&" + "#x27;");
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    if (/\s/.test(source[i] ?? "")) {
      i += 1;
      continue;
    }
    if (source[i] === '"') {
      i += 1;
      let buf = "";
      while (i < n) {
        if (source[i] === "\\" && i + 1 < n) {
          buf += source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          i += 1;
          break;
        }
        buf += source[i];
        i += 1;
      }
      tokens.push({ t: "str", v: buf });
      continue;
    }
    let j = i;
    while (j < n && !/\s/.test(source[j] ?? "") && source[j] !== '"') j += 1;
    tokens.push({ t: "word", v: source.slice(i, j) });
    i = j;
  }
  return tokens;
}

function editDistance(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 2) return 3;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j += 1) {
      current.push(
        Math.min(current[current.length - 1]! + 1, previous[j + 1]! + 1, previous[j]! + (left[i] === right[j] ? 0 : 1)),
      );
    }
    previous = current;
  }
  return previous[previous.length - 1] ?? 3;
}

function resolveRef(token: string, used: Map<string, string>): { id: string | null; fuzzy: boolean } {
  const exact = used.get(token);
  if (exact) return { id: exact, fuzzy: false };
  const folded = new Map<string, string>();
  let ambiguous = false;
  for (const [raw, finalId] of used) {
    const key = raw.toLowerCase();
    if (folded.has(key) && folded.get(key) !== finalId) ambiguous = true;
    else folded.set(key, finalId);
  }
  const foldedHit = folded.get(token.toLowerCase());
  if (!ambiguous && foldedHit) return { id: foldedHit, fuzzy: true };
  const close = [...used.entries()].filter(([raw]) => editDistance(token, raw) === 1).map(([, finalId]) => finalId);
  if (close.length === 1) return { id: close[0] ?? null, fuzzy: true };
  return { id: null, fuzzy: false };
}

function sanitizeId(raw: string): string {
  let slug = "";
  for (const ch of raw.trim()) {
    if (/[A-Za-z0-9_]/.test(ch)) slug += ch;
    else slug += "_";
  }
  slug = slug.replace(/^_+|_+$/g, "") || "n";
  if (/[0-9]/.test(slug[0] ?? "")) slug = "n_" + slug;
  return slug;
}

function nodeSize(kind: Kind, label: string): [number, number] {
  if (kind === "start" || kind === "end") return [36, 36];
  if (kind === "xor" || kind === "and" || kind === "or") return [50, 50];
  const widthPx = Math.max(1, label.length) * 12 * 0.56;
  const width = rint(Math.min(240, Math.max(148, widthPx + 36)));
  const inner = Math.max(40, width - 28);
  const lines = Math.max(1, Math.ceil(widthPx / inner));
  const height = Math.min(116, Math.max(80, 64 + (lines - 1) * 18));
  return [width, height];
}

function isFlow(tokens: Token[]): boolean {
  return tokens.some((token) => token.t === "word" && (token.v.includes("->") || token.v === "→"));
}

function kvAfter(tokens: Token[], start: number): Record<string, string> {
  const found: Record<string, string> = {};
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) break;
    if (
      token.t === "word" &&
      (token.v.toLowerCase() === "lane" || token.v.toLowerCase() === "lan") &&
      tokens[i + 1]?.t === "str"
    ) {
      found.lane = tokens[i + 1]!.v.trim();
      i += 2;
      continue;
    }
    if (token.t === "word" && token.v.includes("=")) {
      const eq = token.v.indexOf("=");
      const key = token.v.slice(0, eq).toLowerCase();
      let rest = token.v.slice(eq + 1);
      if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) rest = rest.slice(1, -1);
      if (tokens[i + 1]?.t === "str" && rest === "") {
        found[key] = tokens[i + 1]!.v.trim();
        i += 2;
        continue;
      }
      if (key === "lane" || key === "lan" || key === "label") {
        found[key === "label" ? "label" : "lane"] = rest.trim().replace(/^"|"$/g, "");
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return found;
}

function parseFlow(tokens: Token[]): { src: string; dst: string; label: string | null } | null {
  let body = tokens;
  if (body[0]?.t === "word" && ["flow", "luong", "edge"].includes(body[0].v.toLowerCase())) body = body.slice(1);
  let label = body.find((token) => token.t === "str")?.v ?? null;
  const extras = kvAfter(body, 0);
  if (extras.label) label = extras.label;
  const flat: string[] = [];
  for (const token of body) {
    if (token.t !== "word") continue;
    const low = token.v.toLowerCase();
    if (low.startsWith("label=") || low.startsWith("lane=")) continue;
    if (token.v.includes("->") && token.v !== "->") {
      const [left, right] = token.v.split("->");
      if (left) flat.push(left);
      flat.push("->");
      if (right) flat.push(right);
    } else flat.push(token.v);
  }
  const index = flat.indexOf("->");
  if (index <= 0 || index + 1 >= flat.length) return null;
  const src = flat[index - 1] ?? "";
  const dst = flat[index + 1] ?? "";
  if (label == null && index + 2 < flat.length) label = flat.slice(index + 2).join(" ").trim() || null;
  if (!src || !dst) return null;
  return { src, dst, label };
}

const TEXT = {
  vi: {
    defaultProcess: "Quy trình",
    sharedLane: "Chung",
    missingProcess: (line: number) => `Dòng ${line}: thiếu process — đã mở một quy trình mặc định.`,
    badFlow: (line: number) => `Dòng ${line}: luồng không đọc được.`,
    selfFlow: (line: number, src: string) => `Dòng ${line}: bỏ qua luồng tự thân ${src}.`,
    skipped: (line: number, raw: string) => `Dòng ${line}: bỏ qua «${raw}».`,
    noProcess: 'Chưa có quy trình. Thêm một dòng process "Tên" và các bước.',
    cap: "Chỉ giữ 40 bước đầu của quy trình.",
    renamed: (rawId: string, finalId: string) => `Trùng id ${rawId} — đã đổi thành ${finalId}.`,
    dupDrop: (rawId: string) => `Bỏ bước trùng id ${rawId}.`,
    fuzzy: (line: number | undefined, ref: string) => `Dòng ${line}: «${ref}» được nối với bước gần giống.`,
    missingStep: (line: number | undefined, ref: string) => `Dòng ${line}: không thấy bước ${ref}.`,
    noFlows: "Không thấy luồng — đã nối tuần tự theo thứ tự khai báo.",
    empty: (name: string) => `Bỏ qua quy trình trống «${name}».`,
    unlinked: (label: string) => `Bước «${label}» chưa được nối.`,
    noEnd: (label: string) => `Nhánh không có điểm kết thúc sau «${label}» — đã tự thêm end.`,
    autoEnd: "Kết thúc",
    noSteps: "IR không có bước nào. Thêm start, task hoặc end.",
    dupIds: (ids: string) => `Trùng id BPMN: ${ids}`,
    truncated: "XML cắt cụt",
    badXml: (detail: string) => `Không dựng được XML hợp lệ (${detail}).`,
  },
  en: {
    defaultProcess: "Process",
    sharedLane: "Shared",
    missingProcess: (line: number) => `Line ${line}: missing process — opened a default process.`,
    badFlow: (line: number) => `Line ${line}: could not read the flow.`,
    selfFlow: (line: number, src: string) => `Line ${line}: skipped a flow from ${src} to itself.`,
    skipped: (line: number, raw: string) => `Line ${line}: skipped «${raw}».`,
    noProcess: 'No process yet. Add a process "Name" line and the steps.',
    cap: "Kept only the first 40 steps.",
    renamed: (rawId: string, finalId: string) => `Duplicate id ${rawId} — renamed to ${finalId}.`,
    dupDrop: (rawId: string) => `Dropped a duplicate step ${rawId}.`,
    fuzzy: (line: number | undefined, ref: string) => `Line ${line}: «${ref}» was linked to a similar step.`,
    missingStep: (line: number | undefined, ref: string) => `Line ${line}: step ${ref} was not found.`,
    noFlows: "No flows found — connected the steps in the order they were declared.",
    empty: (name: string) => `Skipped empty process «${name}».`,
    unlinked: (label: string) => `Step «${label}» is not connected.`,
    noEnd: (label: string) => `Branch after «${label}» has no end event — added one.`,
    autoEnd: "End",
    noSteps: "The IR has no steps. Add a start, task, or end.",
    dupIds: (ids: string) => `Duplicate BPMN id: ${ids}`,
    truncated: "Truncated XML",
    badXml: (detail: string) => `Could not build valid XML (${detail}).`,
  },
} as const;

function textOf(lang: Lang) {
  return lang === "en" ? TEXT.en : TEXT.vi;
}

function headerName(raw: string, tokens: Token[], lang: Lang): string {
  const quoted = tokens.find((token) => token.t === "str" && token.v.trim());
  if (quoted) return quoted.v.trim().slice(0, 180);
  const parts = raw.trim().split(/\s+/);
  if (parts.length >= 2) {
    return parts.slice(1).join(" ").replace(/^:/, "").trim().replace(/^"|"$/g, "").slice(0, 180) || textOf(lang).defaultProcess;
  }
  return textOf(lang).defaultProcess;
}

function parseIr(text: string, lang: Lang): { processes: Proc[]; error: string | null } {
  type Draft = {
    name: string;
    lanes: string[];
    nodes: { rawId: string; kind: Kind; label: string; lane: string | null; line: number }[];
    flows: Flow[];
    warnings: string[];
  };
  const messages = textOf(lang);
  const chunks: Draft[] = [];
  let current: Draft | null = null;

  const ensure = (lineno: number) => {
    if (!current) {
      current = { name: messages.defaultProcess, lanes: [], nodes: [], flows: [], warnings: [] };
      current.warnings.push(messages.missingProcess(lineno));
      chunks.push(current);
    }
    return current;
  };

  const lines = text.split(/\r?\n/);
  for (let lineno = 1; lineno <= lines.length; lineno += 1) {
    let raw = (lines[lineno - 1] ?? "").trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("//")) continue;
    raw = raw.replaceAll("→", "->").replaceAll("⇒", "->").replaceAll("➔", "->");
    const tokens = tokenize(raw);
    if (!tokens.length) continue;
    const head = (tokens[0]?.t === "word" ? tokens[0].v.toLowerCase() : "").replace(/:+$/, "");

    if (["process", "quytrinh", "pool", "participant"].includes(head)) {
      current = { name: headerName(raw, tokens, lang).slice(0, 180) || messages.defaultProcess, lanes: [], nodes: [], flows: [], warnings: [] };
      chunks.push(current);
      continue;
    }
    if (["lane", "lan", "role", "vaitro"].includes(head)) {
      const proc = ensure(lineno);
      const name = headerName(raw, tokens, lang);
      if (name && !proc.lanes.includes(name)) proc.lanes.push(name);
      continue;
    }
    if (isFlow(tokens)) {
      const proc = ensure(lineno);
      const parsed = parseFlow(tokens);
      if (!parsed) {
        proc.warnings.push(messages.badFlow(lineno));
        continue;
      }
      if (parsed.src === parsed.dst) {
        proc.warnings.push(messages.selfFlow(lineno, parsed.src));
        continue;
      }
      proc.flows.push({
        src: parsed.src,
        dst: parsed.dst,
        label: (parsed.label ?? "").trim().slice(0, 120) || null,
        line: lineno,
      });
      continue;
    }
    const kind = KIND_ALIAS[head];
    if (!kind) {
      ensure(lineno).warnings.push(messages.skipped(lineno, raw.slice(0, 72)));
      continue;
    }
    const proc = ensure(lineno);
    let nid = "";
    if (tokens[1]?.t === "word" && tokens[1].v !== "lane" && tokens[1].v !== "lan") nid = tokens[1].v;
    let label = tokens.slice(1).find((token) => token.t === "str")?.v.trim() ?? "";
    if (!label) {
      const words: string[] = [];
      for (const token of tokens.slice(2)) {
        if (token.t !== "word") continue;
        const low = token.v.toLowerCase();
        if (low === "lane" || low === "lan" || low.startsWith("lane=") || low.startsWith("label=")) break;
        words.push(token.v);
      }
      label = words.join(" ").trim();
    }
    const meta = kvAfter(tokens, nid ? 2 : 1);
    if (!nid) nid = `n${proc.nodes.length + 1}`;
    proc.nodes.push({
      rawId: nid,
      kind,
      label: (label || nid).slice(0, 180),
      lane: meta.lane ? meta.lane.slice(0, 120) : null,
      line: lineno,
    });
  }

  if (!chunks.length) {
    return { processes: [], error: messages.noProcess };
  }

  const processes: Proc[] = [];
  for (const proc of chunks) {
    const used = new Map<string, string>();
    const taken = new Set<string>();
    const nodes: Node[] = [];
    let drafts = proc.nodes;
    if (drafts.length > 40) {
      proc.warnings.push(messages.cap);
      drafts = drafts.slice(0, 40);
    }
    for (const node of drafts) {
      const base = sanitizeId(node.rawId);
      let finalId = base;
      let n = 2;
      while (taken.has(finalId)) {
        finalId = `${base}_${n}`;
        n += 1;
      }
      if (used.has(node.rawId) && used.get(node.rawId) !== finalId) {
        proc.warnings.push(messages.renamed(node.rawId, finalId));
      } else if (used.has(node.rawId)) {
        proc.warnings.push(messages.dupDrop(node.rawId));
        continue;
      }
      used.set(node.rawId, finalId);
      taken.add(finalId);
      nodes.push({ id: finalId, kind: node.kind, label: node.label, lane: node.lane });
    }
    const flows: Flow[] = [];
    const seenFlow = new Set<string>();
    for (const flow of proc.flows) {
      const src = resolveRef(flow.src, used);
      const dst = resolveRef(flow.dst, used);
      if (src.fuzzy) proc.warnings.push(messages.fuzzy(flow.line, flow.src));
      if (dst.fuzzy) proc.warnings.push(messages.fuzzy(flow.line, flow.dst));
      if (!src.id || !dst.id) {
        proc.warnings.push(messages.missingStep(flow.line, !src.id ? flow.src : flow.dst));
        continue;
      }
      const key = `${src.id}\0${dst.id}\0${flow.label ?? ""}`;
      if (seenFlow.has(key)) continue;
      seenFlow.add(key);
      flows.push({ src: src.id, dst: dst.id, label: flow.label });
    }
    if (nodes.length && !flows.length) {
      proc.warnings.push(messages.noFlows);
      for (let i = 0; i < nodes.length - 1; i += 1) {
        flows.push({ src: nodes[i]!.id, dst: nodes[i + 1]!.id, label: null });
      }
    }
    const keep = new Set(nodes.map((node) => node.id));
    const kept = flows.filter((flow) => keep.has(flow.src) && keep.has(flow.dst));
    // Safety net: every branch must finish at an end event.
    for (const node of [...nodes]) {
      if (node.kind === "end" || kept.some((f) => f.src === node.id) || !kept.some((f) => f.dst === node.id)) continue;
      let endId = `end_${node.id}`;
      while (keep.has(endId)) endId += "_";
      keep.add(endId);
      nodes.push({ id: endId, kind: "end", label: messages.autoEnd, lane: node.lane });
      kept.push({ src: node.id, dst: endId, label: null });
      proc.warnings.push(messages.noEnd(node.label));
    }
    if (!nodes.length) {
      proc.warnings.push(messages.empty(proc.name));
      continue;
    }
    const laneNames = [...proc.lanes];
    for (const node of nodes) {
      if (node.lane && !laneNames.includes(node.lane)) laneNames.push(node.lane);
    }
    if (laneNames.length && nodes.some((node) => node.lane == null)) {
      if (!laneNames.includes(messages.sharedLane)) laneNames.unshift(messages.sharedLane);
      for (const node of nodes) if (node.lane == null) node.lane = messages.sharedLane;
    }
    processes.push({ name: proc.name, lanes: laneNames, nodes, flows: kept, warnings: proc.warnings });
  }

  if (!processes.length) return { processes: [], error: messages.noSteps };
  return { processes, error: null };
}

function assignRanks(ids: string[], flows: Flow[]): Map<string, number> {
  const idset = new Set(ids);
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  const seen = new Set<string>();
  for (const flow of flows) {
    const key = `${flow.src}\0${flow.dst}`;
    if (seen.has(key) || !idset.has(flow.src) || !idset.has(flow.dst) || flow.src === flow.dst) continue;
    seen.add(key);
    outgoing.get(flow.src)!.push(flow.dst);
  }
  const color = new Map<string, number>(ids.map((id) => [id, 0]));
  const back = new Set<string>();
  const dfs = (node: string) => {
    color.set(node, 1);
    for (const next of outgoing.get(node) ?? []) {
      const state = color.get(next) ?? 0;
      if (state === 0) dfs(next);
      else if (state === 1) back.add(`${node}\0${next}`);
    }
    color.set(node, 2);
  };
  for (const node of ids) if ((color.get(node) ?? 0) === 0) dfs(node);

  const succ = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const src of ids) {
    for (const dst of outgoing.get(src) ?? []) {
      if (back.has(`${src}\0${dst}`)) continue;
      succ.get(src)!.push(dst);
      indeg.set(dst, (indeg.get(dst) ?? 0) + 1);
    }
  }
  const order = new Map(ids.map((id, index) => [id, index]));
  let queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const topo: string[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    topo.push(current);
    for (const next of succ.get(current) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if ((indeg.get(next) ?? 0) === 0) queue.push(next);
    }
    queue = queue.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }
  const seenTopo = new Set(topo);
  for (const node of ids) if (!seenTopo.has(node)) topo.push(node);
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const src of topo) {
    for (const dst of succ.get(src) ?? []) {
      if ((rank.get(src) ?? 0) + 1 > (rank.get(dst) ?? 0)) rank.set(dst, (rank.get(src) ?? 0) + 1);
    }
  }
  return rank;
}

function bary(node: string, links: string[], placed: Map<string, number>, order: Map<string, number>): [number, number] {
  const values = links.map((item) => placed.get(item)).filter((item): item is number => item != null);
  const fallback = order.get(node) ?? 0;
  if (!values.length) return [fallback, fallback];
  return [values.reduce((sum, item) => sum + item, 0) / values.length, fallback];
}

function orderColumns(ids: string[], flows: Flow[], rank: Map<string, number>): Map<number, string[]> {
  const columns = new Map<number, string[]>();
  for (const node of ids) {
    const key = rank.get(node) ?? 0;
    const list = columns.get(key) ?? [];
    list.push(node);
    columns.set(key, list);
  }
  const order = new Map(ids.map((id, index) => [id, index]));
  const pred = new Map<string, string[]>();
  const succ = new Map<string, string[]>();
  for (const flow of flows) {
    const p = pred.get(flow.dst) ?? [];
    p.push(flow.src);
    pred.set(flow.dst, p);
    const s = succ.get(flow.src) ?? [];
    s.push(flow.dst);
    succ.set(flow.src, s);
  }
  const positionMap = () => {
    const placed = new Map<string, number>();
    for (const grouped of columns.values()) grouped.forEach((node, index) => placed.set(node, index));
    return placed;
  };
  const cmp = (left: [number, number], right: [number, number]) =>
    left[0] === right[0] ? left[1] - right[1] : left[0] - right[0];
  for (let sweep = 0; sweep < 4; sweep += 1) {
    let placed = positionMap();
    for (const key of [...columns.keys()].sort((a, b) => a - b)) {
      columns.get(key)!.sort((a, b) => cmp(bary(a, pred.get(a) ?? [], placed, order), bary(b, pred.get(b) ?? [], placed, order)));
    }
    placed = positionMap();
    for (const key of [...columns.keys()].sort((a, b) => b - a)) {
      columns.get(key)!.sort((a, b) => cmp(bary(a, succ.get(a) ?? [], placed, order), bary(b, succ.get(b) ?? [], placed, order)));
    }
  }
  return columns;
}

function dedupePoints(points: [number, number][]): [number, number][] {
  const cleaned: [number, number][] = [];
  for (const [x, y] of points) {
    const point: [number, number] = [rint(x), rint(y)];
    const last = cleaned[cleaned.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) cleaned.push(point);
  }
  if (cleaned.length === 1) cleaned.push([cleaned[0]![0] + 16, cleaned[0]![1]]);
  return cleaned;
}

function labelBox(text: string, anchorX: number, anchorY: number, anchorW: number, anchorH: number) {
  const width = rint(Math.min(160, Math.max(28, text.length * 6.4)));
  return [rint(anchorX + anchorW / 2 - width / 2), rint(anchorY + anchorH + 4), width, 14] as const;
}

function flowLabelBox(text: string, points: [number, number][]) {
  const width = rint(Math.min(140, Math.max(24, text.length * 6.4)));
  let best = 0;
  let mx = points[0]?.[0] ?? 0;
  let my = points[0]?.[1] ?? 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[i + 1]!;
    const length = Math.hypot(x2 - x1, y2 - y1);
    if (length >= best) {
      best = length;
      mx = (x1 + x2) / 2;
      my = (y1 + y2) / 2;
    }
  }
  return [rint(mx - width / 2), rint(my - 18), width, 14] as const;
}

function renderXml(
  proc: Proc,
  prefix: string,
  bounds: Map<string, Box>,
  routed: { flow: Flow; points: [number, number][] }[],
  participant: Box | null,
  laneBoxes: LaneBox[],
  useLanes: boolean,
) {
  const processId = `${prefix}Process_1`;
  const collabId = `${prefix}Collaboration_1`;
  const participantId = `${prefix}Participant_1`;
  const planeId = `${prefix}BPMNPlane_1`;
  const diagramId = `${prefix}BPMNDiagram_1`;
  const bpmnOf = new Map(proc.nodes.map((node) => [node.id, `${prefix}${STEM[node.kind]}_${node.id}`]));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const flowIds: string[] = [];
  routed.forEach((item, index) => {
    const fid = `${prefix}Flow_${index + 1}`;
    flowIds.push(fid);
    const outs = outgoing.get(item.flow.src) ?? [];
    outs.push(fid);
    outgoing.set(item.flow.src, outs);
    const ins = incoming.get(item.flow.dst) ?? [];
    ins.push(fid);
    incoming.set(item.flow.dst, ins);
  });

  let collabXml = "";
  if (useLanes && participant) {
    collabXml =
      `  <bpmn:collaboration id="${collabId}" name="${esc(proc.name)}">\n` +
      `    <bpmn:participant id="${participantId}" name="${esc(proc.name)}" processRef="${processId}" />\n` +
      `  </bpmn:collaboration>`;
  }

  const lines = [`  <bpmn:process id="${processId}" name="${esc(proc.name)}" isExecutable="false">`];
  if (useLanes && laneBoxes.length) {
    lines.push(`    <bpmn:laneSet id="${prefix}LaneSet_1">`);
    const groups = new Map<string, string[]>();
    for (const node of proc.nodes) {
      const lane = node.lane ?? "";
      const list = groups.get(lane) ?? [];
      list.push(bpmnOf.get(node.id)!);
      groups.set(lane, list);
    }
    laneBoxes.forEach((lane, index) => {
      lines.push(`      <bpmn:lane id="${prefix}Lane_${index + 1}" name="${esc(lane.name)}">`);
      for (const ref of groups.get(lane.name) ?? []) lines.push(`        <bpmn:flowNodeRef>${ref}</bpmn:flowNodeRef>`);
      lines.push(`      </bpmn:lane>`);
    });
    lines.push(`    </bpmn:laneSet>`);
  }
  for (const node of proc.nodes) {
    const tag = BPMN_TAG[node.kind];
    const bid = bpmnOf.get(node.id)!;
    lines.push(`    <bpmn:${tag} id="${bid}" name="${esc(node.label)}">`);
    for (const fid of incoming.get(node.id) ?? []) lines.push(`      <bpmn:incoming>${fid}</bpmn:incoming>`);
    for (const fid of outgoing.get(node.id) ?? []) lines.push(`      <bpmn:outgoing>${fid}</bpmn:outgoing>`);
    lines.push(`    </bpmn:${tag}>`);
  }
  routed.forEach((item, index) => {
    const fid = flowIds[index]!;
    const name = item.flow.label ? ` name="${esc(item.flow.label)}"` : "";
    lines.push(
      `    <bpmn:sequenceFlow id="${fid}" sourceRef="${bpmnOf.get(item.flow.src)}" targetRef="${bpmnOf.get(item.flow.dst)}"${name} />`,
    );
  });
  lines.push(`  </bpmn:process>`);

  const shapes: string[] = [];
  if (participant) {
    shapes.push(
      `      <bpmndi:BPMNShape id="${participantId}_di" bpmnElement="${participantId}" isHorizontal="true">\n` +
        `        <dc:Bounds x="${participant.x}" y="${participant.y}" width="${participant.w}" height="${participant.h}" />\n` +
        `      </bpmndi:BPMNShape>`,
    );
    laneBoxes.forEach((lane, index) => {
      const lid = `${prefix}Lane_${index + 1}`;
      shapes.push(
        `      <bpmndi:BPMNShape id="${lid}_di" bpmnElement="${lid}" isHorizontal="true">\n` +
          `        <dc:Bounds x="${lane.x}" y="${rint(lane.y)}" width="${lane.w}" height="${lane.h}" />\n` +
          `      </bpmndi:BPMNShape>`,
      );
    });
  }
  for (const node of proc.nodes) {
    const bid = bpmnOf.get(node.id)!;
    const box = bounds.get(node.id)!;
    let labelXml = "";
    if (["start", "end", "xor", "and", "or"].includes(node.kind) && node.label) {
      const [lx, ly, lw, lh] = labelBox(node.label, box.x, box.y, box.w, box.h);
      labelXml =
        `\n        <bpmndi:BPMNLabel>\n` +
        `          <dc:Bounds x="${lx}" y="${ly}" width="${lw}" height="${lh}" />\n` +
        `        </bpmndi:BPMNLabel>`;
    }
    shapes.push(
      `      <bpmndi:BPMNShape id="${bid}_di" bpmnElement="${bid}">\n` +
        `        <dc:Bounds x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" />` +
        `${labelXml}\n` +
        `      </bpmndi:BPMNShape>`,
    );
  }
  const edges: string[] = [];
  routed.forEach((item, index) => {
    const fid = flowIds[index]!;
    const waypoints = item.points.map(([x, y]) => `        <di:waypoint x="${x}" y="${y}" />`).join("\n");
    let labelXml = "";
    if (item.flow.label) {
      const [lx, ly, lw, lh] = flowLabelBox(item.flow.label, item.points);
      labelXml =
        `\n        <bpmndi:BPMNLabel>\n` +
        `          <dc:Bounds x="${lx}" y="${ly}" width="${lw}" height="${lh}" />\n` +
        `        </bpmndi:BPMNLabel>`;
    }
    edges.push(
      `      <bpmndi:BPMNEdge id="${fid}_di" bpmnElement="${fid}">\n` + `${waypoints}${labelXml}\n` + `      </bpmndi:BPMNEdge>`,
    );
  });
  const planeElement = useLanes ? collabId : processId;
  const diagram =
    `  <bpmndi:BPMNDiagram id="${diagramId}">\n` +
    `    <bpmndi:BPMNPlane id="${planeId}" bpmnElement="${planeElement}">\n` +
    [...shapes, ...edges].join("\n") +
    `\n    </bpmndi:BPMNPlane>\n` +
    `  </bpmndi:BPMNDiagram>`;
  return { collaboration: collabXml, process: lines.join("\n"), diagram };
}

function compileProcess(proc: Proc, prefix: string, lang: Lang) {
  const byId = new Map(proc.nodes.map((node) => [node.id, node]));
  const ids = proc.nodes.map((node) => node.id);
  const rank = assignRanks(ids, proc.flows);
  const columns = orderColumns(ids, proc.flows, rank);
  const ranks = [...columns.keys()].sort((a, b) => a - b);
  const colWidth = new Map<number, number>();
  for (const key of ranks) {
    colWidth.set(
      key,
      Math.max(...(columns.get(key) ?? []).map((id) => nodeSize(byId.get(id)!.kind, byId.get(id)!.label)[0])),
    );
  }
  const xOf = new Map<number, number>();
  let cursor = LEFT_PAD;
  for (const key of ranks) {
    xOf.set(key, cursor);
    cursor += (colWidth.get(key) ?? 0) + COL_GAP;
  }
  const contentW = Math.max(180, ranks.length ? cursor - COL_GAP : 180);
  const useLanes = proc.lanes.length > 0;
  const bands: [string, Node[]][] = useLanes
    ? proc.lanes.map((name) => [name, proc.nodes.filter((node) => node.lane === name)])
    : [["", proc.nodes]];

  const bounds = new Map<string, [number, number, number, number]>();
  const laneBoxes: LaneBox[] = [];
  let yCursor = 0;
  for (const [laneName, laneNodes] of bands) {
    const present = new Set(laneNodes.map((node) => node.id));
    const stacks: [number, Node[]][] = [];
    const heights: number[] = [];
    for (const key of ranks) {
      const group = (columns.get(key) ?? []).filter((id) => present.has(id)).map((id) => byId.get(id)!);
      stacks.push([key, group]);
      if (!group.length) {
        heights.push(0);
        continue;
      }
      let height = group.reduce((sum, node) => sum + nodeSize(node.kind, node.label)[1], 0);
      height += ROW_GAP * (group.length - 1);
      heights.push(height);
    }
    const positive = heights.filter((h) => h > 0);
    const contentH = Math.max(...(positive.length ? positive : [80]));
    const bandH = contentH + LANE_PAD_Y * 2;
    for (const [key, group] of stacks) {
      if (!group.length) continue;
      let stackH = group.reduce((sum, node) => sum + nodeSize(node.kind, node.label)[1], 0);
      stackH += ROW_GAP * (group.length - 1);
      let cy = yCursor + LANE_PAD_Y + (contentH - stackH) / 2;
      for (const node of group) {
        const [width, height] = nodeSize(node.kind, node.label);
        const nx = (xOf.get(key) ?? 0) + ((colWidth.get(key) ?? width) - width) / 2;
        bounds.set(node.id, [nx, cy, width, height]);
        cy += height + ROW_GAP;
      }
    }
    laneBoxes.push({ name: laneName, x: 0, y: yCursor, w: 0, h: bandH });
    yCursor += bandH;
  }
  const localH = yCursor;
  const poolHeader = useLanes ? HEADER : 0;
  const laneHeader = useLanes ? HEADER : 0;
  const originX = 56 + poolHeader + laneHeader;
  const originY = 48;
  for (const [id, box] of bounds) bounds.set(id, [box[0] + originX, box[1] + originY, box[2], box[3]]);

  const pairTotal = new Map<string, number>();
  for (const flow of proc.flows) {
    const key = `${flow.src}\0${flow.dst}`;
    pairTotal.set(key, (pairTotal.get(key) ?? 0) + 1);
  }
  const pairSeen = new Map<string, number>();
  const routed: { flow: Flow; points: [number, number][] }[] = [];
  const deferred: { flow: Flow; shift: number }[] = [];
  for (const flow of proc.flows) {
    const key = `${flow.src}\0${flow.dst}`;
    const slot = pairSeen.get(key) ?? 0;
    pairSeen.set(key, slot + 1);
    const shift = rint((slot - ((pairTotal.get(key) ?? 1) - 1) / 2) * 12);
    const srcBox = bounds.get(flow.src)!;
    const dstBox = bounds.get(flow.dst)!;
    const delta = (rank.get(flow.dst) ?? 0) - (rank.get(flow.src) ?? 0);
    const sx = srcBox[0] + srcBox[2];
    const sy = srcBox[1] + srcBox[3] / 2;
    const tx = dstBox[0];
    const ty = dstBox[1] + dstBox[3] / 2;
    if (delta === 1 && tx > sx + 12) {
      let elbow = tx - 28 - shift;
      if (elbow < sx + 18) elbow = (sx + tx) / 2;
      routed.push({ flow, points: dedupePoints([[sx, sy], [elbow, sy], [elbow, ty], [tx, ty]]) });
    } else deferred.push({ flow, shift });
  }
  const extra = deferred.length ? 20 + deferred.length * 18 + 16 : 0;
  const baseBottom = originY + localH;
  deferred.forEach((item, index) => {
    const srcBox = bounds.get(item.flow.src)!;
    const dstBox = bounds.get(item.flow.dst)!;
    const sx = srcBox[0] + srcBox[2];
    const sy = srcBox[1] + srcBox[3] / 2;
    const tx = dstBox[0];
    const ty = dstBox[1] + dstBox[3] / 2;
    const channel = baseBottom + 18 + index * 18;
    const outX = sx + 24 + Math.max(0, item.shift);
    const inX = tx - 24 + Math.min(0, item.shift);
    routed.push({
      flow: item.flow,
      points: dedupePoints([[sx, sy], [outX, sy], [outX, channel], [inX, channel], [inX, ty], [tx, ty]]),
    });
  });

  let participant: Box | null = null;
  const drawnLanes: LaneBox[] = [];
  if (useLanes) {
    const pw = poolHeader + laneHeader + contentW + RIGHT_PAD;
    const ph = localH + extra;
    if (laneBoxes.length) laneBoxes[laneBoxes.length - 1]!.h += extra;
    participant = { x: 56, y: 48, w: rint(pw), h: rint(ph) };
    for (const lane of laneBoxes) {
      drawnLanes.push({
        name: lane.name,
        x: 56 + poolHeader,
        y: 48 + lane.y,
        w: rint(pw - poolHeader),
        h: rint(lane.h),
      });
    }
  }

  const warnings = [...proc.warnings];
  const connected = new Set<string>();
  for (const flow of proc.flows) {
    connected.add(flow.src);
    connected.add(flow.dst);
  }
  if (proc.nodes.length > 1) {
    for (const node of proc.nodes) {
      if (!connected.has(node.id)) warnings.push(textOf(lang).unlinked(node.label));
    }
  }
  const rounded = new Map<string, Box>();
  for (const [id, box] of bounds) {
    rounded.set(id, { x: rint(box[0]), y: rint(box[1]), w: rint(box[2]), h: rint(box[3]) });
  }
  return {
    name: proc.name,
    warnings,
    parts: renderXml(proc, prefix, rounded, routed, participant, useLanes ? drawnLanes : [], useLanes),
  };
}

function wrap(body: string[], lang: Lang): string {
  const inner = body.filter(Boolean).join("\n");
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<bpmn:definitions ${NS} id="Definitions_1" targetNamespace="http://text2bpmn.app/bpmn" exporter="text2BPMN" exporterVersion="1.0">\n` +
    `${inner}\n` +
    `</bpmn:definitions>\n`;
  const ids = [...xml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1] ?? "");
  if (new Set(ids).size !== ids.length) {
    const dupes = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort().slice(0, 6);
    throw new Error(textOf(lang).dupIds(dupes.join(", ")));
  }
  if (!xml.includes("</bpmn:definitions>")) throw new Error(textOf(lang).truncated);
  return xml;
}

export function translateIr(text: string, lang: Lang = "vi"): TranslateResult {
  const { processes, error } = parseIr(text || "", lang);
  if (error) return { ok: false, error };
  try {
    const compiled = processes.map((proc, index) => compileProcess(proc, `P${index + 1}_`, lang));
    const diagrams = compiled.map((item) => ({
      name: item.name,
      xml: wrap([item.parts.collaboration, item.parts.process, item.parts.diagram], lang),
      warnings: item.warnings,
    }));
    const combined = wrap(
      [
        ...compiled.flatMap((item) => [item.parts.collaboration, item.parts.process]),
        ...compiled.map((item) => item.parts.diagram),
      ],
      lang,
    );
    return { ok: true, diagrams, combinedXml: combined };
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return { ok: false, error: textOf(lang).badXml(message) };
  }
}
