"""Copy only browser assets into the Cloudflare Worker upload directory."""

from pathlib import Path
from shutil import copy2


root = Path(__file__).resolve().parents[1]
destination = root / "dist"
destination.mkdir(exist_ok=True)
assets = ("index.html", "style.css", "app.js")
unexpected = [path.name for path in destination.iterdir() if path.name not in assets]
if unexpected:
    raise SystemExit(f"Unexpected files in dist/: {', '.join(sorted(unexpected))}")
for name in assets:
    copy2(root / name, destination / name)
