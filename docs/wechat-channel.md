# Personal WeChat channel (Tencent iLink)

This adapter connects a personal WeChat account through Tencent's iLink bot service (`https://ilinkai.weixin.qq.com`). It uses QR login and authenticated outbound HTTPS long polling. It is not a WeCom, Official Account, or group-chat integration. There is no public callback endpoint or callback signature to configure. The account/client must be eligible to connect an iLink bot; actual account eligibility requires a successful login.

These changes are a development candidate for #4889. The original 0.6.5 release does not include this setup flow. Use the candidate source/installer until the reviewed changes are released. No PR in this stack should be merged automatically.

## Install and log in

For a source checkout (Node 20+ recommended):

```sh
pnpm install --frozen-lockfile
pnpm run build
node bin/disclaude.js wechat login
node bin/disclaude.js wechat status --check
```

For a prebuilt candidate archive, install into a separate prefix:

```sh
npm install --prefix /absolute/path/to/candidate disclaude-candidate.tgz
/absolute/path/to/candidate/node_modules/.bin/disclaude wechat login
/absolute/path/to/candidate/node_modules/.bin/disclaude wechat status --check
```

No Tencent/OpenClaw host service or inbound port is needed. The host needs outbound HTTPS access to the iLink and Weixin CDN domains. The Agent runtime must also be configured and authenticated normally; iLink login does not authenticate Codex/Claude.

The default private account directory is `~/.disclaude/wechat`. To use a dedicated account directory, pass the same absolute `--state-dir` to login/status and configure it below. Directory permissions are 0700 and account/session files are 0600. The account lock prevents a second listener or login writer using that directory.

For a remote operator, `wechat login --qr-file /private/path/login.png` writes a QR PNG without launching a desktop app. Deliver that temporary image privately and scan/confirm in WeChat. QR codes expire and refresh up to three times within an eight-minute login deadline. If Tencent requests pairing digits, enter them only in a private interactive terminal or an integration's private input callback; do not place them in a group chat, command arguments, or logs. Noninteractive pairing fails explicitly. Remove the QR image after use.

## Configure and start

Minimal Codex example (use an authenticated Codex installation):

```yaml
agents:
  daily:
    backend: codex
    llm: daily
    default: true
    codex:
      transport: app-server
llms:
  daily:
    model: gpt-6-luna
channels:
  wechat:
    enabled: true
    # Optional; must match login --state-dir. Omit for ~/.disclaude/wechat.
    # stateDir: /absolute/path/to/private/wechat-account
workspace:
  dir: /absolute/path/to/wechat-workspace
logging:
  level: info
  pretty: false
```

```sh
node bin/disclaude.js start --config /absolute/path/to/wechat.yaml --api-port 0
```

Keep the workspace, private account directory and model authentication persistent. A dedicated test instance must have a separate workspace and no Feishu configuration. Do not run the same iLink account in a legacy/OpenClaw listener simultaneously, even if it uses a different state directory. No production service restart is required to run an isolated WeChat-only candidate.

Send a message from WeChat to the linked bot first. The incoming peer ID (`…@im.wechat`) selects the Agent conversation. The private reply context stays in the adapter/account state; generic parent message IDs are never used as iLink tokens. Unknown peers cannot borrow another channel's routing or context. Only one saved WeChat account is configured per service in this candidate.

## Delivery and capabilities

Managed Agents inherit the current service API address/token. From that environment:

```sh
disclaude channel capabilities
disclaude channel capabilities --chat 'actual-peer@im.wechat'
disclaude channel send_text --chat 'actual-peer@im.wechat' --text 'hello'
disclaude channel send_file --chat 'actual-peer@im.wechat' --file /absolute/path/report.pdf
```

Use an actual received peer ID, not the placeholder above. Outside the managed environment, supply the current candidate's API URL and token privately. Capability discovery requires authentication and does not send anything. An empty filtered result means no active channel owns that peer.

Supported operations are plain text and image/file sending. Image files are uploaded as image messages; other files are attachment messages. Inbound images/files are downloaded, decrypted, and handed to the common Agent attachment interface as local files. File type is 4 in the current iLink protocol; type 3 is voice. Mixed text and multiple attachments are retained.

The adapter uses a local 4000 UTF-8-byte text-part limit and a 20 MiB per-file limit. Long text splits at Unicode code-point boundaries. The private inbound cache retains at most seven days, 200 files, and 256 MiB; older chat references can therefore expire. Cards, buttons/private-input cards, mentions, group chats, native threads, voice/video decoding, streaming edits, and multiple simultaneously configured WeChat accounts are not implemented. Unsupported CLI card operations fail instead of returning synthetic success IDs.

Successful API completion means Tencent accepted the request; it is not a read receipt. Timeouts, network failures, or unreadable send responses have an unknown delivery outcome and are not automatically resent. If a later text part fails, the error reports partial delivery. Check WeChat before retrying either case. Sending a file fails before reporting success when upload, encryption or the final message request fails.

## Restart, expiry, and migration

The sync cursor, bounded accepted-ID cache, and per-peer reply contexts are checkpointed atomically. Failed message handoffs remain retryable; accepted replays are suppressed across a normal restart. This is not a transactional exactly-once guarantee: a process crash between Agent admission and the checkpoint can replay a message, and eviction from the bounded cache removes the dedup tombstone. Generic Agent/job recovery is a separate layer.

Transient receive failures back off from 2 seconds to a maximum 30 seconds; shutdown aborts the active poll. An iLink `-14`/HTTP 401 login failure stops polling and makes the channel unhealthy. Stop the listener, run `wechat login --force` with the same state directory, then restart. A new login resets cursor/context state. Do not delete or replace account files while the listener is running. Corrupt state fails with a repair/restore diagnostic instead of silently discarding replay protection.

`wechat status` reports local configuration only. `wechat status --check` performs a read-only Tencent `getconfig` request. An empty long-poll result or local healthy process alone does not prove real delivery. Raw gateway bodies, signed URLs, AES keys, and reply tokens are excluded from adapter logs/errors.

For the old `~/.disclaude/wechat-auth.json` file:

```sh
disclaude wechat login --import-legacy
disclaude wechat status --check
```

Migration tightens the legacy file permissions and privately writes the new account directory. It does not print/copy credentials into YAML or chat. Keep the old file until rollback is no longer needed; stop the candidate before resuming a legacy listener. Rolling back to 0.6.5 does not provide the new setup/diagnostics or encrypted-media fixes.

## Acceptance record

Keep these results separate:

1. Local protocol integration: HTTP interception, simulated Agent handoff, encrypted media, retries/replay, state restore, and real CLI/API discovery.
2. Installation: prebuilt archive installed into a fresh prefix; its CLI/setup/status work without checkout links.
3. Real account: successful read-only login check; then a new WeChat message reaches a real Agent and its reply arrives in the same WeChat conversation. Confirm image/file contents in each direction separately.
4. Release/deployment: reviewed commits merged, installer published, and the intended service upgraded. Candidate startup alone does not satisfy this item.

Relevant tests: `pnpm exec vitest run packages/service/src/channels/wechat tests/integration/wechat-channel.test.ts`. See the accompanying candidate acceptance record for observed results and pending steps.
