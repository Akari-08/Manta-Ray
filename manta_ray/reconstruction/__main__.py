"""Extract overlapping views of a survey clip and reconstruct them with COLMAP."""

import argparse
from contextlib import closing
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile


class ReconstructionError(RuntimeError):
    """A survey clip or external tool could not complete the requested workflow."""


def find_tool(name, override=None):
    candidate = Path(override).expanduser() if override else None
    located = str(candidate) if candidate and candidate.is_file() else shutil.which(override or name)
    if not located and name == "colmap" and not override and os.name == "nt":
        located = shutil.which("COLMAP.bat")
    if not located:
        if name == "colmap":
            raise ReconstructionError(
                "COLMAP was not found. Supply --colmap with the path to an existing "
                "COLMAP executable or use --extract-only to export frames."
            )
        raise ReconstructionError(f"{name} was not found on PATH.")
    path = Path(located).resolve()
    if os.name == "nt" and path.suffix.lower() in {".bat", ".cmd"}:
        # The official Windows archive puts the real executable beside its DLLs.
        # Invoke it directly so user paths never pass through the command shell.
        executable = path.parent / "bin" / "colmap.exe"
        if name != "colmap" or not executable.is_file():
            raise ReconstructionError(f"Use an executable rather than a batch wrapper: {path}")
        path = executable
    return path


def run_tool(executable, arguments, work_dir):
    environment = None
    if os.name == "nt" and executable.name.lower() == "colmap.exe":
        environment = os.environ.copy()
        environment["PATH"] = str(executable.parent) + os.pathsep + environment.get("PATH", "")
        plugins = executable.parent.parent / "plugins"
        if plugins.is_dir():
            environment["QT_PLUGIN_PATH"] = str(plugins)
    result = subprocess.run(
        [str(executable), *arguments],
        cwd=work_dir,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if executable.name.lower() == "colmap.exe" or executable.name.lower() == "colmap":
        stage = arguments[0]
        if len(arguments) > 1 and arguments[1] in {"-h", "--help"}:
            stage += "-help"
        (work_dir / f"colmap-{stage}.log").write_text(result.stdout, encoding="utf-8")
    if result.returncode:
        detail = "\n".join(result.stdout.splitlines()[-15:])
        raise ReconstructionError(
            f"{executable.name} {arguments[0]} exited with status {result.returncode}.\n{detail}"
        )
    return result.stdout


def extract_frames(ffmpeg, args, source, output, color_filter=None):
    frames = output / "frames"
    frames.mkdir()
    # Select actual decoded frames by timestamp rather than resampling and duplicating frames.
    # The first frame at or after the requested seek is always selected.
    selection = (
        f"select=isnan(prev_selected_pts)+gte(pts-prev_selected_pts\\,1/({args.fps}*TB)-1e-6)"
    )
    if color_filter:
        selection = color_filter + "," + selection
    selection += (
        f",scale=w='min({args.max_size},iw)':h='min({args.max_size},ih)'"
        ":force_original_aspect_ratio=decrease:force_divisible_by=2"
    )
    time_limit = ["-t", str(args.duration)] if args.duration is not None else []
    run_tool(
        ffmpeg,
        [
            "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
            "-threads", "1", "-filter_threads", "1",
            "-ss", str(args.start), *time_limit, "-i", str(source),
            "-map", "0:v:0", "-vf", selection, "-fps_mode", "vfr",
            "-frames:v", str(args.max_frames), "-q:v", "2", "-threads", "1",
            "frames/frame-%06d.jpg",
        ],
        output,
    )
    count = sum(1 for frame in frames.glob("frame-*.jpg") if frame.stat().st_size > 0)
    if not count:
        raise ReconstructionError("The selected interval contains no video frames. Check --start and --duration.")
    return count


def cpu_option(colmap, stage, flags, output):
    help_text = run_tool(colmap, [stage, "-h"], output)
    for flag in flags:
        if flag in help_text:
            return [flag, "0"]
    raise ReconstructionError(f"Cannot find the CPU setting for COLMAP {stage} on this installation.")


def inspect_video(ffprobe, source, output):
    raw = run_tool(
        ffprobe,
        ["-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name,width,height,avg_frame_rate,duration,color_space,color_transfer,color_primaries:format=duration",
         "-of", "json", str(source)],
        output,
    )
    try:
        report = json.loads(raw)
        stream = report["streams"][0]
        fallback = {}
        for source_key, filter_key in (
            ("color_primaries", "color_primaries"), ("color_transfer", "color_trc"),
            ("color_space", "colorspace"),
        ):
            if stream.get(source_key) == "reserved":
                fallback[filter_key] = "bt709"
        return {
            "codec": stream.get("codec_name"),
            "width": stream["width"],
            "height": stream["height"],
            "average_frame_rate": stream.get("avg_frame_rate"),
            "duration_seconds": report.get("format", {}).get("duration", stream.get("duration")),
            "source_color_metadata": {key: stream.get(key) for key in (
                "color_space", "color_transfer", "color_primaries"
            )},
            "reserved_color_metadata_fallback": fallback,
        }
    except (ValueError, KeyError, IndexError) as error:
        raise ReconstructionError("FFprobe did not return usable video metadata.") from error


def frame_quality(ffmpeg, output, frame_count):
    """Compute image proxies without displaying frames or asserting reconstruction success."""
    result = subprocess.run(
        [str(ffmpeg), "-hide_banner", "-loglevel", "error", "-nostdin",
         "-threads", "1", "-filter_threads", "1",
         "-i", "frames/frame-%06d.jpg", "-vf", "scale=160:120,format=gray",
         "-frames:v", str(frame_count), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
        cwd=output, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=False,
    )
    width, height = 160, 120
    size = width * height
    if result.returncode or len(result.stdout) != frame_count * size:
        raise ReconstructionError(
            "Could not compute frame quality metrics. " + result.stderr.decode("utf-8", errors="replace")[-1000:]
        )
    metrics = []
    hashes = set()
    for index in range(frame_count):
        pixels = result.stdout[index * size:(index + 1) * size]
        hashes.add(hashlib.sha256(pixels).digest())
        mean = sum(pixels) / size
        variance = sum((value - mean) ** 2 for value in pixels) / size
        horizontal = sum(
            (pixels[row * width + column] - pixels[row * width + column - 1]) ** 2
            for row in range(height) for column in range(1, width)
        )
        vertical = sum((pixels[i] - pixels[i - width]) ** 2 for i in range(width, size))
        metrics.append({
            "frame": f"frame-{index + 1:06d}.jpg",
            "luma_mean_8bit": round(mean, 4),
            "luma_stddev_8bit": round(math.sqrt(variance), 4),
            "gradient_rms_8bit": round(math.sqrt(
                (horizontal + vertical) / (height * (width - 1) + width * (height - 1))
            ), 4),
            "dark_fraction": round(sum(value <= 5 for value in pixels) / size, 6),
            "bright_fraction": round(sum(value >= 250 for value in pixels) / size, 6),
        })
    return {
        "analysis_size": [width, height],
        "method": "FFmpeg grayscale downsample; pixel standard deviation and adjacent-pixel gradient RMS",
        "interpretation": "Contrast and edge-strength proxies require scene-specific validation. They do not establish overlap, depth accuracy, or successful registration.",
        "unique_grayscale_frames": len(hashes),
        "identical_grayscale_frames": frame_count - len(hashes),
        "frames": metrics,
    }


def feature_quality(database):
    """Summarize measured SIFT detections and geometrically verified image pairs."""
    with closing(sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)) as connection:
        keypoints = connection.execute("SELECT rows FROM keypoints ORDER BY image_id").fetchall()
        matches = connection.execute("SELECT rows FROM two_view_geometries WHERE rows > 0").fetchall()
    counts = [row[0] for row in keypoints]
    return {
        "images_with_keypoints": len(counts),
        "keypoints_total": sum(counts),
        "keypoints_min_per_image": min(counts, default=0),
        "keypoints_mean_per_image": sum(counts) / len(counts) if counts else 0,
        "verified_image_pairs": len(matches),
        "verified_correspondences_total": sum(row[0] for row in matches),
    }


def read_model_count(path):
    # COLMAP starts each of these binary model files with a little-endian uint64 count.
    with path.open("rb") as model_file:
        header = model_file.read(8)
    if len(header) != 8:
        raise ReconstructionError(f"COLMAP wrote an incomplete model file: {path}")
    return struct.unpack("<Q", header)[0]


def reconstruct(colmap, output, frame_count):
    if frame_count < 2:
        raise ReconstructionError("Reconstruction requires at least two overlapping views. Select a longer interval.")

    extract = "feature_extractor"
    match = "sequential_matcher"
    extract_cpu = cpu_option(
        colmap, extract, ("--FeatureExtraction.use_gpu", "--SiftExtraction.use_gpu"), output
    )
    match_cpu = cpu_option(
        colmap, match, ("--FeatureMatching.use_gpu", "--SiftMatching.use_gpu"), output
    )
    run_tool(
        colmap,
        [extract, "--database_path", "database.db", "--image_path", "frames",
         "--ImageReader.single_camera", "1", *extract_cpu],
        output,
    )
    run_tool(colmap, [match, "--database_path", "database.db", *match_cpu], output)
    features = feature_quality(output / "database.db")
    sparse = output / "sparse"
    sparse.mkdir()
    run_tool(
        colmap,
        ["mapper", "--database_path", "database.db", "--image_path", "frames",
         "--output_path", "sparse"],
        output,
    )

    models = []
    for directory in sorted(sparse.iterdir()):
        if not all((directory / name).is_file() for name in ("cameras.bin", "images.bin", "points3D.bin")):
            continue
        registered = read_model_count(directory / "images.bin")
        points = read_model_count(directory / "points3D.bin")
        if registered >= 2 and points:
            models.append((registered, points, directory))
    if not models:
        raise ReconstructionError(
            "COLMAP found no usable sparse model. Try a sharp clip with camera translation, "
            "more texture, and overlap between sampled frames."
        )
    registered, points, model = max(models, key=lambda item: item[:2])
    model_path = model.relative_to(output).as_posix()
    analysis_log = run_tool(colmap, ["model_analyzer", "--path", model_path], output)
    analysis = {}
    for label, name in (
        ("Observations", "observations"),
        ("Mean track length", "mean_track_length"),
        ("Mean observations per image", "mean_observations_per_image"),
        ("Mean reprojection error", "mean_reprojection_error_pixels"),
    ):
        match_value = re.search(rf"{label}: ([0-9.eE+-]+)", analysis_log)
        if match_value:
            value = float(match_value.group(1))
            if math.isfinite(value):
                analysis[name] = value
    run_tool(
        colmap,
        ["model_converter", "--input_path", model_path, "--output_path",
         "point-cloud.ply", "--output_type", "PLY"],
        output,
    )
    cloud = output / "point-cloud.ply"
    if not cloud.is_file():
        raise ReconstructionError("COLMAP did not write the point cloud.")
    with cloud.open("rb") as stream:
        if stream.readline(8).rstrip() != b"ply":
            raise ReconstructionError("COLMAP did not write a valid PLY header.")
        vertex_count = None
        for line in stream:
            line = line.rstrip()
            if line.startswith(b"element vertex "):
                vertex_count = line.removeprefix(b"element vertex ")
            if line == b"end_header":
                break
        else:
            raise ReconstructionError("COLMAP wrote an incomplete PLY header.")
        if vertex_count != str(points).encode("ascii") or not stream.read(1):
            raise ReconstructionError("The PLY point cloud does not match the reconstructed model.")
    return {
        "status": "reconstructed",
        "registered_frames": registered,
        "registered_frame_fraction": registered / frame_count,
        "points": points,
        "model_directory": model_path,
        "point_cloud": cloud.name,
        "scale": "arbitrary",
        "features": features,
        "model_analysis": analysis,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("clip", type=Path, help="source survey video")
    parser.add_argument("--output", type=Path, required=True, help="new directory for this run")
    parser.add_argument("--start", type=float, default=0.0, help="start offset in seconds")
    parser.add_argument("--duration", type=float, help="length of the interval in seconds")
    parser.add_argument("--fps", type=float, default=3.0, help="target maximum extraction rate (default: 3)")
    parser.add_argument("--max-frames", type=int, default=120, help="maximum frames to extract (default: 120)")
    parser.add_argument("--max-size", type=int, default=1600, help="longest extracted image dimension (default: 1600)")
    parser.add_argument("--extract-only", action="store_true", help="extract frames without invoking COLMAP")
    parser.add_argument("--colmap", help="path to an existing COLMAP executable")
    args = parser.parse_args(argv)

    if not math.isfinite(args.start) or args.start < 0:
        parser.error("--start must be a finite nonnegative number")
    if args.duration is not None and (not math.isfinite(args.duration) or args.duration <= 0):
        parser.error("--duration must be a finite positive number")
    if not math.isfinite(args.fps) or args.fps <= 0:
        parser.error("--fps must be a finite positive number")
    if args.max_frames < 1:
        parser.error("--max-frames must be at least 1")
    if args.max_size < 2:
        parser.error("--max-size must be at least 2")

    source = args.clip.resolve()
    output = args.output.resolve()
    try:
        if not source.is_file():
            raise ReconstructionError(f"Survey clip does not exist: {source}")
        if output.exists():
            raise ReconstructionError(f"Output directory already exists. Choose a new directory: {output}")
        ffmpeg = find_tool("ffmpeg")
        ffprobe = find_tool("ffprobe")
        colmap = None if args.extract_only else find_tool("colmap", args.colmap)
        output.parent.mkdir(parents=True, exist_ok=True)
        metadata = {
            "status": "frames_extracted",
            "source_clip": source.name,
            "start_seconds": args.start,
            "duration_seconds": args.duration,
            "target_fps": args.fps,
            "maximum_image_dimension": args.max_size,
            "frame_directory": "frames",
            "video": inspect_video(ffprobe, source, output.parent),
        }
        with source.open("rb") as source_file:
            metadata["source_sha256"] = hashlib.file_digest(source_file, "sha256").hexdigest()
        report = output / "reconstruction.json"
        with tempfile.TemporaryDirectory(dir=output.parent, prefix=".reconstruction-") as directory:
            staged = Path(directory) / "result"
            staged.mkdir()
            fallback = metadata["video"]["reserved_color_metadata_fallback"]
            color_filter = None
            if fallback:
                color_filter = "setparams=" + ":".join(
                    f"{key}={value}" for key, value in fallback.items()
                )
            frames = extract_frames(ffmpeg, args, source, staged, color_filter)
            metadata["extracted_frames"] = frames
            metadata["frame_quality"] = frame_quality(ffmpeg, staged, frames)
            (staged / report.name).write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
            staged.rename(output)
        if colmap is not None:
            try:
                version_text = run_tool(colmap, ["-h"], output)
                version = re.search(r"COLMAP ([0-9.]+)", version_text)
                metadata["colmap_version"] = version.group(1) if version else "unknown"
                metadata.update(reconstruct(colmap, output, frames))
            except (ReconstructionError, OSError, sqlite3.Error) as error:
                metadata.update({"status": "reconstruction_failed", "error": str(error)})
                updated = output / "reconstruction.json.tmp"
                updated.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
                updated.replace(report)
                raise
            updated = output / "reconstruction.json.tmp"
            updated.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
            updated.replace(report)
        print(report)
    except (ReconstructionError, OSError, sqlite3.Error) as error:
        print(f"Reconstruction error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
