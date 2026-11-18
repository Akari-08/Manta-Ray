"""Run the test suite and unattended stock-media workflows, retaining evidence."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

from .ecology.__main__ import file_hash


def source_digest(root):
    digest = hashlib.sha256()
    for directory in ("manta_ray", "tests"):
        for path in sorted((root / directory).rglob("*.py")):
            digest.update(path.relative_to(root).as_posix().encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--media", type=Path, default=Path("media"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parent.parent
    output = args.output.resolve()
    try:
        if output.exists():
            raise ValueError("Choose a new output directory to preserve previous evidence")
        clips = sorted(path for path in args.media.resolve().iterdir()
                       if path.suffix.lower() in {".mp4", ".mov", ".mkv", ".avi", ".webm"})
        if not clips:
            raise ValueError("No supported media files found")
        output.mkdir(parents=True)
        report = {"created_utc": datetime.now(timezone.utc).isoformat(),
                  "python": sys.version, "source_sha256": source_digest(root),
                  "video_content_displayed": False,
                  "validation_scope": "software tests and unlabeled stock-media processing",
                  "ecological_accuracy": "unmeasured; independent reference labels unavailable",
                  "colmap_reconstruction": "not_run; extract-only verification",
                  "test_command": [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
                  "clips": []}
        started = time.monotonic()
        tests = subprocess.run(report["test_command"], cwd=root, capture_output=True, text=True)
        report["tests_return_code"] = tests.returncode
        (output / "test-output.txt").write_text(tests.stdout + tests.stderr, encoding="utf-8")
        for index, clip in enumerate(clips, 1):
            target = output / f"clip-{index:02d}"
            item = {"name": clip.name, "sha256": file_hash(clip), "workflows": []}
            report["clips"].append(item)
            for module, options in (
                ("ecology", ["--video-source", "stock", "--interval", "0.5",
                             "--simulated-tds-ppm", "150"]),
                ("reconstruction", ["--extract-only"]),
            ):
                destination = target / module
                command = [sys.executable, "-m", f"manta_ray.{module}", str(clip),
                           "--output", str(destination), *options]
                print(f"Processing {clip.name} with {module}", flush=True)
                result = subprocess.run(command, cwd=root, capture_output=True, text=True)
                item["workflows"].append({"module": module, "command": command,
                                          "return_code": result.returncode,
                                          "stdout": result.stdout, "stderr": result.stderr})
                summary_name = "summary.json" if module == "ecology" else "reconstruction.json"
                summary_path = destination / summary_name
                if result.returncode == 0:
                    summary = json.loads(summary_path.read_text(encoding="utf-8"))
                    item[module] = (summary["imagery"] if module == "ecology" else {
                        "extracted_frames": summary["extracted_frames"],
                        "unique_frames": summary["frame_quality"]["unique_grayscale_frames"],
                        "color_fallback": summary["video"]["reserved_color_metadata_fallback"],
                    })
        report["runtime_seconds"] = round(time.monotonic() - started, 3)
        report["passed"] = tests.returncode == 0 and all(
            workflow["return_code"] == 0 for clip in report["clips"] for workflow in clip["workflows"]
        )
        (output / "results.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        print(output / "results.json")
        return 0 if report["passed"] else 1
    except (OSError, ValueError) as error:
        parser.exit(1, f"verify: {error}\n")


if __name__ == "__main__":
    sys.exit(main())
