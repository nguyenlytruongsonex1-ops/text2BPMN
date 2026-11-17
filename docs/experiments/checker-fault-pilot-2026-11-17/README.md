# One verified injected order fault and bounded repair

Status: completed. 8 API calls; provider-reported cost $0.00174960; 1 unknown-cost calls. Unknown cost is not free.

Base source: order-sequence from the three-source controlled synthetic E2E pilot, not PET or a real-business dataset. The base passes the two tested properties only. Rewiring swaps Verify order and Dispatch order while preserving activity names and shape bounds. Both fixed requirements fail after mutation with sequence-flow-replayed witnesses. No target labels were inferred from a checker.

| Tier | Prompt | Overall judgment | Per-requirement judgments |
|---|---|---|---|
| light | P0 | fail | R1: unknown; R2: fail |
| light | P1 | unknown | R1: unknown; R2: unknown |
| light | P2 | pass | R1: pass; R2: pass |
| strong | P0 | fail | R1: fail; R2: fail |
| strong | P1 | fail | R1: fail; R2: fail |
| strong | P2 | fail | R1: fail; R2: fail |

This single injected fault demonstrates behavior on a known scoped violation, not recall on natural errors or statistical model superiority. The six configurations share the exact same mutant and source requirements.

Repair: Scoped oracle after repair: R1=pass, R2=pass. All original supported properties pass: true.

A proposal remains marked unverified in the application and is not automatically applied. Passing the two oracle assertions is not whole-model correctness; unknown/unsupported semantics are not certified. API settings, costs, timing, source hashes, original/mutated/repaired BPMN and all judgments are retained for audit. No paid reruns were used to select favorable outputs.
