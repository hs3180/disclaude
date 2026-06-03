#!/usr/bin/env node
/**
 * Unit tests for loadRuntimeEnv / saveRuntimeEnv in scan.mjs
 *
 * Since these functions are module-scoped (not exported), we extract them
 * into a self-contained test using Node's built-in test runner.
 *
 * Run: node --test scan.runtime-env.test.mjs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Inline copies of loadRuntimeEnv / saveRuntimeEnv for isolated testing.
// These must be kept in sync with scan.mjs.
// ---------------------------------------------------------------------------

function loadRuntimeEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf-8");
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      let val = trimmed.slice(eq + 1).trim();
      // Strip one layer of surrounding double or single quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[trimmed.slice(0, eq).trim()] = val;
    }
  }
  return env;
}

function saveRuntimeEnv(filePath, env) {
  const lines = Object.entries(env).map(([k, v]) => {
    const needsQuotes = v.includes(" ");
    return needsQuotes ? `${k}="${v}"` : `${k}=${v}`;
  });
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadRuntimeEnv", () => {
  let tmpDir;
  let envPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-runtime-env-test-"));
    envPath = path.join(tmpDir, ".runtime-env");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty object when file does not exist", () => {
    assert.deepStrictEqual(loadRuntimeEnv(envPath), {});
  });

  it("reads KEY=VALUE pairs", () => {
    fs.writeFileSync(envPath, "GH_TOKEN=ghs_abc\nAWS_KEY=AKIAxyz\n");
    assert.deepStrictEqual(loadRuntimeEnv(envPath), {
      GH_TOKEN: "ghs_abc",
      AWS_KEY: "AKIAxyz",
    });
  });

  it("ignores comments and blank lines", () => {
    fs.writeFileSync(envPath, "# comment\n\nGH_TOKEN=ghs_abc\n# another\nAWS_KEY=AKIAxyz\n");
    assert.deepStrictEqual(loadRuntimeEnv(envPath), {
      GH_TOKEN: "ghs_abc",
      AWS_KEY: "AKIAxyz",
    });
  });

  it("trims whitespace around keys and values", () => {
    fs.writeFileSync(envPath, "  GH_TOKEN  =  ghs_abc  \n");
    assert.deepStrictEqual(loadRuntimeEnv(envPath), { GH_TOKEN: "ghs_abc" });
  });

  it("handles values with = sign", () => {
    fs.writeFileSync(envPath, "EQUATION=a=b=c\n");
    assert.deepStrictEqual(loadRuntimeEnv(envPath), { EQUATION: "a=b=c" });
  });

  it("strips double-quoted values", () => {
    fs.writeFileSync(envPath, 'KEY="value with spaces"\n');
    assert.deepStrictEqual(loadRuntimeEnv(envPath), { KEY: "value with spaces" });
  });

  it("strips single-quoted values", () => {
    fs.writeFileSync(envPath, "KEY='single quoted'\n");
    assert.deepStrictEqual(loadRuntimeEnv(envPath), { KEY: "single quoted" });
  });

  it("handles empty quoted values", () => {
    fs.writeFileSync(envPath, 'KEY=""\n');
    assert.deepStrictEqual(loadRuntimeEnv(envPath), { KEY: "" });
  });

  it("only strips one layer of quotes", () => {
    fs.writeFileSync(envPath, 'KEY=""nested""\n');
    assert.deepStrictEqual(loadRuntimeEnv(envPath), { KEY: '"nested"' });
  });

  it("does not strip mismatched quotes", () => {
    fs.writeFileSync(envPath, 'KEY="value\n');
    assert.deepStrictEqual(loadRuntimeEnv(envPath), { KEY: '"value' });
  });
});

describe("saveRuntimeEnv", () => {
  let tmpDir;
  let envPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-runtime-env-test-"));
    envPath = path.join(tmpDir, ".runtime-env");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes KEY=VALUE pairs", () => {
    saveRuntimeEnv(envPath, { GH_TOKEN: "ghs_abc" });
    assert.deepStrictEqual(loadRuntimeEnv(envPath), { GH_TOKEN: "ghs_abc" });
  });

  it("wraps values with spaces in double quotes on disk", () => {
    saveRuntimeEnv(envPath, { KEY: "value with spaces" });
    const content = fs.readFileSync(envPath, "utf-8");
    assert.ok(content.includes('KEY="value with spaces"'));
  });

  it("round-trips values with spaces", () => {
    saveRuntimeEnv(envPath, { KEY: "value with spaces", OTHER: "simple" });
    assert.deepStrictEqual(loadRuntimeEnv(envPath), { KEY: "value with spaces", OTHER: "simple" });
  });

  it("preserves simple values without quotes", () => {
    saveRuntimeEnv(envPath, { TOKEN: "ghs_abc123" });
    const content = fs.readFileSync(envPath, "utf-8");
    assert.ok(content.includes("TOKEN=ghs_abc123"));
    assert.ok(!content.includes('"ghs_abc123"'));
  });
});
