import sys
from pathlib import Path

# Import the sidecar package from the checkout, as run.py does on the Frame.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
