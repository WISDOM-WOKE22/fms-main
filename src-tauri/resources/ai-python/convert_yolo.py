#!/usr/bin/env python3
"""Convert YOLO .pt model to ONNX for CPU inference.

Usage:
    python convert_yolo.py                          # auto-find yolo26s.pt
    python convert_yolo.py models/yolo26s.pt        # explicit path
    python convert_yolo.py --force                  # reconvert even if ONNX exists

The ONNX file is written next to the .pt file (e.g. models/yolo26s.onnx).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def find_pt_file() -> Path | None:
    """Search common locations for a YOLO .pt file."""
    here = Path(__file__).resolve().parent
    candidates = [
        here / "models" / "yolo26s.pt",
        here / "yolo26s.pt",
        here / "models" / "yolo11s.pt",
        here / "models" / "yolov8s.pt",
    ]
    data_dir = os.environ.get("FMS_AI_DATA_DIR", "")
    if data_dir:
        candidates.append(Path(data_dir) / "yolo26s.pt")
    for p in candidates:
        if p.is_file():
            return p
    return None


def convert(pt_path: Path, force: bool = False) -> Path:
    onnx_path = pt_path.with_suffix(".onnx")

    if onnx_path.is_file() and not force:
        pt_mtime = pt_path.stat().st_mtime
        onnx_mtime = onnx_path.stat().st_mtime
        if onnx_mtime >= pt_mtime:
            print(f"ONNX already up-to-date: {onnx_path}")
            return onnx_path
        print(f"ONNX is older than .pt — reconverting")

    print(f"Converting {pt_path} -> ONNX ...")
    try:
        from ultralytics import YOLO
    except ImportError:
        print("ERROR: ultralytics package not installed. Run: pip install ultralytics", file=sys.stderr)
        sys.exit(1)

    model = YOLO(str(pt_path))
    model.export(format="onnx", imgsz=640, simplify=True, opset=17)

    # ultralytics writes the .onnx next to the .pt automatically
    if not onnx_path.is_file():
        # Some versions put it in a runs/ directory — find it
        for p in pt_path.parent.rglob("*.onnx"):
            if p.stem == pt_path.stem:
                import shutil
                shutil.move(str(p), str(onnx_path))
                break

    if onnx_path.is_file():
        size_mb = onnx_path.stat().st_size / (1024 * 1024)
        print(f"OK: {onnx_path} ({size_mb:.1f} MB)")
    else:
        print(f"ERROR: ONNX file not found after export", file=sys.stderr)
        sys.exit(1)

    return onnx_path


if __name__ == "__main__":
    force = "--force" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("-")]

    if args:
        pt = Path(args[0])
    else:
        pt = find_pt_file()
        if pt is None:
            print("No .pt file found. Pass path as argument or place in models/ directory.", file=sys.stderr)
            sys.exit(1)

    if not pt.is_file():
        print(f"File not found: {pt}", file=sys.stderr)
        sys.exit(1)

    convert(pt, force=force)
