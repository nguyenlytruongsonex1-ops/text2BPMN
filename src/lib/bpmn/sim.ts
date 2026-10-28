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
};

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

export function applyPreset(graph: SimGraph, preset: Preset) {
  const minutes: Record<string, number> = {};
  const rework: Record<string, number> = {};
  const probability: Record<string, number> = {};
  for (const node of graph.nodes) {
    const base = defaultMinutes(node.kind);
    minutes[node.id] = preset === "edge" && WORK.has(node.kind) ? Math.round(base * 1.25) : base;
    rework[node.id] = WORK.has(node.kind) ? (preset === "happy" ? 2 : 20) : 0;
  }
  const outs = new Map<string, SimFlow[]>();
  for (const flow of graph.flows) {
    const list = outs.get(flow.source) ?? [];
    list.push(flow);
    outs.set(flow.source, list);
  }
  const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  for (const [source, list] of outs) {
    const kind = kinds.get(source);
    const weights = kind === "xor" || kind === "or" ? presetWeights(list, preset) : list.map(() => 1 / list.length);
    list.forEach((flow, index) => {
      probability[flow.id] = Math.round((weights[index] ?? 0) * 100);
    });
  }
  return { minutes, rework, probability };
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
  },
): RunResult {
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

  for (let index = 0; index < cases; index += 1) {
    const caseId = String(index + 1).padStart(4, "0");
    const waits = new Map<string, number[]>();
    const queue: { id: string; time: number }[] = roots.map((id) => ({ id, time: BASE_MS + index * CASE_GAP_MS }));
    let steps = 0;
    let sawEnd = false;
    let first = Number.POSITIVE_INFINITY;
    let last = 0;
    while (queue.length && steps < 500) {
      steps += 1;
      const token = queue.shift()!;
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
      if (node.kind === "end") sawEnd = true;
      if (node.kind !== "xor" && node.kind !== "and" && node.kind !== "or") {
        let repeats = 0;
        let again = true;
        const rework = Math.max(0, Math.min(80, input.rework[node.id] ?? 0)) / 100;
        while (again && repeats < 5) {
          const minutes = Math.max(0, input.minutes[node.id] ?? node.minutes);
          const duration = node.kind === "start" || node.kind === "end" ? 1000 : Math.max(1000, minutes * 60_000);
          const end = time + duration;
          rows.push({
            caseId,
            activity: node.label,
            start: csvStamp(time),
            end: csvStamp(end),
            resource: node.role || "Unassigned",
            scenario: input.scenario,
          });
          if (WORK.has(node.kind)) {
            workMs.set(node.label, (workMs.get(node.label) ?? 0) + duration);
            workHits.set(node.label, (workHits.get(node.label) ?? 0) + 1);
            if (repeats > 0) reworkHits.set(node.label, (reworkHits.get(node.label) ?? 0) + 1);
          }
          first = Math.min(first, time);
          last = Math.max(last, end);
          time = end;
          repeats += 1;
          again = WORK.has(node.kind) && repeats < 5 && random() < rework;
        }
      }
      const outs = outgoing.get(node.id) ?? [];
      if (!outs.length) continue;
      if (node.kind === "and") {
        for (const flow of outs) queue.push({ id: flow.target, time });
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
      queue.push({ id: flow.target, time });
    }
    const complete = sawEnd && queue.length === 0;
    if (complete) completed += 1;
    caseMinutes.push({
      caseId,
      minutes: Number.isFinite(first) ? (last - first) / 60_000 : 0,
      complete,
    });
  }

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
  const header = "Case_ID,Activity,Start_Timestamp,End_Timestamp,Resource,Scenario_Type";
  const lines = rows.map((row) =>
    [row.caseId, row.activity, row.start, row.end, row.resource, row.scenario].map(csvEscape).join(","),
  );
  return [header, ...lines].join("\n");
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
        <date key="time:timestamp" value="${event.start.replace(" ", "T")}Z"/>
        <string key="org:resource" value="${xmlEscape(event.resource)}"/>
      </event>`,
          `      <event>
        <string key="concept:name" value="${xmlEscape(event.activity)}"/>
        <string key="lifecycle:transition" value="complete"/>
        <date key="time:timestamp" value="${event.end.replace(" ", "T")}Z"/>
        <string key="org:resource" value="${xmlEscape(event.resource)}"/>
      </event>`,
        ])
        .join("\n");
      return `    <trace>
      <string key="concept:name" value="${xmlEscape(caseId)}"/>
      <string key="scenario:type" value="${xmlEscape(scenario)}"/>
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
