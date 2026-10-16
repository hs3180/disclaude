# Channel credentials

Channel secrets belong in the service environment or an explicit external secret
file, outside `disclaude.config.yaml`. Whole values use `$VARIABLE` or
`${VARIABLE}`. Shell expressions, fallback expressions and partial interpolation
are rejected. Resolution never executes a command.

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
    fileStorageDir: ./data/rest-files
    authToken: $REST_CHANNEL_AUTH_TOKEN
```

| Component | Public identifier | Secret references |
| --- | --- | --- |
| Feishu WebSocket bot | `appId`: literal or reference | `appSecret` |
| Feishu webhook metadata | none | `verificationToken`, `encryptKey`: reference syntax enforced, but the current WebSocket channel does not consume these webhook settings |
| Ruliu adapter | `appKey`: literal or reference | `appSecret`, `checkToken`, `encodingAESKey` |
| REST chat channel | none | optional `authToken`, bearer protection on all data/control/file routes except `GET /api/health` |

Ruliu is an exported platform adapter, not a config-driven service channel. Its
host integration must resolve each field with `resolveChannelCredential` before
constructing the adapter. Adding a `channels.ruliu` entry alone does not start it.
The separate service channel-control API uses its per-startup random token (or
explicit `--api-token`); `channels.rest.authToken` protects the REST chat server,
not that control API. An absent REST token retains its existing unprotected mode.

## Sources and precedence

The inherited service environment wins, including an explicitly empty value.
For the public service CLI, `DISCLAUDE_SECRET_ENV_FILE` optionally loads one
external file **before** config/core imports. The file fills only unset variables.
There is no automatic `.env` discovery, config-local `env` fallback or interpolation.
A referenced missing or blank variable fails with its channel field path and
variable name. Generic configuration exports retain references, never resolved
values. Disabled channels need no live credential, but configured secret values
must still use valid external references.

The external file accepts one `KEY=VALUE` per line, blank lines and full-line `#`
comments. Optional surrounding single/double quotes are removed literally; there
is no shell expansion, escape processing, multiline value or inline-comment
syntax. The file must be a regular, non-symlink file, at most 1 MiB, with no
group/other permission bits (`0600` or `0400` on Unix). Keep it outside the
workspace, version control, backups intended for sharing and general YAML exports.
The service account must be able to read it.

```sh
install -d -m 700 "$HOME/.config/disclaude"
install -m 600 /dev/null "$HOME/.config/disclaude/channel-secrets.env"
# Edit the file locally with actual values; do not put them in command arguments.
${EDITOR:-vi} "$HOME/.config/disclaude/channel-secrets.env"
```

File contents (replace placeholders locally):

```dotenv
FEISHU_APP_ID=your-public-app-id
FEISHU_APP_SECRET=replace-with-secret
REST_CHANNEL_AUTH_TOKEN=replace-with-a-random-bearer-token
```

## CLI and deployment

For CLI startup:

```sh
DISCLAUDE_SECRET_ENV_FILE="$HOME/.config/disclaude/channel-secrets.env" \
  disclaude start --config "$HOME/.disclaude/disclaude.config.yaml"
```

For macOS launchd, add only the path to the existing service plist's
`EnvironmentVariables`; use an absolute path, since launchd does not expand `~`:

```xml
<key>DISCLAUDE_SECRET_ENV_FILE</key>
<string>/Users/YOU/.config/disclaude/channel-secrets.env</string>
```

Reload the existing service with its established launchctl procedure after
checking active work. Preserve its other environment entries and workspace.
Do not put the secret values in the plist or run a second bot connection.

For systemd, install an owner-only file readable by the configured service user
and add this drop-in (`systemctl edit disclaude`):

```ini
[Service]
Environment=DISCLAUDE_SECRET_ENV_FILE=/etc/disclaude/channel-secrets.env
```

Then run `systemctl daemon-reload` and restart during the planned service window.
Alternatively, `EnvironmentFile=/etc/disclaude/channel-secrets.env` injects the
values directly through systemd; they then count as inherited environment.

Docker can inject a host `0600` environment file without putting values in the
image, YAML or command arguments:

```sh
docker run --env-file /secure/channel-secrets.env \
  -v /srv/disclaude/config.yaml:/app/disclaude.config.yaml:ro \
  -v /srv/disclaude/workspace:/data/workspace IMAGE
```

For a mounted secret file, set `DISCLAUDE_SECRET_ENV_FILE` to its container path
and ensure its permissions/UID permit the service user to read it. A default
world-readable secret mount is rejected by the explicit file loader.
CI should inject its secret-store values into the service step's environment:

```yaml
env:
  FEISHU_APP_ID: ${{ vars.FEISHU_APP_ID }}
  FEISHU_APP_SECRET: ${{ secrets.FEISHU_APP_SECRET }}
  REST_CHANNEL_AUTH_TOKEN: ${{ secrets.REST_CHANNEL_AUTH_TOKEN }}
```

## Migration and diagnostics

Replace a literal `channels.feishu.appSecret: ...` with
`appSecret: $FEISHU_APP_SECRET`, then move its value into the external source.
Replace `appSecretEnv: FEISHU_APP_SECRET` with that same reference and remove
`appSecretEnv`. Remove a corresponding `env.FEISHU_APP_SECRET` from the YAML;
moving the literal there is rejected even if an external environment overrides it.
Apply the same migration to Ruliu secrets and REST `authToken`. No user config is
rewritten automatically. Back up old configs only in a private location.

Credential errors name the field and correction without echoing values. YAML
parse errors omit source excerpts. Referenced channel secrets are redacted from
serialized service logs (including strings/stacks) in every log mode. All harness
child environments remove the referenced channel secret variables and secret-file
path; agents use the authenticated channel-control API for delivery. This prevents
automatic inheritance; host filesystem/tool permissions still govern file access.
Rotate credentials in the external source and restart the service; running channel
clients keep their prior credential until replaced. Verify authentication and
delivery before retiring an old secret.
