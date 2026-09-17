# controller-dev-* — superseded, never pooled

The first development run of the controller-owned remediation experiment (`controller-dev-{winston,ethereum,eslint}-r{1,2,3}`, Drift `8a1b536d`). It was stopped after 24 of 27 trials (ESLint repetition 3 never started) because trials exposed product defects in the controller, which were fixed in #323 before the experiment was run again from scratch as `controller-dev2-*`:

- **Unrepairable when no editable file is named** (winston r3 and ethereumjs r1, generic): a type error in `node_modules/logform/index.d.ts` and unmet coverage thresholds name no editable file, so the controller stopped after one session instead of dispatching a repair that can request scope.
- **ESLint errors after warnings were never extracted** (ESLint r1, Drift): repair sessions saw only "lint failed".
- **A correct test migration was rejected as weakening** (ethereumjs r3, Drift): any removed assertion line counted, and the rejection then ended the loop without feedback.

Its comparison is kept as history in `eval/reports/agent/controller-dev-superseded.md`. Every trial here ran the defective controller; none describes the product that was measured.
