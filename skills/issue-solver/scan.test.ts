// Regression guard for the scan.mjs phantom-filter reference extraction.
//
// Issue #4376 (part 1): standalone deliverable = lock in regression test cases
// that keep legitimately-open epics in the candidate pool. The concern: any
// future "broadening" of shipped-work matching (e.g. #4373 direction #1 "any
// #N", or dropping the willCloseTarget requirement) would silently exclude
// open epics that merged part-series PRs mention purely as context/parent —
// the opposite of the phantom-pool problem, and harder to notice (missing
// candidates are invisible).
//
// Since #4499 (#4375 part 1), the phantom filter resolves per open issue via
// GitHub's authoritative closing links (timelineItems.willCloseTarget from a
// MERGED PR), replacing the capped merged-PR regex window. The guard therefore
// pins BOTH extraction surfaces of the current contract:
//  - extractShippedIssueNums: only a willCloseTarget link from a MERGED PR
//    marks an issue as shipped; context-only cross-refs never do.
//  - extractOpenPRRefs: keyword-prefixed refs + branch-name numbers.
// A future broadening PR either updates these expectations deliberately or
// fails CI loudly.
//
// #4373 part 2 adds titleMentionsIssue — the tiering heuristic behind the
// weak-ref advisory caveat's "likely shipped" vs "context-only" split. It is
// deliberately still advisory (no auto-exclusion), but the tier assignment is
// load-bearing for reader attention, so the boundary cases are pinned too.
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
import { extractOpenPRRefs, extractShippedIssueNums, titleMentionsIssue } from "./scan.mjs";

/** Cross-referenced event as shaped by GRAPHQL_QUERY's timelineItems nodes. */
const xref = (sourceNumber: number, state: string, willCloseTarget: boolean) => ({
  willCloseTarget,
  source: { number: sourceNumber, state },
});

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

describe("scan.mjs extractShippedIssueNums (#4499 per-issue willCloseTarget filter)", () => {
  // The three epics named in #4376's proof table (real-world refs reproduced
  // from the issue). #4168/#4039 are still OPEN; #4040 was closed 2026-07
  // out-of-band — by hand, not via any ref below (none carries
  // willCloseTarget). It stays in the fixture because the extractor reads only
  // this table's structure, not live issue state: context-only xrefs must not
  // mark an issue shipped regardless of what closed it since.
  const EPIC_CONTEXT_XREFS = [
    // #4168 (REST API to replace IPC, OPEN) ← the #4279 part-series merged PRs
    {
      number: 4168,
      timelineItems: {
        totalCount: 8,
        nodes: [4341, 4343, 4344, 4345, 4346, 4347, 4348, 4349].map((n) => xref(n, "MERGED", false)),
      },
    },
    // #4040 (Phase 1: loop skill, closed out-of-band — see above) ← loop part-series merged PRs
    {
      number: 4040,
      timelineItems: {
        totalCount: 6,
        nodes: [4232, 4239, 4277, 4286, 4287, 4243].map((n) => xref(n, "MERGED", false)),
      },
    },
    // #4039 (Loop System, OPEN) ← referenced by loop PRs as lineage
    {
      number: 4039,
      timelineItems: {
        totalCount: 2,
        nodes: [4232, 4277].map((n) => xref(n, "MERGED", false)),
      },
    },
  ];

  it("REGRESSION (#4376): context-only mentions of these epics are NOT shipped", () => {
    const refs = extractShippedIssueNums(EPIC_CONTEXT_XREFS);
    expect(refs.has(4168)).toBe(false);
    expect(refs.has(4040)).toBe(false);
    expect(refs.has(4039)).toBe(false);
  });

  it("marks an issue shipped only when a MERGED PR carries a will-close link", () => {
    const refs = extractShippedIssueNums([
      {
        number: 4001,
        timelineItems: { totalCount: 1, nodes: [xref(4002, "MERGED", true)] },
      },
    ]);
    expect(refs.has(4001)).toBe(true);
  });

  it("a will-close link from a still-OPEN PR is not shipped work yet", () => {
    const refs = extractShippedIssueNums([
      {
        number: 4001,
        timelineItems: { totalCount: 1, nodes: [xref(4002, "OPEN", true)] },
      },
    ]);
    expect(refs.has(4001)).toBe(false);
  });

  it("one will-close merged ref among many context refs still marks shipped (some() semantics)", () => {
    const refs = extractShippedIssueNums([
      {
        number: 4001,
        timelineItems: {
          totalCount: 3,
          nodes: [xref(4341, "MERGED", false), xref(4343, "MERGED", false), xref(4002, "MERGED", true)],
        },
      },
    ]);
    expect(refs.has(4001)).toBe(true);
  });

  it("tolerates issues without timelineItems (no crash, not shipped)", () => {
    const refs = extractShippedIssueNums([{ number: 4001 }, { number: 4002, timelineItems: {} }]);
    expect(refs.size).toBe(0);
  });

  it("warns via logFn when cross-ref events exceed the fetched window", () => {
    const warnings: string[] = [];
    extractShippedIssueNums(
      [
        {
          number: 4168,
          timelineItems: { totalCount: 150, nodes: Array.from({ length: 100 }, (_, i) => xref(4300 + i, "MERGED", false)) },
        },
      ],
      (msg: string) => warnings.push(msg),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("#4168");
    expect(warnings[0]).toContain("150");
  });

  it("does not warn when all cross-ref events fit the fetched window", () => {
    const warnings: string[] = [];
    extractShippedIssueNums(EPIC_CONTEXT_XREFS, (msg: string) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });
});

describe("scan.mjs titleMentionsIssue (#4373 part 2 advisory tiering)", () => {
  // Real titles, verbatim from the repo's merged-PR history. Tier 1 ("likely
  // shipped") is a weak-ref merged PR whose title carries the issue's own #N —
  // this repo's covering-PR convention. Tier 2 ("context-only") is epic
  // lineage: the title names a DIFFERENT issue's number.
  it("tier 1: covering-PR title conventions match their own issue number", () => {
    // "fix(message-builder): inject lark-cli self-service guidance by isTopicThread (#4402)"
    expect(titleMentionsIssue("fix(message-builder): inject lark-cli self-service guidance by isTopicThread (#4402)", 4402)).toBe(true);
    // "feat(config): agentBackend selector for agent SDK runtime (claude|pi), default claude (#4388 part 1)"
    expect(titleMentionsIssue("feat(config): agentBackend selector for agent SDK runtime (claude|pi), default claude (#4388 part 1)", 4388)).toBe(true);
    // "docs #4388 (part 2): pi backend (agentBackend) guide page"
    expect(titleMentionsIssue("docs #4388 (part 2): pi backend (agentBackend) guide page", 4388)).toBe(true);
  });

  it("tier 2: epic-lineage titles name a different issue's number, not the epic's", () => {
    // #4168's #4376-proof refs: part-series PRs titled after sub-issue #4279.
    expect(titleMentionsIssue("feat #4279 (part 1): add GET /api/ping REST health endpoint", 4168)).toBe(false);
    expect(titleMentionsIssue("feat #4280 (part 1): make isIpcAvailable REST-aware (probe REST /api/ping)", 4168)).toBe(false);
    // #4039's refs: loop PRs titled after #4193.
    expect(titleMentionsIssue("feat #4193 (part A): LOOP.md loop definition file — spec, parser, runner startFromLoopMd", 4039)).toBe(false);
  });

  it("does not prefix-match a longer number sharing the digits (#44 vs #440)", () => {
    expect(titleMentionsIssue("fix #4402: something", 44)).toBe(false);
    expect(titleMentionsIssue("fix #4402: something", 4402)).toBe(true);
  });

  it("does not match the number without a # prefix", () => {
    expect(titleMentionsIssue("fix 4402: plain digits are not refs", 4402)).toBe(false);
  });

  it("tolerates null/undefined/empty titles", () => {
    expect(titleMentionsIssue(undefined, 4402)).toBe(false);
    expect(titleMentionsIssue(null, 4402)).toBe(false);
    expect(titleMentionsIssue("", 4402)).toBe(false);
  });
});
