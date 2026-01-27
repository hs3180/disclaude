---
name: implement-feature
description: Structured feature implementation with 5-phase process: refine objectives → plan → develop → static check → test. Use when implementing features, adding functionality, creating components, or requirements need clarification. Works autonomously without user interaction.
version: 2.2.0
argument-hint: [feature-description]
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, TaskOutput, KillShell, LSP, TodoWrite
context: fork
---

# Implement Feature

An automated skill for implementing software features from requirements to tested delivery.

## Overview

This skill autonomously implements software features through a structured process:
1. **Refine delivery objectives** - Analyze and clarify requirements from context
2. **Create implementation plan** - Design the technical approach
3. **Develop** - Write the code using Read, Write, Edit, Bash tools
4. **Static check** - Run linting, type checking, and format verification
5. **Test and iterate** - Verify against delivery objectives

## Instructions

Implementing feature: **$ARGUMENTS** (if provided)

Follow this 5-phase structured process **autonomously**:

### Phase 1: Refine Delivery Objectives

Analyze the requirements from available context:

1. **Understand the Context**
   - Read existing code files to understand the codebase
   - Analyze the problem to be solved
   - Identify success criteria

2. **Define Acceptance Criteria**
   - Create specific, measurable criteria
   - Define edge cases to handle
   - Identify constraints (performance, security, compatibility)

3. **Make Reasonable Assumptions**
   - If requirements are unclear, make sensible assumptions
   - Choose appropriate options based on best practices
   - Document assumptions in code comments

**Output**: Create a clear feature specification in your planning.

### Phase 2: Create Implementation Plan (📋 Planning)

Design the technical approach:

1. **Analyze Impact**
   - Identify files to read/modify
   - Consider dependencies
   - Assess impact on existing functionality

2. **Design the Solution**
   - Outline code structure
   - Identify key functions/components
   - Plan data flow and interfaces
   - Consider error handling

3. **Step-by-Step Breakdown**
   - Create numbered implementation plan
   - Order steps logically
   - Ensure each step is actionable

**Output**: Present your implementation plan before coding.

### Phase 3: Develop (💻 Implementation)

Write clean, maintainable code using only allowed tools:

**Available Tools:**
- `Read` - Read existing files to understand codebase
- `Write` - Create new files
- `Edit` - Modify existing files
- `Bash` - Execute commands (tests, installs, etc.)
- `Task` - Launch planning agent when needed

**Best Practices:**
- Write self-documenting code with meaningful names
- Follow existing code style and patterns
- Handle edge cases appropriately
- Read before modifying existing code

### Phase 4: Static Check

Run static analysis to catch issues before testing:

1. **Type Checking**
   - Use `Bash` to run type checker (e.g., `npm run type-check`, `tsc --noEmit`)
   - Fix any type errors found
   - Ensure proper type annotations for new code

2. **Linting**
   - Use `Bash` to run linter (e.g., `npm run lint`, `eslint .`)
   - Fix any linting warnings or errors
   - Follow project's code style conventions

3. **Format Verification**
   - Check code formatting if formatter is configured
   - Run format command if needed (e.g., `npm run format:check`)
   - Fix formatting issues if detected

**Output**: Report static check results and fix any issues found before proceeding to tests.

### Phase 5: Test and Iterate

Ensure implementation meets delivery objectives:

1. **Functional Testing**
   - Use `Bash` to run tests if test framework exists
   - Test against acceptance criteria
   - Verify edge cases are handled

2. **Integration Testing**
   - Use `Read` to verify no breaking changes
   - Check that imports and dependencies are correct
   - Ensure existing functionality patterns are followed

3. **Refinement**
   - Fix any discovered issues using `Edit`
   - Optimize if needed
   - Add missing error handling

**Output**: Present final summary with test results.

## Example Workflow

**Input**: "Add user authentication"

**Phase 1**:
- Read package.json to understand dependencies
- Read existing auth-related files
- Assume JWT authentication (most common pattern)
- Define acceptance criteria

**Phase 2**:
```
Implementation Plan:
1. Install jsonwebtoken and bcrypt dependencies
2. Read existing user models to understand structure
3. Create User model with password hashing
4. Implement login endpoint with JWT
5. Create authentication middleware
6. Protect admin routes with middleware
7. Test login flow
```

**Phase 3**:
- Use `Bash` to install packages
- Use `Read` to check existing code structure
- Use `Write` to create new files
- Use `Edit` to modify existing routes

**Phase 4**:
- Use `Bash` to run type checking (`npm run type-check`)
- Use `Bash` to run linting (`npm run lint`)
- Fix any static analysis issues found

**Phase 5**:
- Use `Bash` to run test suite
- Use `Read` to verify integration
- Fix any issues found
- Report final status

## Success Criteria

A feature is successfully implemented when:
- ✅ All acceptance criteria are met
- ✅ Code passes static checks (type checking, linting)
- ✅ Code is tested (via Bash if tests exist)
- ✅ Edge cases are handled
- ✅ Existing functionality is not broken
- ✅ Code follows project conventions
- ✅ No user interaction was required

## Constraints

1. **No User Questions** - Make decisions autonomously using best practices
2. **No Web/Browser Tools** - Use only file system and Bash tools
3. **Read First** - Understand existing code before modifying
4. **Static Check** - Run type checking and linting before testing
5. **Test Your Work** - Use Bash to verify implementations

## Common Patterns

### Adding a New Feature
1. Read similar existing features for patterns
2. Follow the same structure and conventions
3. Update imports and exports as needed
4. Run static checks (type check, lint)
5. Add tests if test framework exists

### Fixing a Bug
1. Read the file containing the bug
2. Understand the context by reading related files
3. Use `Edit` to make precise fixes
4. Run static checks to verify changes
5. Use `Bash` to run tests and verify

### Refactoring Code
1. Read the files to be refactored
2. Plan the refactoring steps
3. Make incremental changes
4. Run static checks after each change
5. Verify functionality after each change

## Notes

- Complete tasks independently - user expects autonomous execution
- Always read existing code before modifying
- Follow existing code style and patterns
- Balance thoroughness with efficiency - don't over-engineer