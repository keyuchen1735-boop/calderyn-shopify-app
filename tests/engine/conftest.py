import os
import sys

# Make the repo-root engine/ dir importable so `import _core` (and its
# sibling `calderyn_engine`) resolves the same way the Vercel function does.
_HERE = os.path.dirname(__file__)
_ENGINE_DIR = os.path.abspath(os.path.join(_HERE, "..", "..", "engine"))
sys.path.insert(0, _ENGINE_DIR)
