ARG JUPYTER_BASE_IMAGE
FROM ${JUPYTER_BASE_IMAGE}

USER root
COPY . /opt/disclaude/datalayer-repair/
RUN python /opt/disclaude/datalayer-repair/install.py \
    && python /opt/disclaude/datalayer-repair/configure.py \
        --config-file /opt/conda/etc/jupyter/jupyter_config.json

# Preserve the existing deployment's runtime user; an empty image User is root.
ARG JUPYTER_RUNTIME_USER=root
USER ${JUPYTER_RUNTIME_USER}
