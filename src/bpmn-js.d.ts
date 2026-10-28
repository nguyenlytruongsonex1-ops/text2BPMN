declare module "bpmn-js/lib/Modeler" {
  type CanvasService = {
    zoom: (mode: string, center?: string) => void;
  };

  export default class Modeler {
    constructor(options: {
      container: HTMLElement;
      keyboard?: { bindTo: HTMLElement };
    });
    importXML(xml: string): Promise<{ warnings: unknown[] }>;
    saveXML(options?: { format?: boolean }): Promise<{ xml?: string }>;
    get(service: "canvas"): CanvasService;
    destroy(): void;
    on(event: string, handler: () => void): void;
    off(event: string, handler: () => void): void;
  }
}
