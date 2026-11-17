import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "../auth/middleware";
import { validateCheckInput, validateDescription, validateRequirements } from "./checker";
import type { CheckInput, CheckReport, Requirement } from "./checker-types";

export const extractRequirements = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { text?: unknown }) => ({ text: validateDescription(data?.text) }))
  .handler(async ({ data }) => {
    const { extractSourceRequirements } = await import("./checker.server");
    return extractSourceRequirements(data.text);
  });

export const runSemanticCheck = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: CheckInput) => validateCheckInput(data))
  .handler(async ({ data }) => {
    const { checkCandidate } = await import("./checker.server");
    return checkCandidate(data);
  });

export const runCheckerAblation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { text: string; xml: string; requirements: Requirement[] }) => {
    const checked = validateCheckInput({ ...data, strategy: "light", variant: "P0" });
    return { text: checked.text, xml: checked.xml, requirements: checked.requirements };
  })
  .handler(async ({ data }) => {
    const { checkerAblation } = await import("./checker.server");
    return checkerAblation(data);
  });

export const proposeSemanticRepair = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: { text: string; xml: string; requirements: Requirement[]; report: CheckReport }) => {
      const checked = validateCheckInput({ ...data, strategy: "strong", variant: "P2" });
      // A transport cap on the report prevents uncontrolled prompt size. Server verifies fingerprint.
      if (JSON.stringify(data.report).length > 80000)
        throw new Error("Checker report is too large.");
      return {
        text: validateDescription(checked.text),
        xml: checked.xml,
        requirements: validateRequirements(checked.requirements, checked.text),
        report: data.report,
      };
    },
  )
  .handler(async ({ data }) => {
    const { proposeRepair } = await import("./checker.server");
    return proposeRepair(data);
  });
