# Bounded Text2BPMN E2E pilot

Status: completed. 3/3 controlled synthetic fixtures completed.

Generator: qwen/qwen3.5-9b. Checkers: meta-llama/llama-3.1-8b-instruct and qwen/qwen3-32b, P0/P1/P2 on identical emitted BPMN snapshots. Provider fixed to DeepInfra, fallback disabled.

25 API calls; provider-reported cost $0.00409998; 1 calls with unknown cost. Unknown cost is not free. Token/latency/request settings are in api-usage.json, including generation retries and feature extraction. The $1 guard is conservative admission estimation, not a provider-side billing guarantee.

Scoped oracle comparison: 24 supported requirement/configuration rows, 20 exact verdict agreements, 6 rows outside oracle coverage. These are repeated judgments on only three sources, not independent examples or a global accuracy estimate. No model-superiority or statistical-significance claim.

The oracle inspects actual generated BPMN paths under explicit sequential/XOR assumptions. Exact-label mismatch, parsing warnings, cycles, data guards, concurrency and unsupported elements yield unknown; witnesses replay against actual sequence-flow IDs. It does not establish whole-model correctness or the correctness of text interpretation.

These are genuine outputs of the existing generator for controlled synthetic input, not mutations, PET, or a real-business dataset. No repair was performed in this first run; before/after repair benefit remains unmeasured. App/browser delivery is verified separately.

## Oracle implementation replay

The oracle implementation was corrected after the original paid process started: shared-end/alternative XOR merges and the translator's one-participant/no-message collaboration wrapper had been classified too conservatively. Replay permits only a single participant referencing the sole process, with no message flows; multiple pools/processes/message interaction remain unsupported. The original run did not freeze execution-source hashes at startup. These hashes are captured after the run for offline replay, not evidence of the source originally loaded. Only oracle outcomes and derived comparison/summary artifacts are recomputed; checker outputs, candidates, source requirements and billing are unchanged.

Replay timestamp: 2026-11-17T14:08:11.773Z. The generated candidates, paid checker judgments, prompts and API ledger were not rerun or reselected. Old oracle outcomes remain in oracle-replay-audit.json.
