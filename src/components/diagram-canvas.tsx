import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type ModelerType from "bpmn-js/lib/Modeler";
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css";

export type DiagramHandle = {
  getXml: () => Promise<string | null>;
  fit: () => void;
};

export const DiagramCanvas = forwardRef<DiagramHandle, { xml: string; failLabel: string }>(function DiagramCanvas(
  { xml, failLabel },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const modelerRef = useRef<ModelerType | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const failRef = useRef(failLabel);
  failRef.current = failLabel;

  useImperativeHandle(ref, () => ({
    async getXml() {
      const modeler = modelerRef.current;
      if (!modeler) return xml;
      try {
        const saved = await modeler.saveXML({ format: true });
        return saved.xml ?? xml;
      } catch {
        return xml;
      }
    },
    fit() {
      modelerRef.current?.get("canvas").zoom("fit-viewport", "auto");
    },
  }));

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let modeler: ModelerType | null = null;

    void (async () => {
      const { default: BpmnModeler } = await import("bpmn-js/lib/Modeler");
      if (cancelled || !host.current) return;
      modeler = new BpmnModeler({ container: host.current });
      modelerRef.current = modeler;
      try {
        await modeler.importXML(xml);
        if (cancelled) return;
        setProblem(null);
        requestAnimationFrame(() => {
          if (!cancelled) modeler?.get("canvas").zoom("fit-viewport", "auto");
        });
      } catch (error) {
        if (!cancelled) {
          setProblem(error instanceof Error ? error.message : failRef.current);
        }
      }
    })();

    return () => {
      cancelled = true;
      modeler?.destroy();
      if (modelerRef.current === modeler) modelerRef.current = null;
    };
  }, [xml]);

  return (
    <div className="relative">
      <div className="diagram-frame overflow-hidden rounded-sm border border-line bg-sheet">
        <div ref={host} className="h-full w-full" />
      </div>
      {problem ? (
        <p className="absolute inset-x-4 top-4 rounded-sm border border-line bg-sheet px-3 py-2 text-sm text-ink">
          {problem}
        </p>
      ) : null}
    </div>
  );
});
