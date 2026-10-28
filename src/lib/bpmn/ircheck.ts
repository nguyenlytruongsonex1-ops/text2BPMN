// Structural checks on the text IR before/after translation. Messages are Vietnamese, precise, and fed back to the LLM.
const KINDS = new Set(["start", "end", "task", "user", "service", "xor", "and", "or"]);
const GATEWAYS = new Set(["xor", "and", "or"]);

type Step = { id: string; kind: string; label: string };

export function checkIr(ir: string): string[] {
  const steps = new Map<string, Step>();
  const flows: { src: string; dst: string; line: number }[] = [];
  const errors: string[] = [];
  ir.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    const flow = line.match(/^([A-Za-z0-9_]+)\s*->\s*([A-Za-z0-9_]+)/);
    if (flow) {
      flows.push({ src: flow[1]!, dst: flow[2]!, line: index + 1 });
      return;
    }
    const decl = line.match(/^(\w+)\s+([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"/);
    if (decl && KINDS.has(decl[1]!.toLowerCase())) steps.set(decl[2]!, { id: decl[2]!, kind: decl[1]!.toLowerCase(), label: decl[3]! });
  });
  const name = (id: string) => `«${steps.get(id)?.label ?? id}» (${id})`;
  const outs = new Map<string, string[]>();
  const ins = new Map<string, number>();
  for (const f of flows) {
    for (const ref of [f.src, f.dst])
      if (!steps.has(ref)) errors.push(`Dòng ${f.line}: luồng ${f.src} -> ${f.dst} dùng mã «${ref}» chưa được khai báo; khai báo bước/gateway này hoặc nối tới mã đã có.`);
    if (!steps.has(f.src) || !steps.has(f.dst)) continue;
    outs.set(f.src, [...(outs.get(f.src) ?? []), f.dst]);
    ins.set(f.dst, (ins.get(f.dst) ?? 0) + 1);
  }
  const starts = [...steps.values()].filter((s) => s.kind === "start");
  if (starts.length !== 1) errors.push(`Cần đúng một start, đang có ${starts.length}.`);
  const rawOuts = (id: string) => new Set(flows.filter((f) => f.src === id).map((f) => f.dst)).size;
  for (const step of steps.values()) {
    const n = rawOuts(step.id);
    if (!GATEWAYS.has(step.kind) && n > 1)
      errors.push(`Bước ${name(step.id)} có ${n} luồng ra; chỉ gateway mới được rẽ nhánh (dùng xor nếu chọn một nhánh, and nếu làm song song).`);
    if (step.kind !== "end" && n === 0)
      errors.push(`Bước ${name(step.id)} không có luồng ra; mọi nhánh phải nối tới một end.`);
    if (step.kind === "end" && n > 0) errors.push(`End ${name(step.id)} không được có luồng ra.`);
  }
  // xor branches must be exclusive: they may not meet again at an 'and' join (that would deadlock).
  for (const step of steps.values()) {
    const targets = outs.get(step.id) ?? [];
    if (step.kind !== "xor" || targets.length < 2) continue;
    const reach = targets.map((t) => {
      const seen = new Set<string>();
      const stack = [t];
      while (stack.length) {
        const cur = stack.pop()!;
        if (seen.has(cur) || cur === step.id) continue;
        seen.add(cur);
        stack.push(...(outs.get(cur) ?? []));
      }
      return seen;
    });
    for (const join of steps.values()) {
      if (join.kind !== "and" || (ins.get(join.id) ?? 0) < 2) continue;
      if (reach.filter((r) => r.has(join.id)).length >= 2) {
        errors.push(
          `xor ${name(step.id)} chọn MỘT nhánh nhưng các nhánh của nó gộp lại ở and ${name(join.id)}; việc song song phải tách bằng and (and tách -> các việc -> and gộp), còn xor chỉ dùng cho lựa chọn loại trừ.`,
        );
        break;
      }
    }
  }
  return errors;
}
