"""Optional Jupyter Server extension; independent of the Agent harness."""


def _jupyter_server_extension_points():
    from .extension import NotebookExtension

    return [{"module": "disclaude_jupyter", "app": NotebookExtension}]
