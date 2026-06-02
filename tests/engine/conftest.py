import os
import sys

# Make api/engine importable so `import _core` (and its sibling
# `calderyn_engine`) resolves without turning api/ into a package.
_HERE = os.path.dirname(__file__)
_ENGINE_DIR = os.path.abspath(os.path.join(_HERE, "..", "..", "api", "engine"))
sys.path.insert(0, _ENGINE_DIR)
