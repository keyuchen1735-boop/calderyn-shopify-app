# Plan: Calderyn Calibration Slice 3 — Dashboard Reject + Learned Rules (Task 6)

Date: 2026-06-21
Branch: feat/calibration-foundation
Parity target: app/routes/app.queue.tsx (embedded, Task 5)

## Goal

Ship the dashboard-side parity for the Reject flow and Learned-rules view:
1. Merchant can reject a queued proposal with a reason (5 values) and optional note.
2. Server re-derives detector/action/impact from the TRUSTED alert; never the request body.
3. Server records the rejection (calibration signal); returns a plain-language reflection.
4. Reflection shown as a toast. Rejected proposal removed from local list.
5. "What Calderyn has learned" section lists active learned rules with an Undo button per rule.
6. Undo deactivates the rule and triggers a data refresh.

## Files Changed

New routes:
- app/routes/dashboard.api.queue.reject.tsx - POST {alertId, reason, note?} to {reflection}
- app/routes/dashboard.api.calibration.rules.tsx - GET to {rules}; POST {ruleId} to {ok}

Updated:
- app/components/dashboard/view-models.ts - add LearnedRuleVM
- app/components/dashboard/context.ts - add learnedRules: LearnedRuleVM[] to DashboardCtx
- app/lib/dashboard/client.ts - add rejectProposal, fetchLearnedRules, undoRule
- app/components/dashboard/DashboardApp.tsx - wire learnedRules state + load + ctx
- app/components/dashboard/screens/ActionQueue.tsx - Reject picker + reflection toast + LearnedRulesSection

Test fixtures patched:
- app/components/dashboard/screens/__tests__/audit-recovered.test.ts
- app/components/dashboard/screens/__tests__/dashboard-greeting.test.ts
- app/components/dashboard/screens/__tests__/dashboard-stat-row.test.ts

## Key design decisions

Route split: Separate reject route (/dashboard/api/queue/reject) and rules route
(/dashboard/api/calibration/rules) cleanest, minimal coupling, mirrors the embedded
surface's intent vs list separation.

Re-derivation: The reject route calls client.alerts.get(alertId) server-side, then
uses recommendedAction(detector, {hasCampaign}) identical to the embedded action.
No detector/action/impact from the request body.

NEVER execute: The reject route only calls client.calibration.recordRejection(...).
It does not touch executeAction, executeAlertAction, or any campaign endpoint.

Optimistic removal: On successful reject, the proposal is removed from local state
immediately (same UX as Polaris embedded). No full refresh needed.

Undo rule: Calls undoRule then app.refresh() so the parent reloads the full
dataset (learned rules + action queue) without the stale rule.

## Steps

1. Create dashboard.api.queue.reject.tsx (auth + validate + re-derive + recordRejection)
2. Create dashboard.api.calibration.rules.tsx (GET list / POST undo)
3. Add LearnedRuleVM to view-models.ts
4. Add rejectProposal, fetchLearnedRules, undoRule to client.ts
5. Add learnedRules to DashboardCtx, wire state + load in DashboardApp.tsx
6. Rewrite ActionQueue.tsx with Reject picker + RejectPanel + LearnedRulesSection
7. Patch 3 test fixtures with learnedRules: []
8. Gate: typecheck / lint / build / test (full suite)
9. Commit
