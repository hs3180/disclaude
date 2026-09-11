# GitHub App Configuration Guide

This guide explains how to configure GitHub App authentication for use with Disclaude skills and schedules.

## Overview

Disclaude uses the `gh` CLI (GitHub CLI) for GitHub operations. The `gh` CLI supports GitHub App authentication, providing a secure way to interact with GitHub APIs without storing credentials in Disclaude configuration.

## Prerequisites

- GitHub CLI (`gh`) version 2.40 or higher
- A GitHub account with permission to create GitHub Apps

## Quick Start

### 1. Create GitHub App

1. Navigate to [GitHub App settings](https://github.com/settings/apps/new)
2. Fill in the required fields:
   - **GitHub App name**: A unique name for your app
   - **Homepage URL**: Your app's homepage or repository URL
   - **Webhook**: Uncheck if not needed (simpler setup)

3. Configure permissions based on your use case:

| Use Case | Required Permissions |
|----------|---------------------|
| Read PRs | `pull_requests: read`, `contents: read` |
| Manage Issues | `issues: write`, `contents: read` |
| Full Access | `contents: write`, `pull_requests: write`, `issues: write` |

### 2. Generate Private Key

1. After creating the app, go to **Private keys** section
2. Click **Generate a private key**
3. Download the `.pem` file
4. Save securely:
   ```bash
   mv ~/Downloads/*.pem ~/.ssh/github-app-key.pem
   chmod 600 ~/.ssh/github-app-key.pem
   ```

### 3. Install App to Repository

1. Go to **Install App** in your GitHub App settings
2. Select your account/organization
3. Choose **Only select repositories**
4. Select the repositories you want to access
5. Note the **Installation ID** from the URL:
   ```
   https://github.com/settings/installations/{INSTALLATION_ID}
   ```

### 4. Authenticate with gh CLI

```bash
gh auth login --hostname github.com \
  --app-id YOUR_APP_ID \
  --app-key-path ~/.ssh/github-app-key.pem \
  --app-installation-id INSTALLATION_ID
```

Replace:
- `YOUR_APP_ID`: Found in GitHub App settings (top of the page)
- `INSTALLATION_ID`: From the installation URL

### 5. Verify Authentication

```bash
gh auth status
```

Expected output:
```
github.com
  ✓ Logged in to github.com as your-app-name (GitHub App)
  ✓ Git operations for github.com configured to use https protocol
  ✓ Token: ghp_***********************************
```

## Configuration Details

### Finding Your App ID

1. Go to GitHub App settings
2. Click on your app
3. The **App ID** is displayed at the top of the page

### Finding Your Installation ID

1. Go to **Install App** in GitHub App settings
2. Click the **Configure** button next to your installation
3. The URL will contain the installation ID:
   ```
   https://github.com/settings/installations/12345678
                                              ^^^^^^^^
                                              Installation ID
   ```

### Permission Reference

#### Repository Permissions

| Permission | Description | API Access |
|------------|-------------|------------|
| `contents` | Repository contents | Read/write files |
| `pull_requests` | Pull requests | Read/write PRs |
| `issues` | Issues | Read/write issues |
| `actions` | GitHub Actions | Read/write workflows |
| `workflows` | Workflow files | Update workflow files |
| `metadata` | Repository metadata | Required (always) |

#### Organization Permissions

| Permission | Description |
|------------|-------------|
| `members` | Organization members |
| `plan` | Organization plan |

## Use Cases

### PR Scanner Schedule

```yaml
---
name: "PR Scanner"
cron: "0 */30 * * * *"
enabled: true
chatId: "oc_your_chat_id"
---

# PR Scanner

Scan open PRs and send notifications.

gh pr list --repo OWNER/REPO --state open --json number,title,author,updatedAt
```

### Issue Creator Skill

```markdown
---
name: issue-creator
allowed-tools: [Bash]
---

gh issue create --repo OWNER/REPO \
  --title "Auto-generated issue" \
  --body "This issue was created automatically."
```

### PR Review Automation

```bash
# Get PR details
gh pr view 123 --repo OWNER/REPO --json title,body,author,mergeable

# Approve PR
gh pr review 123 --repo OWNER/REPO --approve --body "Reviewed and approved!"

# Merge PR
gh pr merge 123 --repo OWNER/REPO --squash
```

## Troubleshooting

### Authentication Failed

```bash
# Check authentication status
gh auth status

# Reset and re-authenticate
gh auth logout
gh auth login --hostname github.com \
  --app-id YOUR_APP_ID \
  --app-key-path ~/.ssh/github-app-key.pem \
  --app-installation-id INSTALLATION_ID
```

### Permission Denied

1. Check GitHub App permissions in settings
2. Update permissions if needed
3. Re-install the app to refresh permissions

### Installation Not Found

1. Verify the installation ID from the URL
2. Ensure the app is installed to the correct repository
3. Check if the installation is active

### Token Expired

GitHub App tokens are short-lived (1 hour). The `gh` CLI automatically refreshes them using the private key.

## Security Best Practices

1. **Private Key Storage**
   - Store in `~/.ssh/` with restricted permissions
   - Never commit to repositories
   - Rotate keys periodically

2. **Minimal Permissions**
   - Request only necessary permissions
   - Use repository-level installations
   - Review permissions regularly

3. **Environment Variables**
   ```bash
   # Optional: Use environment variables for CI/CD
   export GH_APP_ID="your-app-id"
   export GH_APP_INSTALLATION_ID="installation-id"
   export GH_APP_KEY_PATH="/path/to/key.pem"
   ```

## Related Resources

- [GitHub Apps Documentation](https://docs.github.com/en/apps)
- [GitHub CLI Manual](https://cli.github.com/manual/)
- [GitHub App Authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app)
