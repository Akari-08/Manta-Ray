"""CPU Community Fish Detector inference on numerical frame samples. No playback/UI."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


def summarize(frames):
    counts = [len(frame['detections']) for frame in frames]
    return {'sampled_frames': len(counts), 'frames_with_fish': sum(count > 0 for count in counts),
            'detections': sum(counts), 'maximum_simultaneous_fish': max(counts, default=0),
            'unique_individuals': None, 'identified_taxa': None,
            'interpretation': 'Unreviewed generic-fish detections in sampled frames; summed boxes are not unique animals. Moving-camera maximum is descriptive, not standardized MaxN or population size.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('video', 'model', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--interval', type=float, default=1)
    parser.add_argument('--start', type=float, default=0)
    parser.add_argument('--duration', type=float)
    parser.add_argument('--max-samples', type=int, default=30)
    parser.add_argument('--threshold', type=float, default=0.5)
    args = parser.parse_args()
    if not 0 < args.threshold <= 1 or args.interval <= 0 or args.start < 0 or args.max_samples < 1:
        parser.error('Invalid inference threshold or sampling settings')
    provenance = json.loads(args.model.with_name('model-source.json').read_text(encoding='utf-8-sig'))
    actual = hashlib.sha256(args.model.read_bytes()).hexdigest()
    if actual != provenance['sha256']:
        raise ValueError('Animal model checksum changed')
    import torch
    from PIL import Image
    from rfdetr import from_checkpoint
    torch.set_num_threads(4)
    model = from_checkpoint(str(args.model))
    frames = []
    with tempfile.TemporaryDirectory(prefix='manta-fish-') as temporary:
        directory = Path(temporary)
        command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
                   '-filter_threads', '1', '-ss', str(args.start), '-i', str(args.video)]
        if args.duration is not None:
            command.extend(['-t', str(args.duration)])
        command.extend(['-vf', f'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709,fps={1/args.interval}:start_time=0:round=up,scale=1024:1024:force_original_aspect_ratio=decrease',
                        '-frames:v', str(args.max_samples), str(directory / 'frame_%06d.png')])
        subprocess.run(command, check=True, capture_output=True)
        for index, filename in enumerate(sorted(directory.glob('frame_*.png'))):
            with Image.open(filename) as source:
                image = source.convert('RGB')
                width, height = image.size
                predictions = model.predict(image, threshold=args.threshold)
                boxes = []
                for box, confidence in zip(predictions.xyxy, predictions.confidence):
                    boxes.append({'label': 'fish', 'confidence': float(confidence),
                                  'xyxy_normalized': [max(0, min(1, float(value) / dimension)) for value, dimension in zip(box, (width, height, width, height))]})
            frames.append({'timestamp_s': args.start + index * args.interval, 'detections': boxes})
    if not frames:
        raise ValueError('No frames available for animal inference')
    with args.video.open('rb') as source:
        source_sha = hashlib.file_digest(source, 'sha256').hexdigest()
    report = {'status': 'completed', 'method': 'community_fish_detector_rf_detr_medium',
              'model': provenance, 'confidence_threshold': args.threshold, 'validation': 'local biological accuracy unvalidated',
              'source_sha256': source_sha,
              'color_conversion': 'Explicit BT.709 decoding assumption; not a color calibration',
              **summarize(frames), 'frames': frames}
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
