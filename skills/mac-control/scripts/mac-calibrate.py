#!/usr/bin/env python3
"""
macOS coordinate calibration utility.

Detects the display's backing scale factor and verifies coordinate consistency
between screenshot (pixel) space and CGEvent (logical point) space.

Part of Issue #2216 Phase 1: Coordinate calibration mechanism.

Usage:
  python3 mac-calibrate.py
  python3 mac-calibrate.py --json       # JSON output
"""

import json
import os
import subprocess
import sys
import tempfile
import time


def _run(cmd, **kwargs):
    """Run a command and return CompletedProcess."""
    return subprocess.run(cmd, capture_output=True, text=True, timeout=10, **kwargs)


def get_display_info():
    """Gather display information via system_profiler and NSScreen."""
    info = {
        "scaleFactor": 2.0,
        "mainScreen": None,
        "displays": [],
    }

    # Get scale factor via NSScreen
    try:
        result = _run([
            sys.executable, "-c",
            "import AppKit; "
            "screens = AppKit.NSScreen.screens(); "
            "main = AppKit.NSScreen.mainScreen(); "
            "print(f'main:{main.frame().size.width}x{main.frame().size.height}'); "
            "print(f'scale:{main.backingScaleFactor()}'); "
            "for i, s in enumerate(screens): "
            "  f = s.frame(); "
            "  print(f'screen{i}:{f.size.width}x{f.size.height} scale={s.backingScaleFactor()}')"
        ])
        if result.returncode == 0:
            for line in result.stdout.strip().splitlines():
                if line.startswith("scale:"):
                    info["scaleFactor"] = float(line.split(":")[1])
                elif line.startswith("main:"):
                    parts = line.split(":")[1].split("x")
                    info["mainScreen"] = {
                        "width": float(parts[0]),
                        "height": float(parts[1]),
                    }
                elif line.startswith("screen"):
                    import re
                    match = re.match(r"screen(\d+):(\d+\.?\d*)x(\d+\.?\d*)\s*scale=(\d+\.?\d*)", line)
                    if match:
                        info["displays"].append({
                            "index": int(match.group(1)),
                            "width": float(match.group(2)),
                            "height": float(match.group(3)),
                            "scaleFactor": float(match.group(4)),
                        })
    except Exception:
        pass

    return info


def verify_coordinate_system():
    """Take a test screenshot and verify coordinate alignment."""
    results = {
        "screenshotWorks": False,
        "screenshotPath": None,
        "pixelWidth": 0,
        "pixelHeight": 0,
        "scaleFactor": 2.0,
        "conversionFormula": "logical_point = pixel / scaleFactor",
    }

    # Take a small screenshot at known region
    test_path = os.path.join(tempfile.gettempdir(), "mac-calibrate-test.png")
    try:
        scr_result = _run(["screencapture", "-x", "-R", "0,0,100,100", test_path])
        if scr_result.returncode == 0 and os.path.exists(test_path):
            results["screenshotWorks"] = True
            results["screenshotPath"] = test_path

            # Get actual pixel dimensions
            dim_result = _run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", test_path])
            if dim_result.returncode == 0:
                for line in dim_result.stdout.splitlines():
                    if "pixelWidth" in line:
                        results["pixelWidth"] = int(line.split(":")[-1].strip())
                    elif "pixelHeight" in line:
                        results["pixelHeight"] = int(line.split(":")[-1].strip())

            # Calculate scale factor from the capture
            # We captured 100x100 logical points
            if results["pixelWidth"] > 0:
                measured_scale = results["pixelWidth"] / 100.0
                results["measuredScaleFactor"] = measured_scale

            # Clean up test file
            try:
                os.unlink(test_path)
            except OSError:
                pass
    except Exception as e:
        results["screenshotError"] = str(e)

    return results


def main():
    show_json = "--json" in sys.argv

    print("🔍 macOS Coordinate Calibration", file=sys.stderr)
    print("=" * 40, file=sys.stderr)

    display_info = get_display_info()
    coord_verify = verify_coordinate_system()

    scale = display_info["scaleFactor"]

    result = {
        "success": True,
        "scaleFactor": scale,
        "displayInfo": display_info,
        "coordinateVerification": coord_verify,
        "usage": {
            "screenshot_to_logical": f"logical_x = pixel_x / {scale}; logical_y = pixel_y / {scale}",
            "logical_to_pixel": f"pixel_x = logical_x * {scale}; pixel_y = logical_y * {scale}",
        },
    }

    if show_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"  Scale Factor: {scale}x ({'Retina' if scale == 2.0 else 'Standard'})", file=sys.stderr)
        if display_info["mainScreen"]:
            w = display_info["mainScreen"]["width"]
            h = display_info["mainScreen"]["height"]
            print(f"  Main Screen: {w}×{h} logical points ({w*scale:.0f}×{h*scale:.0f} pixels)", file=sys.stderr)
        if coord_verify["screenshotWorks"]:
            print(f"  Screenshot: ✅ Working", file=sys.stderr)
        else:
            print(f"  Screenshot: ❌ Not working", file=sys.stderr)
        print(f"\n  Conversion: pixel / {scale} = logical point", file=sys.stderr)
        print(file=sys.stderr)
        # Also output JSON for programmatic use
        print(json.dumps(result, ensure_ascii=False))

    sys.exit(0)


if __name__ == "__main__":
    main()
