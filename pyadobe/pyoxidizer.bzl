# PyOxidizer build configuration for adobepy standalone Python interpreter.
#
# Builds a self-contained Python interpreter with the adobepy SDK pre-installed.
# Usage: pyoxidizer build --path pyadobe --var ADOBEPY_WHEEL <path-to-wheel>
#
# Reference: https://github.com/loonghao/photoshop-python-interpreter

def make_exe():
    dist = default_python_distribution()
    policy = dist.make_python_packaging_policy()

    # Allow loading additional Python packages from filesystem relative to
    # the executable, so downstream consumers can pip install more packages
    # alongside the pre-installed adobepy SDK.
    policy.resources_location_fallback = "filesystem-relative:lib"

    python_config = dist.make_python_interpreter_config()

    # Module search paths mirror a standard Python layout.  Downstream users
    # can place additional wheels or packages into lib/site-packages next to
    # the executable.
    python_config.module_search_paths = [
        "$ORIGIN/lib",
        "$ORIGIN/lib/site-packages",
    ]
    python_config.parse_argv = True

    exe = dist.to_python_executable(
        name="adobepy-python",
        packaging_policy=policy,
        config=python_config,
    )

    # Install the pre-built adobepy wheel.
    wheel_path = VARS.get("ADOBEPY_WHEEL")
    if wheel_path:
        exe.add_python_resources(exe.pip_install([wheel_path]))

    return exe


def make_install(exe):
    files = FileManifest()
    files.add_python_resource(".", exe)
    return files


register_target("exe", make_exe)
register_target("install", make_install, depends=["exe"], default=True)
resolve_targets()
