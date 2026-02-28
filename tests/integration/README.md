# Feishu Channel Integration Tests

This directory contains integration tests for the Feishu/Lark messaging platform integration.

## Overview

The Feishu Channel integration tests verify:

1. **API Connectivity** - Connection to Feishu Open API
2. **Authentication** - Tenant access token retrieval
3. **Message Operations** - Send text, card, and recall messages
4. **Module Integration** - FeishuChannel, FeishuMessageSender, FeishuAdapter

## Prerequisites

- Node.js 18+
- Feishu App ID and Secret
- (Optional) Feishu sandbox test chat ID
- (Optional) Feishu sandbox test user ID

## Setup

### 1. Set Environment Variables

```bash
export FEISHU_APP_ID="your_app_id"
export FEISHU_APP_SECRET="your_app_secret"
export FEISHU_TEST_CHAT_ID="oc_xxx"  # Optional: for message tests
export FEISHU_TEST_USER_ID="ou_xxx"  # Optional: for user info tests
```

### 2. Build the Project

```bash
npm run build
```

## Running Tests

### Run All Tests

```bash
./tests/integration/feishu-channel-test.sh
```

### Run with Verbose Output

```bash
./tests/integration/feishu-channel-test.sh --verbose
```

### Skip API Tests (Module Tests Only)

```bash
./tests/integration/feishu-channel-test.sh --skip-sandbox
```

### Dry Run (Show Test Plan)

```bash
./tests/integration/feishu-channel-test.sh --dry-run
```

### Custom Timeout

```bash
./tests/integration/feishu-channel-test.sh --timeout 180
```

## Test Categories

### Module Tests (No Network Required)

| Test | Description |
|------|-------------|
| `test_channel_module` | Verify FeishuChannel can be imported |
| `test_channel_lifecycle` | Test channel creation and state |
| `test_message_handler` | Test message handler registration |
| `test_control_handler` | Test control handler registration |
| `test_interaction_manager` | Test InteractionManager availability |
| `test_message_sender` | Verify FeishuMessageSender module |
| `test_feishu_adapter` | Verify FeishuAdapter module |

### API Tests (Require Network & Credentials)

| Test | Description | Required |
|------|-------------|----------|
| `test_api_connectivity` | Get tenant access token | FEISHU_APP_ID, FEISHU_APP_SECRET |
| `test_get_user_info` | Retrieve user information | FEISHU_TEST_USER_ID |
| `test_send_text_message` | Send text message to chat | FEISHU_TEST_CHAT_ID |
| `test_send_card_message` | Send interactive card | FEISHU_TEST_CHAT_ID |
| `test_message_recall` | Send and recall a message | FEISHU_TEST_CHAT_ID |

## CI/CD Integration

These tests are designed to be optional in CI environments since they require:

1. Feishu sandbox credentials (secrets)
2. Network access to `open.feishu.cn`
3. A valid test chat in the sandbox

### GitHub Actions Example

```yaml
name: Feishu Integration Tests

on:
  workflow_dispatch:  # Manual trigger only
    inputs:
      run_feishu_tests:
        description: 'Run Feishu integration tests'
        required: true
        default: 'false'
        type: boolean

jobs:
  feishu-tests:
    if: ${{ github.event.inputs.run_feishu_tests == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build
      - run: ./tests/integration/feishu-channel-test.sh --skip-sandbox
      - name: Run API Tests
        if: ${{ secrets.FEISHU_APP_ID && secrets.FEISHU_APP_SECRET }}
        env:
          FEISHU_APP_ID: ${{ secrets.FEISHU_APP_ID }}
          FEISHU_APP_SECRET: ${{ secrets.FEISHU_APP_SECRET }}
          FEISHU_TEST_CHAT_ID: ${{ secrets.FEISHU_TEST_CHAT_ID }}
        run: ./tests/integration/feishu-channel-test.sh
```

## Test Configuration

For persistent configuration, copy the example config:

```bash
cp tests/integration/feishu-test-config.example.yaml tests/integration/feishu-test-config.yaml
```

Edit `feishu-test-config.yaml` with your credentials.

**⚠️ Important:** Never commit `feishu-test-config.yaml` to version control!

## Troubleshooting

### "FEISHU_APP_ID and FEISHU_APP_SECRET must be set"

Set the required environment variables before running tests.

### "Failed to get tenant access token"

- Verify your App ID and Secret are correct
- Check that your app is published and active
- Ensure network access to `open.feishu.cn`

### "Failed to send message"

- Verify `FEISHU_TEST_CHAT_ID` is a valid chat ID
- Ensure the bot is a member of the chat
- Check that the bot has message sending permissions

### Module Import Errors

- Run `npm run build` to compile TypeScript
- Check that `dist/channels/feishu-channel.js` exists

## Related Issues

- #321 - Feishu Channel 集成测试设计
- #288 - 集成测试与 E2E 测试覆盖
- #333 - 集成测试环境构建

## Related Files

- `src/channels/feishu-channel.ts` - Main Feishu channel implementation
- `src/platforms/feishu/feishu-message-sender.ts` - Message sender utility
- `src/platforms/feishu/feishu-adapter.ts` - Feishu API adapter
- `src/platforms/feishu/interaction-manager.ts` - Card interaction handling
