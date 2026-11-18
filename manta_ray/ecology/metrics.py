"""Image-domain measurements for repeatable aquatic vegetation screening."""

from dataclasses import asdict, dataclass
import math
import struct
import zlib

WIDTH = 320
FRAME_BYTES = WIDTH * WIDTH * 4


@dataclass(frozen=True)
class ImageMetrics:
    status: str
    candidate_green_cover_pct: float | None
    valid_pixels: int
    median_luma: int
    contrast_p90_p10: int
    dark_pixel_pct: float
    clipped_pixel_pct: float
    mean_gradient: float


def analyze(frame, minimum_brightness=24, minimum_contrast=18,
            green_excess=12, saturation=0.20):
    """Measure the selected view. Green segmentation needs independent validation."""
    if len(frame) != FRAME_BYTES:
        raise ValueError("Expected one 320 by 320 RGBA frame")
    histogram = [0] * 256
    mask = bytearray([128]) * (WIDTH * WIDTH)
    lumas = bytearray(WIDTH * WIDTH)
    valid = green_count = dark = clipped = gradient = edges = 0
    for pixel, offset in enumerate(range(0, len(frame), 4)):
        red, green, blue, alpha = frame[offset:offset + 4]
        if not alpha:
            continue
        valid += 1
        luma = (54 * red + 183 * green + 19 * blue) // 256
        lumas[pixel] = luma
        histogram[luma] += 1
        dark += luma < 16
        clipped += luma > 239
        selected = (green - max(red, blue) >= green_excess
                    and green - min(red, blue) >= saturation * green)
        mask[pixel] = 255 if selected else 0
        green_count += selected
        for neighbor in (pixel - 1, pixel - WIDTH):
            if neighbor < 0 or (neighbor == pixel - 1 and pixel % WIDTH == 0):
                continue
            if mask[neighbor] != 128:
                gradient += abs(luma - lumas[neighbor])
                edges += 1

    def percentile(fraction):
        target = math.ceil(fraction * valid)
        count = 0
        for value, occurrences in enumerate(histogram):
            count += occurrences
            if count >= target:
                return value
        return 0

    median = percentile(0.5) if valid else 0
    contrast = percentile(0.9) - percentile(0.1) if valid else 0
    status = "usable"
    if not valid or median < minimum_brightness:
        status = "too_dark"
    elif contrast < minimum_contrast:
        status = "low_contrast"
    coverage = 100 * green_count / valid if valid and status == "usable" else None
    return ImageMetrics(status, coverage, valid, median, contrast,
                        100 * dark / valid if valid else 0,
                        100 * clipped / valid if valid else 0,
                        gradient / edges if edges else 0), mask


def write_overlay(path, frame, mask):
    rgb = bytearray(WIDTH * WIDTH * 3)
    rgb[0::3], rgb[1::3], rgb[2::3] = frame[0::4], frame[1::4], frame[2::4]
    for index, value in enumerate(mask):
        if value == 255:
            offset = index * 3
            red, green, blue = rgb[offset:offset + 3]
            rgb[offset:offset + 3] = bytes((red // 2, (green + 255) // 2, (blue + 80) // 2))

    def chunk(kind, payload):
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload)))

    stride = WIDTH * 3
    scanlines = b"".join(b"\0" + rgb[offset:offset + stride]
                         for offset in range(0, len(rgb), stride))
    path.write_bytes(b"\x89PNG\r\n\x1a\n"
                     + chunk(b"IHDR", struct.pack(">IIBBBBB", WIDTH, WIDTH, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b""))


def write_mask(path, mask):
    path.write_bytes(f"P5\n{WIDTH} {WIDTH}\n255\n".encode("ascii") + mask)


def numeric_fields(metrics):
    return {key: round(value, 5) if isinstance(value, float) else value
            for key, value in asdict(metrics).items()}
