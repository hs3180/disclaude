# Docker Compose deployment

Docker Compose is supported from a full source checkout. The generated Git
release tag and the package installed by npm from that tag are prebuilt
distributions; they intentionally omit `docker-compose.yml`,
`Dockerfile.service`, and the source build inputs. Run Compose from the source
tree, not from an installed package directory.

To deploy the source revision used to build an installed release, read its
`sourceCommit` from `release-source.json`, then check out that commit in a full
repository clone:

```sh
PACKAGE_ROOT="$(npm root -g)/disclaude"
SOURCE_COMMIT="$(node -p 'require(process.argv[1]).sourceCommit' "$PACKAGE_ROOT/release-source.json")"
git clone https://github.com/hs3180/disclaude.git disclaude-source
git -C disclaude-source checkout "$SOURCE_COMMIT"
cd disclaude-source
cp disclaude.config.example.yaml disclaude.config.yaml
```

Edit `disclaude.config.yaml` for the deployment, then build and start the
service from that source checkout:

```sh
docker compose up -d --build
```

See the [GitHub installation guide](releases/git-install.md) for package
installation and the root `docker-compose.yml` for the source deployment
definition.
