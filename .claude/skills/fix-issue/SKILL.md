---
name: fix-issue
description: Fix issues systematically through root cause analysis, minimal test design, fix implementation, static checks, and testing. Use when debugging, resolving bugs, or implementing reported issues.
argument-hint: [issue-description]
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# Fix Issue Skill

Systematic issue resolution through a structured 6-step process that ensures thorough root cause analysis and verified fixes.

## When to Use This Skill

Use this skill when:
- Debugging a bug or error in the codebase
- Resolving a reported issue (GitHub issues, JIRA tickets, user reports)
- Fixing failing tests or build errors
- Addressing performance problems
- Investigating unexpected behavior

## Process Overview

```
1. Root Cause Analysis → 2. Minimal Test Design → 3. Fix Design →
4. Implementation → 5. Static Checks → 6. Testing → Verification
```

**💡 Tip**: Use `TodoWrite` to track progress through these steps. This helps maintain context and provides visibility into the debugging process.

---

## Step 1: Root Cause Analysis (分析根源问题)

**Goal**: Understand the problem deeply before attempting any fix.

### Actions

1. **Gather Context**
   - Read the issue description carefully
   - Examine error messages, stack traces, logs
   - Identify when the problem occurs (reproduction steps)

2. **Locate Related Code**
   - Use `Grep` to search for relevant functions/modules
   - Use `Glob` to find related test files
   - Use `Read` to examine the code
   - Check recent commits if this is a regression

3. **Understand Expected vs Actual Behavior**
   - What *should* happen?
   - What *actually* happens?
   - Where do they diverge?

4. **Formulate Hypothesis**
   - Identify the most likely root cause
   - Consider edge cases and assumptions

### Output

You should be able to complete this sentence:
> "The issue occurs because [root cause], which leads to [symptom] when [trigger condition]."

### Red Flags

- ❌ Don't skip understanding the expected behavior
- ❌ Don't fix symptoms without addressing root cause
- ❌ Don't assume without verifying

---

## Step 2: Minimal Test Design (设计最小测试方案)

**Goal**: Create a minimal, reproducible test case that validates the fix.

### Actions

1. **Design Reproduction Test**
   - Create a minimal code snippet that reproduces the issue
   - Include edge cases and boundary conditions
   - Ensure test is reliable (not flaky)

2. **Choose Test Type**
   - **Unit test**: For isolated function behavior
   - **Integration test**: For component interactions
   - **E2E test**: For full workflows (rarely needed for bug fixes)
   - **Manual test script**: For complex reproduction scenarios

3. **Write Test First** (TDD approach)
   - Write the test before fixing
   - Ensure test fails with current code
   - Test should pass after fix is applied

### Example Test Structure

```typescript
// Test for: "Function returns undefined when input is empty array"
describe('processData', () => {
  it('should handle empty arrays correctly', () => {
    const result = processData([]);
    expect(result).toEqual({ status: 'empty', count: 0 });
  });
});
```

### Output

A test case that:
- ✅ Reproduces the issue
- ✅ Is minimal and focused
- ✅ Currently fails
- ✅ Will pass after fix

---

## Step 3: Fix Design (设计修复方案)

**Goal**: Plan the fix before implementing.

### Actions

1. **Consider Multiple Approaches**
   - What are 2-3 possible ways to fix this?
   - What are the trade-offs?

2. **Select Best Approach**
   - Choose the minimal change that solves the root cause
   - Consider maintainability and performance
   - Avoid breaking changes if possible

3. **Plan Implementation**
   - Which files need to be modified?
   - What exact changes are needed?
   - Are there related code paths that need updates?

4. **Identify Risks**
   - What could break?
   - Where else is this code used?

### Output

A clear plan:
1. Change X in file Y
2. Update Z to handle edge case
3. Add validation for W

---

## Step 4: Implementation (开发)

**Goal**: Implement the fix as designed.

### Actions

1. **Make Changes**
   - Use `Edit` to modify existing code
   - Use `Write` for new files
   - Follow project code style and conventions

2. **Add Comments**
   - Explain non-obvious logic
   - Reference the issue being fixed
   - Document edge cases

3. **Keep Changes Minimal**
   - Only change what's necessary
   - Don't refactor unrelated code
   - One logical change per commit

### Code Example

```typescript
// Fix: Handle empty array case
function processData(items: Item[]): Result {
  // Edge case: empty input
  if (items.length === 0) {
    return { status: 'empty', count: 0 };
  }

  // Original logic
  return { status: 'success', count: items.length };
}
```

---

## Step 5: Static Checks (静态检查)

**Goal**: Ensure code quality before running tests.

### Actions

1. **Type Checking**
   ```bash
   npm run type-check
   ```

2. **Linting**
   ```bash
   npm run lint
   npm run lint:fix  # Auto-fix issues
   ```

3. **Build Verification**
   ```bash
   npm run build
   ```

4. **Code Review Checklist**
   - ✅ No TypeScript errors
   - ✅ No ESLint warnings
   - ✅ Builds successfully
   - ✅ Follows project conventions
   - ✅ Has appropriate comments

### Handle Failures

If static checks fail:
1. Fix type errors immediately
2. Address lint warnings
3. Re-run checks until all pass
4. Don't proceed to testing until checks pass

---

## Step 6: Testing (测试)

**Goal**: Verify the fix works and doesn't break anything else.

### Actions

1. **Run the Reproduction Test**
   ```bash
   npm test -- --testNamePattern="reproduction test name"
   ```
   - Should now pass
   - If it fails, return to Step 4

2. **Run Full Test Suite**
   ```bash
   npm test
   ```
   - Ensure no regressions
   - All existing tests still pass

3. **Manual Verification** (if applicable)
   - Test the fix in the running application
   - Verify with actual user workflow
   - Check related functionality

4. **Edge Case Testing**
   - Test boundary conditions
   - Test with invalid inputs
   - Test with extreme values

### Success Criteria

- ✅ Reproduction test passes
- ✅ Full test suite passes
- ✅ No new warnings or errors
- ✅ Manual verification successful (if applicable)

---

## Common Patterns

### Debugging Failures

If tests fail after fix:

1. **Check Test First**
   - Is the test correct?
   - Is it testing the right thing?

2. **Check Fix**
   - Did you implement the planned change correctly?
   - Are there typos or syntax errors?

3. **Check Assumptions**
   - Was your root cause analysis correct?
   - Is there another factor at play?

4. **Iterate**
   - Go back to Step 1 if needed
   - Update your understanding
   - Adjust the fix

### Handling Side Effects

If fix breaks other tests:

1. **Understand the Breakage**
   - What depends on the old behavior?
   - Is the old behavior correct?

2. **Update Tests if Needed**
   - Sometimes tests need updating
   - Ensure tests validate correct behavior

3. **Consider Backward Compatibility**
   - Can you maintain both behaviors?
   - Is a breaking change acceptable?

### Debugging Environment-Specific Issues

When issue only occurs in specific environments:

**Dev vs Production:**
1. Check environment variable differences
2. Verify database/data state differences
3. Compare dependency versions
4. Review build artifacts (are they identical?)

**CI/CD Pipeline:**
1. Check CI environment variables and secrets
2. Verify build steps match local build
3. Review timing issues (CI might be slower)
4. Check for missing test data or fixtures

**Docker/Container:**
1. Verify container environment matches local
2. Check file permissions and volume mounts
3. Review network connectivity within container
4. Compare resource limits (CPU, memory)

**Quick environment diagnostic script:**
```bash
# Check environment differences
echo "Node version: $(node --version)"
echo "NPM version: $(npm --version)"
echo "Environment vars: $(env | grep -E 'NODE|API_' | wc -l)"
echo "Git status: $(git status --short)"
```

---

## Anti-Patterns to Avoid

### ❌ Rush to Fix
```
"I see the error, I'll just change this line..."
```
**Problem**: Fixing symptoms without understanding root cause

**Correct approach**:
```
"Let me analyze why this error occurs..."
```

### ❌ No Reproduction Test
```
"I'll fix it and test manually"
```
**Problem**: No reliable way to verify fix works

**Correct approach**:
```
"Let me write a test that reproduces this issue first..."
```

### ❌ Fix Everything
```
"While fixing this bug, I'll refactor this whole module..."
```
**Problem**: Too many changes, hard to verify

**Correct approach**:
```
"I'll fix only this specific issue. Refactoring can be separate."
```

### ❌ Skip Static Checks
```
"The tests pass, let's move on"
```
**Problem**: Type errors, linting issues, broken build

**Correct approach**:
```
"Tests pass, but let me run type-check and lint first..."
```

---

## Emergency Rollback Plan

When a fix makes things worse:

### 🚨 Immediate Actions

1. **Assess Severity**
   - Is production broken? (users affected)
   - Is data loss possible?
   - Can the system continue operating?

2. **Quick Rollback Options**

   **Git Revert** (if fix was already committed):
   ```bash
   # Revert the specific commit
   git revert <commit-hash>
   git push

   # Or reset if commit wasn't pushed
   git reset --hard HEAD~1
   ```

   **Manual Code Revert** (if no git available):
   - Use `Edit` to revert the specific changes
   - Rebuild: `npm run build`
   - Restart service: `npm run pm2:restart`

3. **Verify Rollback**
   - Check that the original issue doesn't reappear (or document known issue)
   - Verify system is operational
   - Run smoke tests if available

### 📋 Post-Mortem Steps

After rollback, analyze what went wrong:

1. **Why was the fix incorrect?**
   - Misunderstood root cause?
   - Introduced new bug?
   - Missing edge case?

2. **What should we do differently?**
   - Better testing in staging?
   - More comprehensive test coverage?
   - Different approach needed?

3. **Document the lesson**
   - Add comment to code about the pitfall
   - Update test cases to cover the scenario
   - Consider adding integration test

### 🛡️ Prevention Strategies

- **Always test in staging before production**
- **Use feature flags for risky changes**
- **Keep changes small and isolated**
- **Have monitoring/alerting in place**

---

## Example Workflow

**Issue**: "User gets error when uploading empty file"

### Step 1: Root Cause Analysis
```bash
# Find upload handler code
grep -r "upload" src/ --include="*.ts"

# Read the handler
cat src/upload/handler.ts

# Check error logs
pm2 logs --err
```
**Finding**: Handler crashes when file.size === 0

### Step 2: Minimal Test Design
```typescript
it('should reject empty files', async () => {
  const emptyFile = new File([], 'empty.txt');
  await expect(uploadFile(emptyFile)).rejects.toThrow('Empty file');
});
```

### Step 3: Fix Design
**Plan**: Add validation at handler entry point to check file.size

### Step 4: Implementation
```typescript
function uploadFile(file: File) {
  if (file.size === 0) {
    throw new Error('Empty file');
  }
  // ... rest of handler
}
```

### Step 5: Static Checks
```bash
npm run type-check  # ✅ Pass
npm run lint        # ✅ Pass
npm run build       # ✅ Pass
```

### Step 6: Testing
```bash
npm test -- upload.test  # ✅ Pass
npm test                 # ✅ All pass
```

**Result**: Issue resolved, verified with tests ✅

---

## Success Metrics

A successful fix is complete when:

- ✅ Root cause identified and documented
- ✅ Minimal test case written and passing
- ✅ Fix implemented with clear code
- ✅ All static checks passing
- ✅ Full test suite passing
- ✅ No regressions introduced
- ✅ Edge cases considered

---

## Constraints

1. **One Issue at a Time** - Don't fix multiple issues in one pass
2. **Minimal Changes** - Change only what's necessary
3. **Test First** - Write reproduction test before fixing
4. **Verify Thoroughly** - Don't skip static checks or full test suite
5. **Document as You Go** - Add comments explaining the fix
