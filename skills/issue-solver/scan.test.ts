// Regression guard for the scan.mjs phantom-filter reference extraction.
//
// Issue #4376 (part 1): standalone deliverable = lock in regression test cases
// that keep legitimately-OPEN epics in the candidate pool. The concern: any
// future "broadening" of merged-PR matching (e.g. #4373 direction #1 "any #N",
// or subject-overlap heuristics) would silently exclude OPEN epics that merged
// part-series PRs mention purely as context/parent — the opposite of the
// phantom-pool problem, and harder to notice (missing candidates are invisible).
//
// These cases pin the CURRENT contract (closing-keyword-only matching), so a
// future broadening PR either updates these expectations deliberately or fails
// CI loudly. #4495 ("stop skipping part-N merged PRs", #4374) already changed
// this exact code, which is what makes the guard timely.
//
// Scope notes (why adding this file is safe — mirrors skills/channel/cli.test.ts,
// the precedent set by #4467):
//  - `npm run lint` only targets the packages source dirs, so this file is NOT
//    linted (no risk to the lint gate).
//  - root tsconfig has an empty `files` list + package references only, so
//    skills/ is NOT type-checked; importing a .mjs without type decls is fine.
//  - vitest.config.ts `include` covers `skills/**/*.test.ts`, so this DOES run.
//  - coverage `include` covers only `src` and `packages` ts files, so skills/ is
//    NOT measured — this test cannot drag the 70% coverage thresholds.
//  - scan.mjs is ESM with an entry guard (`isMainEntry`), so importing it here
//    does NOT trigger its `main()` (no GitHub auth, no network).

import { describe, it, expect } from "vitest";
// The extractors are pure functions exported from scan.mjs.
// @ts-expect-error — .mjs module has no type declarations; skills/ is not type-checked.
import { extractMergedClosingRefs, extractOpenPRRefs } from "./scan.mjs";

describe("scan.mjs extractOpenPRRefs", () => {
  it("covers keyword-prefixed mentions in body/title (work in progress)", () => {
    const refs = extractOpenPRRefs([
      { title: "wip: something", body: "Related #4168. Closes #4001 eventually." },
    ]);
    expect(refs.has(4168)).toBe(true);
    expect(refs.has(4001)).toBe(true);
  });

  it("covers branch-name numbers (fix/issue-123)", () => {
    const refs = extractOpenPRRefs([{ title: "", body: "", headRefName: "fix/issue-4168" }]);
    expect(refs.has(4168)).toBe(true);
  });

  it("does NOT cover bare #N without a keyword in body/title (but still via branch)", () => {
    const refs = extractOpenPRRefs([{ title: "see #4168 for context", body: "Refs #4039" }]);
    // No "related/closes/fix/resolve" prefix in body/title → not covered by keywords.
    expect(refs.has(4168)).toBe(false);
    expect(refs.has(4039)).toBe(false);
  });

  it("is case-insensitive across keyword variants", () => {
    const refs = extractOpenPRRefs([
      { title: "RELATED #10", body: "related #20\nFix #30" },
    ]);
    expect(refs.has(10)).toBe(true);
    expect(refs.has(20)).toBe(true);
    expect(refs.has(30)).toBe(true);
  });
});

describe("scan.mjs extractMergedClosingRefs", () => {
  // The three OPEN epics named in #4376. Each is referenced by multiple merged
  // part-series PRs purely as context/parent (real-world refs reproduced below).
  // None of these must be treated as "shipped".
  const EPIC_CONTEXT_MENTIONS = [
    // #4168 (REST API to replace IPC) — referenced by the #4279 part-series
    { title: "feat #4279 (part of #4168)", body: "Phase 2 part 1. Parent epic: #4168." },
    { title: "docs #4279", body: "Refs #4168." },
    // #4040 (Phase 1: loop skill) / #4039 (Loop System) — referenced by loop PRs
    { title: "chore #4232", body: "Refs #4039, parent #4040." },
    { title: "fix #4277 (part 1)", body: "Part of #4040 (and #4039 lineage)." },
  ];

  it("REGRESSION (#4376): context-only mentions of OPEN epics are NOT covered", () => {
    const refs = extractMergedClosingRefs(EPIC_CONTEXT_MENTIONS);
    expect(refs.has(4168)).toBe(false);
    expect(refs.has(4040)).toBe(false);
    expect(refs.has(4039)).toBe(false);
  });

  it("covers explicit closing keywords even when a bare context mention of an epic is also present", () => {
    const refs = extractMergedClosingRefs([
      { title: "feat #4279 (part of #4168)", body: "Closes #4279. Parent epic #4168 stays open." },
    ]);
    expect(refs.has(4279)).toBe(true); // explicit closing keyword
    expect(refs.has(4168)).toBe(false); // epic mentioned as context only
  });

  it("covers closing keywords regardless of a 'part N' title (#4374/#4495: part-N PRs are not skipped)", () => {
    const refs = extractMergedClosingRefs([
      { title: "refactor #4192 (part 2)", body: "fixes #4192" },
      { title: "fix #4256 (part 2)", body: "" },
      { title: "fix #4169 (part 1)", body: "" },
    ]);
    expect(refs.has(4192)).toBe(true);
    expect(refs.has(4256)).toBe(true);
    expect(refs.has(4169)).toBe(true);
  });

  it("matches all closing-keyword variants, case-insensitively", () => {
    const refs = extractMergedClosingRefs([
      { title: "Close #1", body: "closed #2 CLOSED #3" },
      { title: "", body: "fix #4 fixes #5 fixed #6" },
      { title: "", body: "resolve #7 resolves #8 resolved #9" },
    ]);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(refs.has(n)).toBe(true);
    }
  });

  it("does NOT treat 'related'/'refs'/'see'/'part of' as closing (the regression guard core)", () => {
    const refs = extractMergedClosingRefs([
      { title: "Related #100", body: "refs #101 (see #102) — part of #103" },
    ]);
    for (const n of [100, 101, 102, 103]) {
      expect(refs.has(n)).toBe(false);
    }
  });

  it("requires the keyword immediately precede #N (no 'closes issue #N' phrasing match)", () => {
    // "closes issue #200" — there IS a word between keyword and #N; the regex
    // (keyword\s+#N) requires the #N right after the keyword. Confirm the
    // contract: such loose phrasing is NOT matched, so it cannot accidentally
    // hide an epic. (If GitHub's real semantics ever differ, update here.)
    const refs = extractMergedClosingRefs([{ title: "", body: "This closes issue #200." }]);
    expect(refs.has(200)).toBe(false);
  });
});
