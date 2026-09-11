# Harness-installed private actions

Configure one installed consumer in `disclaude.config.yaml`. The Feishu transport has no service-specific authentication logic. The consumer decides whether the bound actor may perform the operation, which service to contact and whether to exchange a credential.

```yaml
feishu:
  privateAction:
    id: account-check
    title: Check account access
    description: Send this value only to the installed account-check consumer
    command: /absolute/path/to/node
    args: [/absolute/path/to/account-check.mjs]
    timeoutMs: 30000
    env:
      AUTH_CHECK_URL: https://your-service.example/account
      PERMITTED_ACTOR: your-feishu-open-id
```

In a direct conversation, `/private account-check` opens a password form. disclaude binds the form to its actor, chat, source message, returned card and one-use nonce. Pending forms expire after five minutes and are revoked by reissue, shutdown or restart. Never put the value in the command message itself.

The installed process reads the exact value from stdin. Its stdout/stderr are suppressed; exit zero returns success, other exits or timeout return failure. Original values are never written to `.runtime-env` or passed in argv/environment. `DISCLAUDE_PRIVATE_CONTEXT` contains verified action/actor/chat/source/correlation metadata, which the consumer uses for its own authorization checks. The callback cannot replace this context or executable definition.

Example consumer policy (installed code, not a disclaude rule):

```js
const context = JSON.parse(process.env.DISCLAUDE_PRIVATE_CONTEXT);
if (context.actor !== process.env.PERMITTED_ACTOR) process.exit(1);
let value = '';
for await (const chunk of process.stdin) value += chunk;
const response = await fetch(process.env.AUTH_CHECK_URL, {
  headers: { Authorization: `Bearer ${value}` }, redirect: 'error',
  signal: AbortSignal.timeout(10000),
});
await response.body?.cancel();
process.exitCode = response.ok ? 0 : 1;
```

Choose a consumer that completes its work before returning. The host terminates the owned POSIX group on completion or timeout; this is resource ownership, not an OS sandbox. Configure filesystem/network isolation separately when the installed consumer itself is untrusted. Protect any derived credential with the harness's explicit declaration and bounded distribution tools; do not persist the original form value.

The explicit sensitive-value/logger PRs are dependencies of this integration. Core consumers can also be supplied programmatically through `FeishuChannelConfig.privateInput`; configuration does not override an explicitly injected consumer.
