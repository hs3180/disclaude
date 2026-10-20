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

The default private account directory is `~/.disclaude/wechat`. To use a dedicated account directory, pass the same absolute `--state-dir` to login/status and configure it below. Directory permissions are 0700 and account/session files are 0600. Directory locks exclude competing writers; a separate bot-identity lock also excludes two saved copies of the same bot login in different directories on this host.

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

Keep the workspace, private account directory and model authentication persistent. For isolated WeChat-only testing, use a separate workspace and omit Feishu configuration; the shared-service configuration below deliberately enables both platforms. Do not run the same iLink account in a legacy/OpenClaw listener simultaneously, even if it uses a different state directory. No production service restart is required to run an isolated WeChat-only candidate.

Send a message from WeChat to the linked bot first. A legacy singleton keeps the incoming peer ID (`…@im.wechat`) as its Agent conversation ID. The private reply context stays in the adapter/account state; generic parent message IDs are never used as iLink tokens. Unknown peers cannot borrow another channel's routing or context.

## One service with Feishu, REST and named WeChat accounts

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
    accounts:
      work:
        enabled: true
        stateDir: /absolute/path/to/private/wechat-work
      personal:
        enabled: true
        stateDir: /absolute/path/to/private/wechat-personal
```

Run each login independently, using the same directory as its config:

```sh
disclaude wechat login --account work --state-dir /absolute/path/to/private/wechat-work
disclaude wechat status --account work --state-dir /absolute/path/to/private/wechat-work --check
disclaude wechat login --account personal --state-dir /absolute/path/to/private/wechat-personal
```

If `stateDir` is omitted for a named account, both configuration and `--account NAME` use `~/.disclaude/wechat/accounts/NAME`. Names contain 1–64 letters, digits, underscores or hyphens and start with a letter or digit. The existing `channels.wechat.stateDir` and CLI without `--account` retain their singleton behavior; choose either the singleton fields or `accounts` in one config. Disabled accounts do not load their credentials. Duplicate enabled state directories, including aliases, are rejected.

Each named instance is `wechat:NAME`. Its public conversation ID is `wechat:NAME:actual-peer@im.wechat`; use that complete value from the message metadata in API/CLI operations. This selects one account and gives the same peer separate Agent histories, message identities, reply contexts, cursors, replay caches and media directories. Raw peer IDs are reserved for the legacy singleton. To migrate a singleton to a named account, stop its listener, point the named entry at its private directory, and expect a new account-qualified Agent conversation; the old Agent history is not silently reassigned.

```sh
disclaude channel capabilities
disclaude channel capabilities --chat 'wechat:work:actual-peer@im.wechat'
disclaude channel send_file --chat 'wechat:work:actual-peer@im.wechat' --file /absolute/path/clip.mp4
```

Capability discovery reports each instance's status and health. Missing login or startup failure in one instance leaves successfully started channels serving; startup fails if every configured channel fails. A later authentication/receive failure makes that instance unhealthy. Known targets stay bound to their owner, even when it is unavailable; unknown/ambiguous targets fail explicitly. Scheduler replies also select one owner. Cross-platform forwarding requires an explicit operation.

Configuration changes currently require a service restart; use the existing graceful shutdown and retain all account directories. For reauthentication, stop the affected listener before `login --account NAME --force` with its configured directory, then restart it. A full service restart briefly interrupts all configured channels, so schedule it accordingly. Account failures during normal operation do not stop healthy siblings. Feishu app credentials continue to use host-owned environment references and stay separate from WeChat login files.

## Delivery and capabilities

Managed Agents inherit the current service API address/token. From that environment:

```sh
disclaude channel capabilities
disclaude channel capabilities --chat 'actual-peer@im.wechat'
disclaude channel send_text --chat 'actual-peer@im.wechat' --text 'hello'
disclaude channel send_file --chat 'actual-peer@im.wechat' --file /absolute/path/report.pdf
```

Use an actual received peer ID, not the placeholder above. Outside the managed environment, supply the current candidate's API URL and token privately. Capability discovery requires authentication and does not send anything. An empty filtered result means no active channel owns that peer.

The channel CLI writes diagnostics to stderr and does not open the service's file log, even when the Agent inherits `LOG_TO_FILE=true` and a host-only `LOG_DIR`. Help, previews and file sending therefore do not require permission to write host logs. The service keeps its own file logging configuration.

Managed prompts supply the running installation's complete Node/CLI command prefix. Use that prefix for all channel operations: a shell snapshot or login profile can resolve a bare `disclaude` command to a different installed release. This matters when a candidate and production release coexist. The API address/token still come from the current managed environment.

Supported operations are plain text, images, native MP4 videos and ordinary files. `send_file` selects image messages for known image extensions and native video for `.mp4` (case-insensitive); other formats retain ordinary attachment behavior. MP4 uses upload `media_type=2`, message item type 5 and `video_size` equal to ciphertext bytes, preserving the selected account's peer context. There is no transcoding or thumbnail generation. An upload/video-send failure is reported and never silently converted into a file message. `nativeVideoFormats` in capability discovery reports `mp4`.

Inbound images/files are downloaded, decrypted, and handed to the common Agent attachment interface as local files. File type is 4 in the current iLink protocol; type 3 is voice. Mixed text and multiple attachments are retained. Video input decoding remains outside this change.

The adapter uses a local 4000 UTF-8-byte text-part limit and a 20 MiB per-file limit, including MP4. Long text splits at Unicode code-point boundaries. The private inbound cache retains at most seven days, 200 files, and 256 MiB; older chat references can therefore expire. Cards, buttons/private-input cards, mentions, group chats, native threads, voice/video decoding and streaming edits are not implemented. Unsupported CLI card operations fail instead of returning synthetic success IDs.

WeChat delivers public stage updates and decision summaries as ordinary text before the final answer. Duplicate progress in the same turn is suppressed, and existing large-payload folding and tool-trace filtering remain active. A progress-send failure is non-terminal; an uncertain update is not blindly resent. Final replies stay independent. REST/structured workflows retain their final-answer-only behavior.

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

Follow-up coverage for #5449/#5450/#5451/#5453 includes `tests/integration/wechat-multi-channel.test.ts`: real lifecycle/WeChat adapters and authenticated CLI/API, intercepted Tencent HTTP and a simulated Feishu gateway, same-peer account isolation, saved ownership/replay restore, failed-account isolation and native video routing. It does not establish real dual-account receipt, native-video playback on a phone, or a same-process production Feishu/WeChat exchange; those acceptance steps remain to be performed and recorded separately.
