export type SimKind = "start" | "end" | "task" | "user" | "service" | "xor" | "and" | "or";

export type SimNode = {
  id: string;
  kind: SimKind;
  label: string;
  role: string;
  minutes: number;
};

export type SimFlow = {
  id: string;
  source: string;
  target: string;
  label: string;
  probability: number;
};

export type SimGraph = {
  name: string;
  nodes: SimNode[];
  flows: SimFlow[];
};

export type Preset = "happy" | "edge";

export type LogRow = {
  caseId: string;
  activity: string;
  start: string;
  end: string;
  resource: string;
  scenario: string;
  role?: string;
  customer?: string;
};

// Semantic config: who can do the work. LLM may propose it; default comes from lanes.
export type Semantics = {
  roles: Record<string, string[]>; // role (lane) -> named people
  unlimited?: string[]; // roles with no capacity limit (e.g. system)
  customerRole?: string; // lane whose tasks are done by the case's own customer
  customers?: string[];
  minutes?: Record<string, number>; // optional per-task duration by label
  rework?: Record<string, number>; // task label -> repeat probability; others never repeat
  branches?: Record<string, Record<string, number>>; // xor label -> target label -> probability (0..1), good scenario
  bottlenecks?: string[]; // task labels that slow down most in the bad scenario
};

const REWORK_RE = /(kiểm tra|soạn|duyệt|xử lý|sửa|check|review|prepare|process|fix)/i;

function customerLane(lane: string) {
  return /(khách|khach|customer|client|^nhân viên$|^employee$|ứng viên|applicant)/i.test(lane.trim());
}

function reworkTasks(graph: SimGraph) {
  const lanes = graph.nodes.filter((n) => WORK.has(n.kind)).map((n) => n.role);
  const cust = lanes.find(customerLane);
  return graph.nodes.filter(
    (n) => WORK.has(n.kind) && n.role !== cust && !SYSTEM_RE.test(n.role) && n.role !== "Unassigned" && REWORK_RE.test(n.label),
  );
}

const SYSTEM_RE = /(hệ thống|he thong|system|website|app)/i;

// Fill every key the user's JSON leaves out from the lane-derived defaults.
export function resolveSemantics(graph: SimGraph, given?: Partial<Semantics> | null): Semantics {
  const base = defaultSemantics(graph);
  if (!given) return base;
  return {
    roles: { ...base.roles, ...(given.roles ?? {}) },
    unlimited: given.unlimited ?? base.unlimited,
    customerRole: given.customerRole ?? base.customerRole,
    customers: given.customers ?? base.customers,
    minutes: given.minutes ?? base.minutes,
    rework: given.rework ?? base.rework,
    branches: given.branches ?? base.branches,
    bottlenecks: given.bottlenecks ?? base.bottlenecks,
  };
}

export function defaultSemantics(graph: SimGraph): Semantics {
  const lanes = [...new Set(graph.nodes.filter((n) => WORK.has(n.kind)).map((n) => n.role))];
  const sem: Semantics = { roles: {}, unlimited: [] };
  for (const lane of lanes) {
    // requester lane (customer, or the employee/applicant who files the case) = per-case entity
    if (!sem.customerRole && customerLane(lane)) {
      const prefix = /(khách|khach)/i.test(lane) ? "Khách" : /(customer|client)/i.test(lane) ? "Customer" : lane;
      sem.customerRole = lane;
      sem.customers = ["A", "B", "C"].map((x) => `${prefix} ${x}`);
      sem.roles[lane] = sem.customers;
    } else if (SYSTEM_RE.test(lane) || lane === "Unassigned") {
      sem.roles[lane] = [lane];
      sem.unlimited!.push(lane);
    } else {
      const size = /(quản lý|quan ly|manager|giám đốc|director)/i.test(lane) ? 1 : 2;
      sem.roles[lane] = Array.from({ length: size }, (_, i) => `${lane} - NV${i + 1}`);
    }
  }
  sem.rework = Object.fromEntries(reworkTasks(graph).map((n) => [n.label, 0.03]));
  return sem;
}

export type Problem =
  | { code: "incomplete"; count: number }
  | { code: "rework"; label: string; rate: number }
  | { code: "rare"; gateway: string; label: string; share: number }
  | { code: "dead"; label: string };

export type BranchStat = {
  gateway: string;
  label: string;
  count: number;
  share: number;
};

export type StepStat = {
  label: string;
  minutes: number;
  share: number;
};

export type PaceBar = {
  label: string;
  count: number;
};

export type RunResult = {
  scenario: string;
  rows: LogRow[];
  cases: number;
  completed: number;
  avgMinutes: number;
  bottleneck: { label: string; minutes: number; share: number } | null;
  steps: StepStat[];
  pace: PaceBar[];
  outliers: { caseId: string; minutes: number }[];
  problems: Problem[];
  branches: BranchStat[];
};

type XmlEl = { name: string; attrs: Record<string, string>; children: XmlEl[]; text: string };

const WORK = new Set<SimKind>(["task", "user", "service"]);
const BASE_MS = Date.UTC(2026, 0, 5, 8, 0, 0);
const CASE_GAP_MS = 10 * 60 * 1000;

const KIND_OF: Record<string, SimKind> = {
  startEvent: "start",
  endEvent: "end",
  task: "task",
  manualTask: "task",
  userTask: "user",
  serviceTask: "service",
  scriptTask: "service",
  exclusiveGateway: "xor",
  parallelGateway: "and",
  inclusiveGateway: "or",
};

function local(name: string) {
  const index = name.indexOf(":");
  return index >= 0 ? name.slice(index + 1) : name;
}

function decode(value: string) {
  const amp = "&" + "amp;";
  const lt = "&" + "lt;";
  const gt = "&" + "gt;";
  const quot = "&" + "quot;";
  const apos = "&" + "apos;";
  return value.split(lt).join("<").split(gt).join(">").split(quot).join('"').split(apos).join("'").split(amp).join("&");
}

function readAttrs(source: string) {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z0-9:_-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) attrs[local(match[1] ?? "")] = decode(match[2] ?? "");
  return attrs;
}

function parseXml(xml: string): XmlEl[] {
  const root: XmlEl = { name: "root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let index = 0;
  while (index < xml.length) {
    const lt = xml.indexOf("<", index);
    if (lt < 0) {
      stack[stack.length - 1]!.text += xml.slice(index);
      break;
    }
    if (lt > index) stack[stack.length - 1]!.text += xml.slice(index, lt);
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt);
      index = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt);
      index = end < 0 ? xml.length : end + 2;
      continue;
    }
    if (xml.startsWith("</", lt)) {
      const end = xml.indexOf(">", lt);
      const name = xml.slice(lt + 2, end < 0 ? xml.length : end).trim();
      while (stack.length > 1 && local(stack[stack.length - 1]!.name) !== local(name)) stack.pop();
      if (stack.length > 1) stack.pop();
      index = end < 0 ? xml.length : end + 1;
      continue;
    }
    const end = xml.indexOf(">", lt);
    if (end < 0) break;
    const empty = xml[end - 1] === "/";
    const raw = xml.slice(lt + 1, empty ? end - 1 : end).trim();
    const space = raw.search(/\s/);
    const name = space < 0 ? raw : raw.slice(0, space);
    const node: XmlEl = {
      name,
      attrs: readAttrs(space < 0 ? "" : raw.slice(space)),
      children: [],
      text: "",
    };
    stack[stack.length - 1]!.children.push(node);
    if (!empty) stack.push(node);
    index = end + 1;
  }
  return root.children;
}

function walk(nodes: XmlEl[], visit: (el: XmlEl) => void) {
  for (const node of nodes) {
    visit(node);
    walk(node.children, visit);
  }
}

function defaultMinutes(kind: SimKind) {
  if (kind === "user") return 30;
  if (kind === "task") return 20;
  if (kind === "service") return 5;
  return 0;
}

function tone(label: string): "yes" | "no" | "none" {
  const value = label.normalize("NFC").toLowerCase();
  if (/(không|khong|từ chối|tu choi|reject|fail|\bno\b|hết|het|lỗi|loi|error)/i.test(value)) return "no";
  if (/(có|\byes\b|đồng ý|dong y|duyệt|duyet|approved|đạt|\bdat\b|pass|\bok\b)/i.test(value)) return "yes";
  return "none";
}

function hashSeed(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(weights: number[], random: () => number) {
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let cursor = random() * total;
  for (let index = 0; index < weights.length; index += 1) {
    cursor -= weights[index] ?? 0;
    if (cursor <= 0) return index;
  }
  return Math.max(0, weights.length - 1);
}

function csvStamp(ms: number) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function xmlEscape(value: string) {
  return value
    .replace(/&/g, "&" + "amp;")
    .replace(/</g, "&" + "lt;")
    .replace(/>/g, "&" + "gt;")
    .replace(/"/g, "&" + "quot;");
}

function csvEscape(value: string) {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function parseBpmn(xml: string): SimGraph {
  const roles = new Map<string, string>();
  const nodes: SimNode[] = [];
  const flows: SimFlow[] = [];
  let name = "";
  walk(parseXml(xml), (el) => {
    const kindName = local(el.name);
    if (kindName === "process" && !name) name = el.attrs.name ?? "";
    if (kindName === "lane") {
      const lane = el.attrs.name ?? "";
      for (const child of el.children) {
        if (local(child.name) === "flowNodeRef" && child.text.trim()) roles.set(child.text.trim(), lane);
      }
    }
    const kind = KIND_OF[kindName];
    if (kind && el.attrs.id) {
      nodes.push({
        id: el.attrs.id,
        kind,
        label: el.attrs.name?.trim() || el.attrs.id,
        role: "",
        minutes: defaultMinutes(kind),
      });
    }
    if (kindName === "sequenceFlow" && el.attrs.id && el.attrs.sourceRef && el.attrs.targetRef) {
      flows.push({
        id: el.attrs.id,
        source: el.attrs.sourceRef,
        target: el.attrs.targetRef,
        label: el.attrs.name?.trim() || "",
        probability: 1,
      });
    }
  });
  for (const node of nodes) node.role = roles.get(node.id) || "Unassigned";
  const bySource = new Map<string, SimFlow[]>();
  for (const flow of flows) {
    const list = bySource.get(flow.source) ?? [];
    list.push(flow);
    bySource.set(flow.source, list);
  }
  for (const list of bySource.values()) {
    if (list.length <= 1) continue;
    const share = 1 / list.length;
    for (const flow of list) flow.probability = share;
  }
  return { name: name || "Process", nodes, flows };
}

export function presetWeights(flows: SimFlow[], preset: Preset) {
  if (flows.length <= 1) return flows.map(() => 1);
  const tones = flows.map((flow) => tone(flow.label));
  const prefer = preset === "happy" ? "yes" : "no";
  const picked = tones.flatMap((value, index) => (value === prefer ? [index] : []));
  const main = picked.length ? picked : [preset === "happy" ? 0 : flows.length - 1];
  const mainShare = preset === "happy" ? 0.9 : 0.7;
  const rest = flows.length - main.length;
  return flows.map((_, index) => {
    if (main.includes(index)) return mainShare / main.length;
    return rest > 0 ? (1 - mainShare) / rest : 0;
  });
}

// sem (optional, e.g. from the LLM feature call) supplies minutes, rework, branch odds and bottlenecks by label.
export function applyPreset(graph: SimGraph, preset: Preset, sem?: Partial<Semantics> | null) {
  const minutes: Record<string, number> = {};
  const rework: Record<string, number> = {};
  const probability: Record<string, number> = {};
  const slow = new Set(sem?.bottlenecks ?? []);
  for (const node of graph.nodes) {
    const base = (WORK.has(node.kind) ? sem?.minutes?.[node.label] : undefined) ?? defaultMinutes(node.kind);
    const factor = preset === "edge" && WORK.has(node.kind) ? (slow.has(node.label) ? 2.5 : 1.25) : 1;
    minutes[node.id] = Math.max(1, Math.round(base * factor));
    rework[node.id] = 0;
  }
  if (sem?.rework) {
    for (const node of graph.nodes) {
      const p = WORK.has(node.kind) ? sem.rework[node.label] : undefined;
      if (p === undefined) continue;
      rework[node.id] = preset === "happy" ? Math.round(p * 100) : Math.min(50, Math.max(10, Math.round(p * 300)));
    }
  } else {
    for (const node of reworkTasks(graph)) rework[node.id] = preset === "happy" ? 3 : 10;
  }
  const outs = new Map<string, SimFlow[]>();
  for (const flow of graph.flows) {
    const list = outs.get(flow.source) ?? [];
    list.push(flow);
    outs.set(flow.source, list);
  }
  const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  for (const [source, list] of outs) {
    const kind = kinds.get(source);
    const hinted = kind === "xor" && preset === "happy" ? sem?.branches?.[labels.get(source) ?? ""] : undefined;
    const fromHint = hinted ? list.map((flow) => hinted[labels.get(flow.target) ?? ""] ?? 0) : null;
    const weights =
      fromHint && fromHint.some((w) => w > 0)
        ? fromHint.map((w) => w / fromHint.reduce((a, b) => a + b, 0))
        : kind === "xor" || kind === "or"
          ? presetWeights(list, preset)
          : list.map(() => 1 / list.length);
    list.forEach((flow, index) => {
      probability[flow.id] = Math.round((weights[index] ?? 0) * 100);
    });
  }
  return { minutes, rework, probability, arrival: preset === "happy" ? 10 : 7 };
}

function quantile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low] ?? 0;
  const left = sorted[low] ?? 0;
  const right = sorted[high] ?? left;
  return left * (high - index) + right * (index - low);
}

export function simulate(
  graph: SimGraph,
  input: {
    scenario: string;
    cases: number;
    minutes: Record<string, number>;
    rework: Record<string, number>;
    probability: Record<string, number>;
    semantics?: Semantics;
    arrival?: number; // mean minutes between case arrivals (exponential)
  },
): RunResult {
  const sem = resolveSemantics(graph, input.semantics);
  const hasEnd = graph.nodes.some((n) => n.kind === "end");
  const freeAt = new Map<string, number>(); // person -> time they become free
  const cases = Math.max(1, Math.min(2000, Math.round(input.cases) || 1));
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, SimFlow[]>();
  const incoming = new Map<string, number>();
  for (const node of graph.nodes) incoming.set(node.id, 0);
  for (const flow of graph.flows) {
    if (!nodes.has(flow.source) || !nodes.has(flow.target)) continue;
    const list = outgoing.get(flow.source) ?? [];
    list.push(flow);
    outgoing.set(flow.source, list);
    incoming.set(flow.target, (incoming.get(flow.target) ?? 0) + 1);
  }
  const starts = graph.nodes.filter((node) => node.kind === "start");
  const roots = (starts.length ? starts : graph.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0)).map(
    (node) => node.id,
  );
  const seed = hashSeed(
    JSON.stringify({
      scenario: input.scenario,
      cases,
      minutes: input.minutes,
      rework: input.rework,
      probability: input.probability,
      sem,
      arrival: input.arrival,
    }),
  );
  const random = mulberry32(seed);
  const rows: LogRow[] = [];
  const caseMinutes: { caseId: string; minutes: number; complete: boolean }[] = [];
  const workMs = new Map<string, number>();
  const workHits = new Map<string, number>();
  const reworkHits = new Map<string, number>();
  const branchHits = new Map<string, number>();
  const branchTries = new Map<string, number>();
  let completed = 0;

  type Tok = { c: number; id: string; time: number; seq: number };
  type CaseState = {
    caseId: string;
    customer: string;
    waits: Map<string, number[]>;
    open: number;
    sawEnd: boolean;
    steps: number;
    first: number;
    last: number;
  };
  const states: CaseState[] = [];
  const agenda: Tok[] = [];
  let seq = 0;
  const push = (tok: Omit<Tok, "seq">) => {
    const item = { ...tok, seq: seq++ };
    let lo = 0;
    let hi = agenda.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = agenda[mid]!;
      if (m.time < item.time || (m.time === item.time && m.seq < item.seq)) lo = mid + 1;
      else hi = mid;
    }
    agenda.splice(lo, 0, item);
    states[item.c]!.open += 1;
  };
  const arrivals = mulberry32(seed ^ 0x9e3779b9);
  const meanGap = Math.max(0.1, input.arrival ?? CASE_GAP_MS / 60_000) * 60_000;
  let arrive = BASE_MS;
  const customers = sem.customers?.length ? sem.customers : [];
  for (let index = 0; index < cases; index += 1) {
    states.push({
      caseId: String(index + 1).padStart(4, "0"),
      customer: customers.length ? customers[Math.floor(random() * customers.length)]! : "",
      waits: new Map(),
      open: 0,
      sawEnd: false,
      steps: 0,
      first: Number.POSITIVE_INFINITY,
      last: 0,
    });
    if (index > 0) arrive += Math.round((-Math.log(1 - arrivals()) * meanGap) / 60_000) * 60_000;
    for (const id of roots) push({ c: index, id, time: arrive });
  }
  // Pick who does the step: the case's customer, an unlimited role, or the earliest-free member.
  const assign = (cs: CaseState, role: string, ready: number) => {
    if (sem.customerRole && role === sem.customerRole && cs.customer) return { who: cs.customer, at: ready, hold: false };
    const pool = sem.roles[role];
    if (!pool?.length || sem.unlimited?.includes(role)) return { who: pool?.[0] ?? role, at: ready, hold: false };
    let who = pool[0]!;
    for (const p of pool) if ((freeAt.get(p) ?? 0) < (freeAt.get(who) ?? 0)) who = p;
    return { who, at: Math.max(ready, freeAt.get(who) ?? 0), hold: true };
  };

  while (agenda.length) {
    const token = agenda.shift()!;
    const cs = states[token.c]!;
    cs.open -= 1;
    if (cs.steps >= 500) continue;
    cs.steps += 1;
    const caseId = cs.caseId;
    const waits = cs.waits;
    const node = nodes.get(token.id);
    if (!node) continue;
    let time = token.time;
    const ins = incoming.get(node.id) ?? 0;
    if (node.kind === "and" && ins > 1) {
      const bag = waits.get(node.id) ?? [];
      bag.push(time);
      waits.set(node.id, bag);
      if (bag.length < ins) continue;
      time = Math.max(...bag);
      waits.set(node.id, []);
    }
    if (node.kind === "end") cs.sawEnd = true;
    if (node.kind !== "xor" && node.kind !== "and" && node.kind !== "or") {
      let repeats = 0;
      let again = true;
      const allowed = sem.rework ? node.label in sem.rework : true;
      const rework = allowed
        ? Math.max(0, Math.min(80, input.rework[node.id] ?? (sem.rework?.[node.label] ?? 0) * 100)) / 100
        : 0;
      const work = WORK.has(node.kind);
      const slot = work ? assign(cs, node.role, time) : { who: "", at: time, hold: false };
      time = slot.at;
      while (again && repeats < 5) {
        const minutes = Math.max(0, input.minutes[node.id] ?? sem.minutes?.[node.label] ?? node.minutes);
        const duration = node.kind === "start" || node.kind === "end" ? 1000 : Math.max(1000, minutes * 60_000);
        const end = time + duration;
        rows.push({
          caseId,
          activity: node.label,
          start: csvStamp(time),
          end: csvStamp(end),
          resource: slot.who,
          role: node.role || "Unassigned",
          customer: cs.customer,
          scenario: input.scenario,
        });
        if (work) {
          workMs.set(node.label, (workMs.get(node.label) ?? 0) + duration);
          workHits.set(node.label, (workHits.get(node.label) ?? 0) + 1);
          if (repeats > 0) reworkHits.set(node.label, (reworkHits.get(node.label) ?? 0) + 1);
        }
        cs.first = Math.min(cs.first, time);
        cs.last = Math.max(cs.last, end);
        time = end;
        repeats += 1;
        again = work && repeats < 5 && random() < rework;
      }
      if (slot.hold) freeAt.set(slot.who, time);
    }
    const outs = outgoing.get(node.id) ?? [];
    if (!outs.length) continue;
    if (node.kind === "and") {
      for (const flow of outs) push({ c: token.c, id: flow.target, time });
      continue;
    }
    const weights = outs.map((flow) => Math.max(0, input.probability[flow.id] ?? flow.probability * 100));
    const choice = outs.length === 1 ? 0 : pick(weights, random);
    const flow = outs[choice];
    if (!flow) continue;
    if (node.kind === "xor" || node.kind === "or") {
      branchTries.set(node.id, (branchTries.get(node.id) ?? 0) + 1);
      branchHits.set(flow.id, (branchHits.get(flow.id) ?? 0) + 1);
    }
    push({ c: token.c, id: flow.target, time });
  }
  for (const cs of states) {
    const complete = (cs.sawEnd || !hasEnd) && cs.open === 0 && [...cs.waits.values()].every((b) => !b.length);
    if (complete) completed += 1;
    caseMinutes.push({
      caseId: cs.caseId,
      minutes: Number.isFinite(cs.first) ? (cs.last - cs.first) / 60_000 : 0,
      complete,
    });
  }
  rows.sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  const finished = caseMinutes.filter((item) => item.complete);
  const avgMinutes = finished.length
    ? finished.reduce((sum, item) => sum + item.minutes, 0) / finished.length
    : 0;
  const sorted = finished.map((item) => item.minutes).sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const median = quantile(sorted, 0.5);
  const iqr = q3 - q1;
  const fence = iqr > 0.05 ? q3 + 1.5 * iqr : median;
  const outliers = finished
    .filter((item) => item.minutes > fence + 0.05)
    .sort((a, b) => b.minutes - a.minutes)
    .map((item) => ({ caseId: item.caseId, minutes: Math.round(item.minutes * 10) / 10 }));

  let bottleneck: RunResult["bottleneck"] = null;
  let bestMs = -1;
  const total = [...workMs.values()].reduce((sum, value) => sum + value, 0);
  for (const [label, ms] of workMs) {
    if (ms <= bestMs) continue;
    bestMs = ms;
    bottleneck = {
      label,
      minutes: Math.round((ms / 60_000) * 10) / 10,
      share: total > 0 ? Math.round((ms / total) * 100) : 0,
    };
  }
  const stepStats: StepStat[] = [...workMs.entries()]
    .map(([label, ms]) => ({
      label,
      minutes: Math.round((ms / 60_000) * 10) / 10,
      share: total > 0 ? Math.round((ms / total) * 100) : 0,
    }))
    .sort((left, right) => right.minutes - left.minutes);
  const pace = paceBars(finished.map((item) => item.minutes));

  const problems: Problem[] = [];
  const incomplete = cases - completed;
  if (incomplete > 0) problems.push({ code: "incomplete", count: incomplete });
  for (const [label, hits] of workHits) {
    const redos = reworkHits.get(label) ?? 0;
    const rate = hits > 0 ? Math.round((redos / hits) * 100) : 0;
    if (rate >= 10) problems.push({ code: "rework", label, rate });
  }
  for (const node of graph.nodes) {
    if (WORK.has(node.kind) && !workHits.has(node.label)) problems.push({ code: "dead", label: node.label });
  }
  const branches: BranchStat[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "xor" && node.kind !== "or") continue;
    const tries = branchTries.get(node.id) ?? 0;
    for (const flow of outgoing.get(node.id) ?? []) {
      const count = branchHits.get(flow.id) ?? 0;
      const share = tries > 0 ? Math.round((count / tries) * 100) : 0;
      branches.push({ gateway: node.label, label: flow.label || flow.target, count, share });
      if (tries >= 30 && share < 8) {
        problems.push({ code: "rare", gateway: node.label, label: flow.label || flow.target, share });
      }
    }
  }

  return {
    scenario: input.scenario,
    rows,
    cases,
    completed,
    avgMinutes: Math.round(avgMinutes * 10) / 10,
    bottleneck,
    steps: stepStats,
    pace,
    outliers,
    problems,
    branches,
  };
}

function paceBars(values: number[]): PaceBar[] {
  if (values.length < 2) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1) return [];
  const slots = 8;
  const width = (max - min) / slots;
  const counts = Array.from({ length: slots }, () => 0);
  for (const value of values) {
    const index = Math.min(slots - 1, Math.floor((value - min) / width));
    counts[index] += 1;
  }
  return counts.map((count, index) => ({
    label: String(Math.round(min + index * width)),
    count,
  }));
}

export function toCsv(rows: LogRow[]) {
  const header = "Case_ID,Activity,Start_Timestamp,End_Timestamp,Resource,Role,Customer,Scenario_Type";
  const lines = rows.map((row) =>
    [row.caseId, row.activity, row.start, row.end, row.resource, row.role ?? "", row.customer ?? "", row.scenario].map(csvEscape).join(","),
  );
  return [header, ...lines].join("\n");
}

function orgAttrs(event: LogRow) {
  let out = "";
  if (event.resource) out += `\n        <string key="org:resource" value="${xmlEscape(event.resource)}"/>`;
  if (event.role) out += `\n        <string key="org:role" value="${xmlEscape(event.role)}"/>`;
  return out;
}

export function toXes(rows: LogRow[], scenario: string) {
  const traces = new Map<string, LogRow[]>();
  for (const row of rows) {
    const list = traces.get(row.caseId) ?? [];
    list.push(row);
    traces.set(row.caseId, list);
  }
  const body = [...traces.entries()]
    .map(([caseId, events]) => {
      const items = events
        .flatMap((event) => [
          `      <event>
        <string key="concept:name" value="${xmlEscape(event.activity)}"/>
        <string key="lifecycle:transition" value="start"/>
        <date key="time:timestamp" value="${event.start.replace(" ", "T")}Z"/>${orgAttrs(event)}
      </event>`,
          `      <event>
        <string key="concept:name" value="${xmlEscape(event.activity)}"/>
        <string key="lifecycle:transition" value="complete"/>
        <date key="time:timestamp" value="${event.end.replace(" ", "T")}Z"/>${orgAttrs(event)}
      </event>`,
        ])
        .join("\n");
      return `    <trace>
      <string key="concept:name" value="${xmlEscape(caseId)}"/>
      <string key="scenario:type" value="${xmlEscape(scenario)}"/>${events[0]?.customer ? `
      <string key="customer" value="${xmlEscape(events[0].customer)}"/>` : ""}
${items}
    </trace>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<log xmlns="http://www.xes-standard.org/" xes.version="1.0" xes.features="nested-attributes">
  <extension name="Concept" prefix="concept" uri="http://www.xes-standard.org/concept.xesext"/>
  <extension name="Time" prefix="time" uri="http://www.xes-standard.org/time.xesext"/>
  <extension name="Organizational" prefix="org" uri="http://www.xes-standard.org/org.xesext"/>
  <extension name="Lifecycle" prefix="lifecycle" uri="http://www.xes-standard.org/lifecycle.xesext"/>
  <string key="concept:name" value="${xmlEscape(scenario)}"/>
${body}
</log>
`;
}
