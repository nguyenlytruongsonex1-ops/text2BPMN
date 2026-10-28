import { resolveSemantics, type LogRow, type Semantics, type SimFlow, type SimGraph } from "./sim.ts";

export type VerifyError = { caseId: string; message: string };
export type VerifyResult = { total: number; valid: number; errors: VerifyError[]; warnings: string[] };

type Token = { id: string; t: number };
type State = Token[];

const SILENT = new Set(["xor", "and", "or"]);
const MAX_STATES = 400;

function stamp(value: string) {
  return Date.parse(value.replace(" ", "T") + "Z");
}

function key(state: State) {
  return state
    .map((token) => `${token.id}@${token.t}`)
    .sort()
    .join("|");
}

// Replays each case of a simulated log on the model (token game). Gateways are silent:
// XOR/OR pass one token to exactly one branch, AND splits to all branches and joins only
// when every incoming branch has arrived. A step may repeat right after itself (rework).
export function verifyLog(graph: SimGraph, rows: LogRow[], semantics?: Partial<Semantics>): VerifyResult {
  const sem = resolveSemantics(graph, semantics);
  const hasEnd = graph.nodes.some((n) => n.kind === "end");
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const outs = new Map<string, SimFlow[]>();
  const ins = new Map<string, number>();
  for (const flow of graph.flows) {
    if (!nodes.has(flow.source) || !nodes.has(flow.target)) continue;
    outs.set(flow.source, [...(outs.get(flow.source) ?? []), flow]);
    ins.set(flow.target, (ins.get(flow.target) ?? 0) + 1);
  }
  const starts = graph.nodes.filter((node) => node.kind === "start");
  const roots = starts.length ? starts : graph.nodes.filter((node) => !ins.get(node.id));

  // All ways a token leaving `id` at time t can continue.
  const emit = (id: string, t: number): State[] => {
    const list = outs.get(id) ?? [];
    if (!list.length) return [[]];
    if (nodes.get(id)?.kind === "and") return [list.map((flow) => ({ id: flow.target, t }))];
    return list.map((flow) => [{ id: flow.target, t }]);
  };

  // Fire silent gateways until nothing changes; keep every intermediate state.
  const close = (seed: State[]): State[] => {
    const seen = new Map<string, State>();
    const stack = [...seed];
    while (stack.length && seen.size < MAX_STATES) {
      const state = stack.pop()!;
      const k = key(state);
      if (seen.has(k)) continue;
      seen.set(k, state);
      for (const token of state) {
        const node = nodes.get(token.id);
        if (!node || !SILENT.has(node.kind)) continue;
        const need = node.kind === "and" ? Math.max(1, ins.get(node.id) ?? 1) : 1;
        const here = state.filter((other) => other.id === token.id);
        if (here.length < need) continue;
        const used = here.slice(0, need);
        const t = Math.max(...used.map((other) => other.t));
        const rest = state.filter((other) => !used.includes(other));
        for (const next of emit(node.id, t)) stack.push([...rest, ...next]);
      }
    }
    return [...seen.values()];
  };

  const byCase = new Map<string, LogRow[]>();
  for (const row of rows) byCase.set(row.caseId, [...(byCase.get(row.caseId) ?? []), row]);

  const busy = overlaps(graph, rows, sem);
  const errors: VerifyError[] = [];
  let valid = 0;
  for (const [caseId, raw] of byCase) {
    const events = raw.map((row, index) => ({
      row,
      index,
      start: stamp(row.start),
      end: stamp(row.end),
    }));
    let message = "";
    const bad = events.find((event) => !(event.end >= event.start));
    if (bad) message = `«${bad.row.activity}» kết thúc trước khi bắt đầu`;
    events.sort((a, b) => a.start - b.start || a.index - b.index);
    const first = nodes.get(roots.find((node) => node.label === events[0]?.row.activity)?.id ?? "");
    if (!message && !first)
      message = `bắt đầu bằng «${events[0]?.row.activity ?? "?"}», không phải điểm bắt đầu`;
    let states = close([roots.map((node) => ({ id: node.id, t: events[0]?.start ?? 0 }))]);
    let last: { id: string; end: number } | null = null;
    for (const event of message ? [] : events) {
      const next: State[] = [];
      let late = false;
      for (const state of states) {
        for (const token of state) {
          const node = nodes.get(token.id);
          if (!node || SILENT.has(node.kind) || node.label !== event.row.activity) continue;
          if (token.t > event.start) {
            late = true;
            continue;
          }
          const rest = state.filter((other) => other !== token);
          for (const more of emit(node.id, event.end)) next.push([...rest, ...more]);
          // rework: the same step may run again straight after itself
          next.push([...rest, { id: node.id, t: event.end }]);
        }
      }
      if (!next.length) {
        message = late
          ? `«${event.row.activity}» bắt đầu lúc ${event.row.start}, trước khi bước trước xong`
          : `«${event.row.activity}» không được phép ở đây theo sơ đồ`;
        break;
      }
      states = close(next);
      last = { id: event.row.activity, end: event.end };
    }
    if (!message) {
      const done = states.some((state) => state.length === 0);
      const endSeen = events.some((event) =>
        graph.nodes.some((n) => n.kind === "end" && n.label === event.row.activity),
      );
      if (hasEnd && !endSeen) message = `không tới điểm kết thúc (dừng sau «${last?.id ?? "?"}»)`;
      else if (!done) message = "còn nhánh chưa hoàn tất khi kết thúc (thiếu bước song song?)";
    }
    if (!message) message = resourceIssue(graph, raw, sem);
    if (!message) message = busy.get(caseId) ?? "";
    if (!message) message = repeatIssue(graph, raw, sem);
    if (message) errors.push({ caseId, message });
    else valid += 1;
  }
  return { total: byCase.size, valid, errors, warnings: hasEnd ? [] : ["mô hình thiếu điểm kết thúc"] };
}

const WORKS = new Set(["task", "user", "service"]);

// Resource checks: performer belongs to the step's role pool; customer steps done by the case's customer.
function resourceIssue(graph: SimGraph, rows: LogRow[], sem: Semantics): string {
  const roleOf = new Map(graph.nodes.filter((n) => WORKS.has(n.kind)).map((n) => [n.label, n.role]));
  const customer = rows[0]?.customer ?? "";
  for (const row of rows) {
    const role = roleOf.get(row.activity);
    if (role === undefined) continue;
    if (sem.customerRole && role === sem.customerRole) {
      if (row.resource !== customer) return `«${row.activity}» do ${row.resource} làm, nhưng khách của hồ sơ là ${customer || "?"}`;
      continue;
    }
    const pool = sem.roles[role];
    if (pool?.length && !pool.includes(row.resource)) return `«${row.activity}» do ${row.resource || "?"} làm, không thuộc nhóm «${role}»`;
  }
  return "";
}

// One person cannot do two activities at once (customers and unlimited roles are exempt).
function overlaps(graph: SimGraph, rows: LogRow[], sem: Semantics) {
  const roleOf = new Map(graph.nodes.filter((n) => WORKS.has(n.kind)).map((n) => [n.label, n.role]));
  const byPerson = new Map<string, LogRow[]>();
  for (const row of rows) {
    const role = roleOf.get(row.activity);
    if (role === undefined || !row.resource || role === sem.customerRole || sem.unlimited?.includes(role)) continue;
    byPerson.set(row.resource, [...(byPerson.get(row.resource) ?? []), row]);
  }
  const out = new Map<string, string>();
  for (const [person, list] of byPerson) {
    list.sort((a, b) => stamp(a.start) - stamp(b.start));
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1]!;
      const cur = list[i]!;
      if (stamp(cur.start) < stamp(prev.end) && !out.has(cur.caseId))
        out.set(cur.caseId, `${person} làm «${cur.activity}» (hồ sơ ${cur.caseId}) trùng giờ với «${prev.activity}» (hồ sơ ${prev.caseId})`);
    }
  }
  return out;
}

// A step may appear twice in a case only if it is marked as rework or sits on a BPMN loop.
function repeatIssue(graph: SimGraph, rows: LogRow[], sem: Semantics): string {
  const next = new Map<string, string[]>();
  for (const f of graph.flows) next.set(f.source, [...(next.get(f.source) ?? []), f.target]);
  const onLoop = (id: string) => {
    const seen = new Set<string>();
    const stack = [...(next.get(id) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === id) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(next.get(cur) ?? []));
    }
    return false;
  };
  const count = new Map<string, number>();
  for (const row of rows) count.set(row.activity, (count.get(row.activity) ?? 0) + 1);
  for (const [label, n] of count) {
    if (n < 2 || (sem.rework && label in sem.rework) || !sem.rework) continue;
    const ids = graph.nodes.filter((node) => node.label === label).map((node) => node.id);
    if (ids.length > 1 || ids.some(onLoop)) continue;
    return `«${label}» lặp ${n} lần nhưng không phải bước làm lại và không nằm trong vòng lặp`;
  }
  return "";
}
