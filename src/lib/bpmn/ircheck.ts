// Structural checks on the text IR. Messages are precise and fed back to the LLM in the input's language.
import type { Lang } from "./lang";

const KINDS = new Set(["start", "end", "task", "user", "service", "xor", "and", "or"]);
const GATEWAYS = new Set(["xor", "and", "or"]);

export type Step = { id: string; kind: string; label: string; lane: string | null };

const MSG = {
  vi: {
    undeclared: (line: number, src: string, dst: string, ref: string) =>
      `Dòng ${line}: luồng ${src} -> ${dst} dùng mã «${ref}» chưa được khai báo; khai báo bước/gateway này hoặc nối tới mã đã có.`,
    starts: (n: number) =>
      `Cần đúng một start, đang có ${n}. Dùng một start, rồi một xor "Loại tình huống?" chia tới từng tình huống khởi đầu (các start cũ thành task).`,
    branch: (s: string, n: number) =>
      `Bước ${s} có ${n} luồng ra; chỉ gateway mới được rẽ nhánh. Nối bước này tới MỘT xor (chọn một nhánh) hoặc and (song song), rồi rẽ từ gateway đó.`,
    deadEnd: (s: string) => `Bước ${s} không có luồng ra; mọi nhánh phải nối tới một end.`,
    endOut: (s: string) => `End ${s} không được có luồng ra.`,
    xorJoin: (x: string, j: string) =>
      `xor ${x} chọn MỘT nhánh nhưng các nhánh của nó gộp lại ở and ${j}; việc song song phải tách bằng and (and tách -> các việc -> and gộp), còn xor chỉ dùng cho lựa chọn loại trừ.`,
    parMerge: (t: string, a: string) =>
      `Bước ${t} nhận trực tiếp nhiều nhánh song song của and ${a}; thêm một and gộp trước ${t} (các nhánh -> and gộp -> ${t}).`,
  },
  en: {
    undeclared: (line: number, src: string, dst: string, ref: string) =>
      `Line ${line}: flow ${src} -> ${dst} uses code «${ref}» that is not declared; declare that step/gateway or link to an existing code.`,
    starts: (n: number) =>
      `Exactly one start is required, found ${n}. Use one start, then one xor "Which case?" that splits to each entry case (turn the old starts into tasks).`,
    branch: (s: string, n: number) =>
      `Step ${s} has ${n} outgoing flows; only gateways may branch. Link this step to ONE xor (choose one branch) or and (parallel), then branch from that gateway.`,
    deadEnd: (s: string) => `Step ${s} has no outgoing flow; every branch must reach an end.`,
    endOut: (s: string) => `End ${s} must not have outgoing flows.`,
    xorJoin: (x: string, j: string) =>
      `xor ${x} chooses ONE branch but its branches meet again at and ${j}; parallel work must use an and split (and split -> tasks -> and join); xor is only for exclusive choices.`,
    parMerge: (t: string, a: string) =>
      `Step ${t} directly receives several parallel branches of and ${a}; add an and join before ${t} (branches -> and join -> ${t}).`,
  },
} as const;

export function parseIr(ir: string) {
  const steps = new Map<string, Step>();
  const flows: { src: string; dst: string; line: number }[] = [];
  ir.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    const flow = line.match(/^([A-Za-z0-9_]+)\s*->\s*([A-Za-z0-9_]+)/);
    if (flow) {
      flows.push({ src: flow[1]!, dst: flow[2]!, line: index + 1 });
      return;
    }
    const decl = line.match(/^(\w+)\s+([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"(?:\s+lane\s+"((?:[^"\\]|\\.)*)")?/);
    if (decl && KINDS.has(decl[1]!.toLowerCase()))
      steps.set(decl[2]!, { id: decl[2]!, kind: decl[1]!.toLowerCase(), label: decl[3]!, lane: decl[4] ?? null });
  });
  return { steps, flows };
}

export function checkIr(ir: string, lang: Lang = "vi"): string[] {
  const m = MSG[lang];
  const { steps, flows } = parseIr(ir);
  const errors: string[] = [];
  const name = (id: string) => `«${steps.get(id)?.label ?? id}» (${id})`;
  const outs = new Map<string, string[]>();
  const ins = new Map<string, number>();
  for (const f of flows) {
    for (const ref of [f.src, f.dst]) if (!steps.has(ref)) errors.push(m.undeclared(f.line, f.src, f.dst, ref));
    if (!steps.has(f.src) || !steps.has(f.dst)) continue;
    outs.set(f.src, [...(outs.get(f.src) ?? []), f.dst]);
    ins.set(f.dst, (ins.get(f.dst) ?? 0) + 1);
  }
  const starts = [...steps.values()].filter((s) => s.kind === "start");
  if (starts.length !== 1) errors.push(m.starts(starts.length));
  const rawOuts = (id: string) => new Set(flows.filter((f) => f.src === id).map((f) => f.dst)).size;
  for (const step of steps.values()) {
    const n = rawOuts(step.id);
    if (!GATEWAYS.has(step.kind) && n > 1) errors.push(m.branch(name(step.id), n));
    if (step.kind !== "end" && n === 0) errors.push(m.deadEnd(name(step.id)));
    if (step.kind === "end" && n > 0) errors.push(m.endOut(name(step.id)));
  }
  // Branch reach sets: from each outgoing flow of a gateway, stop at and-joins.
  const reachFrom = (gate: string, start: string, stopAtJoin: boolean) => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur) || cur === gate) continue;
      seen.add(cur);
      const st = steps.get(cur);
      if (stopAtJoin && st?.kind === "and" && (ins.get(cur) ?? 0) > 1) continue;
      stack.push(...(outs.get(cur) ?? []));
    }
    return seen;
  };
  for (const step of steps.values()) {
    const targets = outs.get(step.id) ?? [];
    if (targets.length < 2) continue;
    if (step.kind === "xor") {
      const reach = targets.map((t) => reachFrom(step.id, t, false));
      for (const join of steps.values()) {
        if (join.kind !== "and" || (ins.get(join.id) ?? 0) < 2) continue;
        if (reach.filter((r) => r.has(join.id)).length >= 2) {
          errors.push(m.xorJoin(name(step.id), name(join.id)));
          break;
        }
      }
    }
    if (step.kind === "and") {
      // Parallel branches must meet in an and join, not directly in a task/end/xor.
      const reach = targets.map((t) => reachFrom(step.id, t, true));
      for (const node of steps.values()) {
        if (node.kind === "and" || (ins.get(node.id) ?? 0) < 2) continue;
        if (reach.filter((r) => r.has(node.id)).length >= 2) {
          // only flag the first meeting point: its direct predecessors come from different branches
          const preds = flows.filter((f) => f.dst === node.id).map((f) => f.src);
          const fromBranches = new Set(preds.map((p) => reach.findIndex((r) => r.has(p) || p === step.id)).filter((i) => i >= 0));
          if (fromBranches.size >= 2) {
            errors.push(m.parMerge(name(node.id), name(step.id)));
            break;
          }
        }
      }
    }
  }
  return errors;
}

// Safety net: several start events -> one start + xor; old starts become tasks.
export function mergeStarts(ir: string, lang: Lang = "vi"): string {
  const { steps } = parseIr(ir);
  const starts = [...steps.values()].filter((s) => s.kind === "start");
  if (starts.length < 2) return ir;
  const lane = starts[0]!.lane ? ` lane "${starts[0]!.lane}"` : "";
  const [startLabel, question] = lang === "vi" ? ["Bắt đầu", "Loại tình huống?"] : ["Start", "Which case?"];
  const ids = new Set(starts.map((s) => s.id));
  const lines = ir.split(/\r?\n/).map((line) => {
    const decl = line.trim().match(/^start\s+([A-Za-z0-9_]+)\s/);
    return decl && ids.has(decl[1]!) ? line.replace(/^(\s*)start\b/, "$1task") : line;
  });
  const firstStep = lines.findIndex((l) => /^\s*(start|end|task|user|service|xor|and|or)\s/i.test(l));
  lines.splice(firstStep < 0 ? lines.length : firstStep, 0, `start s_auto "${startLabel}"${lane}`, `xor g_auto_start "${question}"${lane}`);
  lines.push("s_auto -> g_auto_start", ...starts.map((s) => `g_auto_start -> ${s.id} "${s.label.replace(/"/g, '\\"')}"`));
  return lines.join("\n");
}
