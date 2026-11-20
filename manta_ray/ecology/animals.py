"""Run optional fish inference in an isolated runtime; keep unavailable distinct from zero."""
import json
from pathlib import Path
import subprocess


def detect(video, output, interval=1, start=0, duration=None, max_samples=30, threshold=0.5):
    root = Path(__file__).resolve().parents[2]
    runtime = root / '.tools/animal-env/Scripts/python.exe'
    model = root / '.tools/animals/model.pth'
    if not runtime.is_file() or not model.is_file():
        return {'status': 'not_configured', 'reason': 'Install the optional animal runtime and model; see GUIDE.md.',
                'detections': None, 'unique_individuals': None}
    command = [str(runtime), str(Path(__file__).with_name('animals_worker.py')),
               '--video', str(video), '--model', str(model), '--output', str(output),
               '--interval', str(interval), '--start', str(start), '--max-samples', str(max_samples),
               '--threshold', str(threshold)]
    if duration is not None:
        command.extend(['--duration', str(duration)])
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=900)
        if result.returncode:
            return {'status': 'failed', 'reason': result.stderr[-2000:] or 'Fish inference failed',
                    'detections': None, 'unique_individuals': None}
        report = json.loads(output.read_text(encoding='utf-8'))
        return {key: value for key, value in report.items() if key != 'frames'}
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        return {'status': 'failed', 'reason': str(error), 'detections': None, 'unique_individuals': None}
