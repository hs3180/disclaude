ARG JUPYTER_BASE_IMAGE
FROM ${JUPYTER_BASE_IMAGE}

USER root
COPY . /opt/disclaude/datalayer-repair/
RUN python /opt/disclaude/datalayer-repair/install.py \
    && python /opt/disclaude/datalayer-repair/configure.py \
        --config-file /opt/conda/etc/jupyter/jupyter_config.json

# Opt in only when the existing remote environment lacks the report fixture packages.
ARG INSTALL_REPORTING_DEPS=0
RUN if [ "$INSTALL_REPORTING_DEPS" = 1 ]; then \
      python -m pip install --no-cache-dir --no-deps --require-hashes \
        -r /opt/disclaude/datalayer-repair/reporting-requirements.txt \
      && python -m pip check; \
    fi

# Preserve the existing deployment's runtime user; an empty image User is root.
ARG JUPYTER_RUNTIME_USER=root
USER ${JUPYTER_RUNTIME_USER}
