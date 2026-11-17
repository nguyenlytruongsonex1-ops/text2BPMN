export type CheckerTier = "light" | "strong";
export type PromptVariant = "P0" | "P1" | "P2";
export type CheckStatus = "pass" | "fail" | "unknown";
export type Requirement = { id: string; sourceQuote: string; assertion: string };
export type Assessment = {
  requirementId: string;
  status: CheckStatus;
  explanation: string;
  evidence: string[];
};
export type CheckerRun = {
  tier: CheckerTier;
  variant: PromptVariant;
  model: string;
  provider: string | null;
  status: CheckStatus;
  assessments: Assessment[];
  error: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  effectiveModel?: string | null;
  promptVersion?: string;
  protocolVersion?: string;
  reasoningTokens?: number | null;
};
export type CheckInput = {
  text: string;
  xml: string;
  requirements: Requirement[];
  variant: PromptVariant;
  strategy: "light" | "strong" | "cascade";
};
export type CheckReport = {
  status: CheckStatus;
  runs: CheckerRun[];
  escalated: boolean;
  routingReason: string;
  scope: string;
  candidateFingerprint: string;
};
export type CheckerUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  provider: string | null;
  reasoningTokens?: number | null;
};
export type RequirementResult = {
  requirements: Requirement[];
  provenance: "llm-provisional";
  model: string;
  usage?: CheckerUsage;
};
export type RepairProposal = {
  xml: string;
  note: string;
  model: string;
  verified: false;
  usage?: CheckerUsage;
};
