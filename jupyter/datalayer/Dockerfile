ARG JUPYTER_BASE_IMAGE
FROM ${JUPYTER_BASE_IMAGE}

USER root
COPY . /opt/disclaude/datalayer-repair/
ARG JUPYTER_PYTHON=python3
ARG JUPYTER_FRONTEND_DIR
ARG JUPYTER_PACKAGE_DIR
ARG JUPYTER_PACKAGE_PARENT
RUN PYTHONPATH="${JUPYTER_PACKAGE_PARENT}:${PYTHONPATH}" \
    "${JUPYTER_PYTHON}" /opt/disclaude/datalayer-repair/install.py \
    ${JUPYTER_FRONTEND_DIR:+--frontend-dir "$JUPYTER_FRONTEND_DIR"} \
    ${JUPYTER_PACKAGE_DIR:+--package-dir "$JUPYTER_PACKAGE_DIR"}
# The adapter merges/mounts the config discovered in the running container.
# An image build as root cannot infer the runtime user's config search paths.

# Opt in only when the existing remote environment lacks the report fixture packages.
ARG INSTALL_REPORTING_DEPS=0
RUN if [ "$INSTALL_REPORTING_DEPS" = 1 ]; then \
      "${JUPYTER_PYTHON}" -m pip install --no-cache-dir --no-deps --require-hashes \
        -r /opt/disclaude/datalayer-repair/reporting-requirements.txt \
      && "${JUPYTER_PYTHON}" -m pip check; \
    fi

# Preserve the existing deployment's runtime user; an empty image User is root.
ARG JUPYTER_RUNTIME_USER=root
USER ${JUPYTER_RUNTIME_USER}
