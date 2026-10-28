import type { BranchStat, PaceBar, RunResult, StepStat } from "@/lib/bpmn/sim";

function Meter({ share, strong }: { share: number; strong: boolean }) {
  return (
    <span className="relative block h-3 overflow-hidden rounded-sm bg-line">
      <span
        className={strong ? "absolute inset-y-0 left-0 rounded-sm bg-ink" : "absolute inset-y-0 left-0 rounded-sm bg-muted"}
        style={{ width: `${Math.max(2, Math.min(100, share))}%` }}
      />
    </span>
  );
}

export function StepBars({ steps, hint }: { steps: StepStat[]; hint: string }) {
  if (!steps.length) return null;
  const top = steps[0]?.label;
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-sm text-muted">{hint}</figcaption>
      <div className="flex flex-col gap-2">
        {steps.map((step) => (
          <div key={step.label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-sm">
            <span className="truncate">{step.label}</span>
            <Meter share={step.share} strong={step.label === top} />
            <span className="text-muted">{step.share}%</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

export function PaceColumns({ pace, hint }: { pace: PaceBar[]; hint: string }) {
  const max = Math.max(...pace.map((bar) => bar.count), 1);
  if (pace.length < 2) return null;
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-sm text-muted">{hint}</figcaption>
      <div className="flex h-16 items-end gap-1" aria-hidden="true">
        {pace.map((bar) => (
          <span key={bar.label} className="flex h-full flex-1 items-end">
            <span className="block w-full rounded-sm bg-ink" style={{ height: `${Math.max(6, (bar.count / max) * 100)}%` }} />
          </span>
        ))}
      </div>
      <div className="flex justify-between text-sm text-muted">
        <span>{pace[0]?.label}</span>
        <span>{pace[pace.length - 1]?.label}</span>
      </div>
    </figure>
  );
}

export function BranchSplit({ branches, hint }: { branches: BranchStat[]; hint: string }) {
  if (!branches.length) return null;
  const groups = new Map<string, BranchStat[]>();
  for (const branch of branches) {
    const list = groups.get(branch.gateway) ?? [];
    list.push(branch);
    groups.set(branch.gateway, list);
  }
  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="text-sm text-muted">{hint}</figcaption>
      {[...groups.entries()].map(([gateway, parts]) => (
        <div key={gateway} className="flex flex-col gap-2">
          <p className="text-sm font-medium">{gateway}</p>
          <div className="flex h-8 overflow-hidden rounded-sm border border-line" aria-hidden="true">
            {parts.map((part, index) => (
              <span
                key={part.label}
                className={index % 2 === 0 ? "block h-full bg-ink" : "block h-full bg-muted"}
                style={{ width: `${Math.max(part.share, 0)}%` }}
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {parts.map((part, index) => (
              <li key={part.label} className="flex items-center gap-2">
                <span className={index % 2 === 0 ? "inline-block size-3 bg-ink" : "inline-block size-3 bg-muted"} />
                {part.label} {part.share}%
              </li>
            ))}
          </ul>
        </div>
      ))}
    </figure>
  );
}

export function CompareBars({
  runs,
  hint,
  unit,
}: {
  runs: RunResult[];
  hint: string;
  unit: string;
}) {
  if (runs.length < 2) return null;
  const max = Math.max(...runs.map((run) => run.avgMinutes), 1);
  return (
    <figure className="mt-3 flex flex-col gap-2">
      <figcaption className="text-sm text-muted">{hint}</figcaption>
      <div className="flex flex-col gap-2">
        {runs.map((run, index) => (
          <div key={run.scenario} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-sm">
            <span className="truncate">{run.scenario}</span>
            <Meter share={(run.avgMinutes / max) * 100} strong={index === 0} />
            <span className="text-muted">
              {run.avgMinutes} {unit}
            </span>
          </div>
        ))}
      </div>
    </figure>
  );
}
