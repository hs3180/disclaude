ARG JUPYTER_BASE_IMAGE
FROM ${JUPYTER_BASE_IMAGE}

USER root
COPY . /opt/disclaude/datalayer-repair/
RUN python /opt/disclaude/datalayer-repair/install.py \
    && mkdir -p /opt/conda/etc/jupyter/jupyter_server_config.d \
    && cp /opt/disclaude/datalayer-repair/server-config.json \
        /opt/conda/etc/jupyter/jupyter_server_config.d/063-datalayer.json

# Preserve the existing deployment's runtime user; an empty image User is root.
ARG JUPYTER_RUNTIME_USER=root
USER ${JUPYTER_RUNTIME_USER}
