#!/usr/bin/env bash
# Pack the plugin into dist/md-autoformat.zip (config.json at the zip root).
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p dist
rm -f dist/md-autoformat.zip
python3 - <<'PY'
import os, zipfile
root = "plugin"
with zipfile.ZipFile("dist/md-autoformat.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirnames, filenames in os.walk(root):
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            arcname = os.path.relpath(path, root)
            z.write(path, arcname)
print("packed files:")
for info in zipfile.ZipFile("dist/md-autoformat.zip").infolist():
    print(" ", info.filename)
PY
echo "OK: dist/md-autoformat.zip"
cp dist/md-autoformat.zip dist/md-autoformat.plugin
echo "OK: dist/md-autoformat.plugin"
