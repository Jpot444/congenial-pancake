#!/usr/bin/env python3
"""Generate the channel's icon and splash artwork from the web app's bison logo.

The build box has no ImageMagick and no Pillow, so this does the whole job with
the standard library: decode the source PNG by hand, scale it, composite it onto
the portal's background colour, and re-encode at each size Roku asks for.

Run from the repo root:  python3 roku/tools/make-images.py
"""

import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE = os.path.join(ROOT, "public", "bison.png")
OUT_DIR = os.path.join(ROOT, "roku", "images")

# Matches --bg / --brand-red / --text in public/styles.css, so the channel reads
# as the same product as the web player.
BG = (0x15, 0x10, 0x0F)
BRAND_RED = (0xA2, 0x1F, 0x24)


def read_png(path):
    """Decode an 8-bit RGBA non-interlaced PNG into (width, height, bytearray)."""
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG: %s" % path)

    pos = 8
    width = height = 0
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length  # length + type + body + crc

        if kind == b"IHDR":
            width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or colour != 6 or interlace != 0:
                raise ValueError("expected 8-bit RGBA, non-interlaced")
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break

    raw = zlib.decompress(bytes(idat))
    stride = width * 4
    pixels = bytearray(width * height * 4)

    # Undo the per-scanline filters (PNG spec, section 9).
    prev = bytearray(stride)
    at = 0
    for row in range(height):
        filter_type = raw[at]
        at += 1
        line = bytearray(raw[at : at + stride])
        at += stride
        for i in range(stride):
            left = line[i - 4] if i >= 4 else 0
            up = prev[i]
            upleft = prev[i - 4] if i >= 4 else 0
            if filter_type == 1:
                line[i] = (line[i] + left) & 0xFF
            elif filter_type == 2:
                line[i] = (line[i] + up) & 0xFF
            elif filter_type == 3:
                line[i] = (line[i] + (left + up) // 2) & 0xFF
            elif filter_type == 4:
                p = left + up - upleft
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - upleft)
                if pa <= pb and pa <= pc:
                    guess = left
                elif pb <= pc:
                    guess = up
                else:
                    guess = upleft
                line[i] = (line[i] + guess) & 0xFF
        pixels[row * stride : (row + 1) * stride] = line
        prev = line

    return width, height, pixels


def write_png(path, width, height, pixels):
    """Encode an 8-bit RGBA buffer as a PNG."""
    stride = width * 4
    raw = bytearray()
    for row in range(height):
        raw.append(0)  # filter: none — these are small images, size is not a concern
        raw += pixels[row * stride : (row + 1) * stride]

    def chunk(kind, body):
        return (
            struct.pack(">I", len(body))
            + kind
            + body
            + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
        )

    blob = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as handle:
        handle.write(blob)


def sample(src, src_w, src_h, x, y):
    """Nearest-neighbour read, clamped to the source bounds."""
    x = min(max(x, 0), src_w - 1)
    y = min(max(y, 0), src_h - 1)
    at = (y * src_w + x) * 4
    return src[at], src[at + 1], src[at + 2], src[at + 3]


def compose(width, height, logo, logo_w, logo_h, scale, accent_bar):
    """Paint the background, then the logo centred at `scale` of the width."""
    canvas = bytearray()
    for _ in range(width * height):
        canvas += bytes((BG[0], BG[1], BG[2], 255))

    if accent_bar:
        # A thin brand-red rule along the bottom, the same accent the web
        # player uses under the active tab.
        bar = max(2, height // 90)
        for y in range(height - bar, height):
            for x in range(width):
                at = (y * width + x) * 4
                canvas[at : at + 3] = bytes(BRAND_RED)

    target_w = max(1, int(width * scale))
    target_h = max(1, int(target_w * logo_h / logo_w))
    if target_h > height * 0.7:
        target_h = int(height * 0.7)
        target_w = max(1, int(target_h * logo_w / logo_h))

    off_x = (width - target_w) // 2
    off_y = (height - target_h) // 2

    for y in range(target_h):
        for x in range(target_w):
            r, g, b, a = sample(
                logo, logo_w, logo_h, x * logo_w // target_w, y * logo_h // target_h
            )
            if a == 0:
                continue
            at = ((off_y + y) * width + (off_x + x)) * 4
            # Straight alpha over the flat background.
            canvas[at] = (r * a + canvas[at] * (255 - a)) // 255
            canvas[at + 1] = (g * a + canvas[at + 1] * (255 - a)) // 255
            canvas[at + 2] = (b * a + canvas[at + 2] * (255 - a)) // 255

    return canvas


# name -> (width, height, logo scale, draw the accent bar)
TARGETS = {
    "icon_focus_hd.png": (290, 218, 0.62, True),
    "icon_focus_sd.png": (248, 140, 0.52, True),
    "icon_side_hd.png": (108, 69, 0.66, False),
    "icon_side_sd.png": (80, 46, 0.62, False),
    "splash_sd.png": (720, 480, 0.34, False),
    "splash_hd.png": (1280, 720, 0.30, False),
    "splash_fhd.png": (1920, 1080, 0.30, False),
}


def main():
    logo_w, logo_h, logo = read_png(SOURCE)
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, (width, height, scale, bar) in TARGETS.items():
        canvas = compose(width, height, logo, logo_w, logo_h, scale, bar)
        write_png(os.path.join(OUT_DIR, name), width, height, canvas)
        print("wrote %s (%dx%d)" % (name, width, height))


if __name__ == "__main__":
    main()
