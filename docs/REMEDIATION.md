# Remediation (DEEL 2)

The bounded action framework behind the *Recommended actions* view. This is
a foundation, deliberately small: one allowlisted action, recommendation-only
by default, with preflight, confirmation, verification, cooldown, attempt
caps and a full audit trail. **Automatic execution does not exist in this
phase** — every execution is an explicit, authenticated, confirmed manual
action (brief §41/§48).

---

## The action model

```text
registered action id  →  resolved server-side target  →  preflight
   →  audit row (requested)  →  execution via an official route
   →  running  →  verifying  →  succeeded | failed | partially-recovered
```

- **`restart-managed-service`** is the only registered action. There is no
  shell execution, no arbitrary URL, no arbitrary target (§37): the server
  resolves the target against DUMB's own managed registry — the client posts
  only a target name, and unknown names are rejected (§56).
- **The route is DUMB's own**: `POST /api/process/restart-service`
  `{process_name}`, bearer-authenticated — the official single-service
  management path. It is not a container restart and touches no other service
  (§38/§39). DUMB itself may defer the restart (its media-protection), which
  is exactly why verification exists.

## Preflight (§40)

Checked before anything is requested:

- target is a managed DUMB service;
- target is currently running;
- no restart already pending for the target;
- cooldown expired;
- attempt count under the cap;
- active acquisition/import work visibility — when reliable, detected work is
  shown as a risk hint on the confirmation.

A failed preflight records the action as `rejected` with the reasons — the
audit row is the product.

## Confirmation (§42)

The UI modal states exactly what will happen ("Only this managed service will
be restarted"), shows the current evidence lines behind the recommendation
(memory now/typical/6 h delta), and notes that DUMBscope will verify
recovery afterwards.

## Verification — HTTP 200 is acceptance, not success (§43-§45)

After DUMB accepts a restart the action moves to `running` → `verifying`.
`running` is *executed and accepted*, never success. The hub's housekeeping
pass verifies the post-conditions from live telemetry: the process is back
(`runState=running`, no pending restart) with its PID and RSS reported —
memory evidence for the memory-restart case. Verification must land within
the window, otherwise the action ends `partially-recovered` — recovery
unproven, never silently successful.

## Cooldown and attempt caps (§46/§47)

- **6 hours per target**: a restart cycle plus meaningful re-growth
  observation spans hours (the DEEL-1 memory anomalies build over ~6 h), so a
  shorter cooldown would just hide a recurring leak.
- **2 attempts per 24 h**, after which the target is *suspended*: "automatic
  recovery suspended — manual investigation required" semantics, surfaced as
  `suspended` in the action view.

## Crash recovery (§59)

Rows stuck in `requested`/`running`/`verifying` when DUMBscope restarts are
re-evaluated on boot against live target state — succeeded if verification
passes, `partially-recovered` for lost executions, `failed` for orphaned
requests. Nothing stays "running" forever.

## Security (§55-§58)

- Admin session required; same-origin enforced by the global hook for POSTs.
- Rate limited per user (5/min).
- Allowlisted action kinds; targets resolved server-side from DUMB discovery.
- One action per target at a time — a duplicate in-flight request is rejected
  with 409 semantics.
- Full audit trail per action: actor, trigger, evidence, target, requestedAt,
  executedAt, verification, result.

## Automatic recovery policy (§48-§52)

**Off.** No automatic rule executes anything in this phase. The two candidate
auto rules (sustained memory anomaly; mount-managed service unresponsive) are
the first candidates for a future phase and already have their evidence and
verification plumbing — but enabling them requires the exact safe-route
proofs that phase must produce (§48). DUMBscope does not block, cancel or
re-trigger any media request — media correlation is detect + explain only
(§35/§61/§62).
