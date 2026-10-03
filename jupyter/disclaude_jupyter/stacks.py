"""Exact RTC dependency profiles; installing a package never selects a profile."""

STACK_PROFILES = {
    "managed": {
        "jupyter-server": "2.21.1",
        "jupyterlab": "4.6.3",
        "jupyter-collaboration": "5.0.4",
        "jupyter-docprovider": "3.0.4",
        "jupyter-server-ydoc": "3.0.4",
        "jupyter-server-nbmodel": "0.2.9",
        "jupyter-ydoc": "4.1.1",
        "pycrdt": "0.14.8",
        "jupyter-client": "8.10.0",
        "ipykernel": "7.4.0",
        "nbformat": "5.11.1",
    },
    "configured-20261003": {
        "jupyter-server": "2.19.0",
        "jupyterlab": "4.4.1",
        "jupyter-collaboration": "4.4.1",
        "jupyter-docprovider": "2.4.1",
        "jupyter-server-ydoc": "2.4.1",
        "jupyter-server-nbmodel": "0.1.1a4",
        "jupyter-ydoc": "3.5.0",
        "pycrdt": "0.13.1",
        "jupyter-client": "8.8.0",
        "ipykernel": "7.2.0",
        "nbformat": "5.10.4",
    },
}
STACK_PACKAGES = tuple(STACK_PROFILES["managed"])
EXPERIMENTAL_PROFILES = frozenset({"configured-20261003"})


def verify_stack(profile: str, actual: dict[str, str], *, allow_experimental: bool = False):
    expected = STACK_PROFILES.get(profile)
    if expected is None:
        raise RuntimeError("Notebook coordinator stack profile is unknown")
    if profile in EXPERIMENTAL_PROFILES and not allow_experimental:
        raise RuntimeError("Configured Notebook stack is experimental and requires explicit opt-in")
    if actual != expected:
        raise RuntimeError("Notebook coordinator dependencies do not match the selected exact stack profile")
