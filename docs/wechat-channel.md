# Personal WeChat channel (Tencent iLink)

This adapter connects a personal WeChat account through Tencent's iLink bot service (`https://ilinkai.weixin.qq.com`). It uses QR login and authenticated outbound HTTPS long polling. It is not a WeCom, Official Account, or group-chat integration. There is no public callback endpoint or callback signature to configure. The account/client must be eligible to connect an iLink bot; actual account eligibility requires a successful login.

Available since Disclaude 0.6.6; the 0.6.7 release hardens the re-login path. Install the prebuilt `v0.6.7` GitHub distribution using the [installation guide](releases/git-install.md). The original 0.6.5 release does not include this setup flow. The dated 2026-10-20 candidate record below is historical; current release verification is recorded in the release assets.

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

The default private registry root is `~/.disclaude/wechat`. Enabling WeChat supports dynamic account registration without a preset account list or an extra multi-account switch. Each successful login receives a stable system ID and its own private credential/session directory. To use another registry root, pass the same absolute `--state-dir` to the CLI and configure it below. Directories are 0700 and files are 0600. Directory and bot-identity locks prevent competing listeners, including saved copies in different directories.

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

Keep the workspace, private registry root and model authentication persistent. For isolated WeChat-only testing, use a separate workspace and omit Feishu configuration; the shared-service configuration below deliberately enables both platforms. Do not run the same iLink account in a legacy/OpenClaw listener simultaneously, even if it uses a different state directory. No production service restart is required to run an isolated WeChat-only candidate.

The service can start with no registered accounts. Run `disclaude wechat login` to scan and add an account; repeat the command for another account. Registration does not replace an existing login or restart the service. Failed or cancelled QR flows do not register an account. Send a message from WeChat to each linked bot first. New conversation IDs are `wechat:SYSTEM-ID:peer@im.wechat`, keeping the same peer's Agent history, incoming message identity, reply context and media separate across accounts. Generic parent message IDs are never used as iLink tokens. Unknown or incorrect account targets fail explicitly.

## One service with Feishu, REST and registered WeChat accounts

When a user first sends a message with a valid reply context, the bot sends a brief plain-text welcome and still processes that first task normally. Login output asks the user to send the first message; registration alone does not claim a welcome was delivered. Ask “怎么用” in the chat for help.

Saved accounts keep per-bot/per-peer onboarding attempts in private `welcome.json`, independently of cursor/media state. Normal restart, reconnect and repeated updates do not resend the welcome. An unknown delivery outcome is retained for inspection rather than blindly retried; an unreadable welcome file disables only automatic onboarding and leaves task reception available. Programmatic token-only channels without a state directory retain this deduplication only for their current process.

These channels can share one service process and configuration. Each channel connects independently. This differs from the isolated two-process candidate deployment described in the original acceptance record.

```yaml
channels:
  feishu:
    enabled: true
    appId: $FEISHU_APP_ID
    appSecret: $FEISHU_APP_SECRET
  rest:
    enabled: true
    host: 127.0.0.1
    port: 3000
    fileStorageDir: /absolute/path/to/rest-files
  wechat:
    enabled: true
    stateDir: /absolute/path/to/private/wechat-account
```

Log in using the same directory as the configuration:

```sh
disclaude wechat login --state-dir /absolute/path/to/private/wechat-account
disclaude wechat status --state-dir /absolute/path/to/private/wechat-account --check
```

Capability discovery reports each registered instance's status and health. A missing or failed login affects that instance; other accounts and channels continue serving, and the WeChat registration entry remains usable even when no account is connected. A later authentication/receive failure makes that instance unhealthy. Known targets stay bound to their owner; unknown/ambiguous targets fail explicitly. Scheduler replies select one owner. Cross-platform forwarding requires an explicit operation.

Account additions and management changes are reconciled from the private registry about once per second. Changing the global registry root, route tag or enabled channel configuration still requires a service restart. Feishu credentials remain separate from WeChat login files.

```sh
# Each login adds an account; names/directories are assigned by the system.
disclaude wechat login
disclaude wechat login
disclaude wechat status
# Use an actual ID returned by status for management.
disclaude wechat disable SYSTEM-ID
disclaude wechat enable SYSTEM-ID
disclaude wechat login --id SYSTEM-ID --force
disclaude wechat remove SYSTEM-ID
```

Reauthentication briefly suspends only the selected account and verifies the same bot identity. A scan that confirms a different bot identity is refused with a structured identity-changed result instead of an overwrite: the same user scanning a new bot identity is told to continue with a plain `disclaude wechat login`, which registers the new identity beside the old one; the old registration, its credentials and its history are never migrated or merged. Failure preserves its credentials and restores its former enabled state unless another management command changed it during the QR flow. `remove` forgets a registration and stops restoring it; private files remain for explicit recovery. `disable` retains the registration for a later `enable`. CLI success confirms the registry update; use `channel capabilities` to observe the resulting live connection state.

Existing singleton `auth.json` and session files are imported once from the configured root without moving or resetting them. That imported account keeps channel ID `wechat` and its old bare peer/Agent conversations. New accounts always use scoped IDs. Removing the imported registration does not auto-import it again. Same-bot registration updates its existing stable identity or reports a competing listener; it never creates a second listener or silently assigns history to a different bot.

## Delivery and capabilities

Managed Agents inherit the current service API address/token. From that environment:

```sh
disclaude channel capabilities
disclaude channel capabilities --chat 'wechat:SYSTEM-ID:actual-peer@im.wechat'
disclaude channel send_text --chat 'wechat:SYSTEM-ID:actual-peer@im.wechat' --text 'hello'
disclaude channel send_file --chat 'wechat:SYSTEM-ID:actual-peer@im.wechat' --file /absolute/path/report.pdf
```

Use the complete actual conversation ID received from that account, replacing the placeholders above. Only an imported singleton uses the bare peer ID. Outside the managed environment, supply the current candidate's API URL and token privately. Capability discovery requires authentication and does not send anything. An empty filtered result means no active channel owns that peer.

The channel CLI writes diagnostics to stderr and does not open the service's file log, even when the Agent inherits `LOG_TO_FILE=true` and a host-only `LOG_DIR`. Help, previews and file sending therefore do not require permission to write host logs. The service keeps its own file logging configuration.

Managed prompts supply the running installation's complete Node/CLI command prefix. Use that prefix for all channel operations: a shell snapshot or login profile can resolve a bare `disclaude` command to a different installed release. This matters when a candidate and production release coexist. The API address/token still come from the current managed environment.

Supported operations are plain text, images, native MP4 videos and ordinary files. `send_file` selects image messages for known image extensions and native video for `.mp4` (case-insensitive); other formats retain ordinary attachment behavior. MP4 uses upload `media_type=2`, message item type 5 and `video_size` equal to ciphertext bytes, preserving the peer's reply context. There is no transcoding or thumbnail generation. An upload/video-send failure is reported and never silently converted into a file message. `nativeVideoFormats` in capability discovery reports `mp4`.

Inbound images/files are downloaded, decrypted, and handed to the common Agent attachment interface as local files. File type is 4 in the current iLink protocol; type 3 is voice. Mixed text and multiple attachments are retained. Video input decoding remains outside this change.

The adapter uses a local 4000 UTF-8-byte text-part limit and a 20 MiB per-file limit, including MP4. Long text splits at Unicode code-point boundaries. The private inbound cache retains at most seven days, 200 files, and 256 MiB; older chat references can therefore expire. Cards, buttons/private-input cards, mentions, group chats, native threads, voice/video decoding and streaming edits are not implemented. Unsupported CLI card operations fail instead of returning synthetic success IDs.

WeChat forwards the existing public stage updates and decision summaries through the shared sendMessage callback as ordinary text before the final answer. The descriptor does not force finalReplyOnly; existing large-payload folding, tool-trace filtering and non-terminal progress error handling remain active. No separate progress callback or WeChat-specific Agent path is introduced. REST/structured workflows retain their final-answer-only behavior.

Successful API completion means Tencent accepted the request; it is not a read receipt. Timeouts, network failures, or unreadable send responses have an unknown delivery outcome and are not automatically resent. If a later text part fails, the error reports partial delivery. Check WeChat before retrying either case. Sending a file fails before reporting success when upload, encryption or the final message request fails.

## Restart, expiry, and migration

The sync cursor, bounded accepted-ID cache, and per-peer reply contexts are checkpointed atomically. Failed message handoffs remain retryable; accepted replays are suppressed across a normal restart. This is not a transactional exactly-once guarantee: a process crash between Agent admission and the checkpoint can replay a message, and eviction from the bounded cache removes the dedup tombstone. Generic Agent/job recovery is a separate layer.

Transient receive failures back off from 2 seconds to a maximum 30 seconds; shutdown aborts the active poll. An iLink `-14`/HTTP 401 login failure stops polling and makes the channel unhealthy. Run `wechat status` to find the account ID, then `wechat login --id SYSTEM-ID --force` using the same registry root; the service applies the new login automatically. A new login resets cursor/context state. Do not delete or replace account files while the listener is running. Corrupt state fails with a repair/restore diagnostic instead of silently discarding replay protection.

`wechat status` lists locally registered public IDs and enabled/configured state. `wechat status --check` performs read-only Tencent `getconfig` requests; live connection/health is reported by `channel capabilities`. An empty long-poll result or local healthy process alone does not prove real delivery. Raw gateway bodies, signed URLs, AES keys, and reply tokens are excluded from adapter logs/errors.

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

Follow-up coverage for #5449/#5450/#5453 includes `tests/integration/wechat-multi-channel.test.ts`: real lifecycle/WeChat adapters and authenticated CLI/API, intercepted Tencent HTTP and a simulated Feishu gateway, saved ownership/replay restore, channel startup failure isolation and native video routing. Dynamic registration and account-scoped routing have separate registration integration tests. Installed-package checks cover empty startup, dynamic registrations, management, and restart recovery using intercepted HTTP.

The 0.6.6 real-account record additionally covers one account's QR hot registration, real text and incoming image handling, a TXT round trip with phone-side content confirmation, native MP4 picture/sound, public progress/final messages, disable/enable, normal restart, and C3 same-process Feishu/WeChat final replies followed by original-service restoration. See the published release's `release-acceptance.md` asset for source-specific receipts. Real dual-account isolation and live connection/session-expiry fault scenarios are not claimed as accepted. The original 2026-10-20 candidate report remains a dated record, not the current deployment status.
