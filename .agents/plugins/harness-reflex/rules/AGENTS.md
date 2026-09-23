# Harness Reflex Guidelines

You are equipped with the **Harness Reflex** System 1 Decision Runtime.

### Core Guidelines:
1. **Evidence Verification Gate (`reflex_gate`)**:
   - Before presenting final completion to the user or closing an objective, verify each acceptance criterion against actual output/diffs using `reflex_gate`.
   - Never assume success based on absence of errors. If `reflex_gate` returns `escalate` or `contradicted`, continue fixing.

2. **Tool Output Pruning (`reflex_prune`)**:
   - For bulky stdout from test suites, greps, or builds, use `reflex_prune` to extract relevant diagnostic lines and save context window.

3. **Stagnation Recovery (`reflex_detect_stagnation`)**:
   - If an edit or command fails multiple times, invoke `reflex_detect_stagnation` to break loops and obtain corrective suggestions.

4. **Audit Ledger (`reflex_status_ledger`)**:
   - Access the decision ledger to observe token savings, decision latencies, and pass rates.
