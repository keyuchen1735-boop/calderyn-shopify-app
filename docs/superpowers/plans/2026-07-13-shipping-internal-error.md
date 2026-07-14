# Shipping Internal Error Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the Shipping dashboard by making its city dataset traceable into the Vercel serverless bundle.

**Architecture:** Keep PR #460's UI and route model unchanged. Replace the runtime `createRequire()` with a static server import so Vercel includes `world-cities-json` in the deployed function.

**Tech Stack:** TypeScript, Vite, Vercel Functions, Vitest

## Global Constraints

- Do not change route-map behavior or customer data handling.
- Do not add dependencies; `world-cities-json` is already installed.
- Keep the dataset server-only.

---

### Task 1: Make the city dataset deployable

**Files:**
- Modify: `app/lib/shipping/city-centroids.server.ts`
- Modify: `app/lib/shipping/__tests__/city-centroids.server.test.ts`

**Interfaces:**
- Consumes: `WorldCitiesJsonModule.cities`.
- Produces: unchanged `resolveCityCentroid()` behavior with a statically traceable dataset import.

- [ ] **Step 1: Add a failing source-contract test**

Assert that the server module statically imports `world-cities-json` and does not call `createRequire()`.

- [ ] **Step 2: Verify RED**

Run: `npm test -- app/lib/shipping/__tests__/city-centroids.server.test.ts`

Expected: FAIL because the module currently loads the package dynamically.

- [ ] **Step 3: Implement the minimal fix**

Import the dataset module statically and return its existing `cities` array.

- [ ] **Step 4: Verify GREEN and production gates**

Run the focused Shipping tests, full test suite, typecheck, lint, production build, and client-bundle verification.

- [ ] **Step 5: Commit and deploy**

Commit the two source files and this plan, push the branch, merge the PR, then confirm the production Shipping API no longer logs `MODULE_NOT_FOUND`.
