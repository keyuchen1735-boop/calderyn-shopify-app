"""Put the engine package root (the dir holding ``calderyn_engine``) on sys.path
so tests import it the same way the Vercel functions do (api/engine/run.py adds
the same dir). No installed package / editable install needed."""
import os
import sys

_ENGINE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _ENGINE_ROOT not in sys.path:
    sys.path.insert(0, _ENGINE_ROOT)
