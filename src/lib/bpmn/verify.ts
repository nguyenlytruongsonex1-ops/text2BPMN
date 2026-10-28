import type { LogRow, SimFlow, SimGraph } from "./sim";

export type VerifyError = { caseId: string; message: string };
export type VerifyResult = { total: number; valid: number; errors: VerifyError[] };

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
export function verifyLog(graph: SimGraph, rows: LogRow[]): VerifyResult {
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
      if (!endSeen) message = `không tới điểm kết thúc (dừng sau «${last?.id ?? "?"}»)`;
      else if (!done) message = "còn nhánh chưa hoàn tất khi kết thúc (thiếu bước song song?)";
    }
    if (message) errors.push({ caseId, message });
    else valid += 1;
  }
  return { total: byCase.size, valid, errors };
}
