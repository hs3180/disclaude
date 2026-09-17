# Current candidate upgrade and rollback

On macOS arm64, Node 24.8.0/npm 11.6.0, the isolated upgrade runner installed the
0.5.3 baseline distribution `3bce4ca2`, then candidate source `df56fc66`, then the
same baseline into one prefix. Every phase passed CLI startup, health, graceful
shutdown and instance-lock cleanup. Configuration, runtime environment, a user
file and two nested research fixtures retained exact content and 0600 modes.
Rollback restored the complete original provenance object.

| Artifact | Source fingerprint |
| --- | --- |
| Baseline source `3153a6be` | `86d6668376337fbdc5972b31fc121add13e1365e229eb52befb61e22377e9a22` |
| Candidate source `df56fc66` | `fe658333462f95b85a92456b5c13bb3debfde0351c45b22fadfcc07b446dbdd3` |

The baseline archive was downloaded by its fixed distribution SHA and its embedded
provenance checked. The candidate archive was generated from the integrated
checkout. Both still report version 0.5.3; source fingerprints establish that an
actual candidate replacement and baseline restoration occurred despite the shared
version string. This is not final 0.6.0 tag or release validation.

The runner now accepts verified local archives without temporary source rewrites,
requires both fingerprints for that transport, and checks baseline provenance on
rollback. Missing baseline fingerprint was rejected before installation. Syntax
and diff checks passed. The real installation sequence exercised the new path.

No model request, live Feishu channel or production-service switch occurred. The
startup configuration selects gpt-5.6-luna. All test processes, prefix, downloaded
archives and generated distribution files were cleaned up by the owned runner.

The research files are preservation fixtures, not evidence of semantic checkpoint
migration, old card access or live model recovery. Public Git/tag installation,
Linux/runtime matrix, final deployment configuration and complete Research upgrade
acceptance remain open.
