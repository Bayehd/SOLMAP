# Rover cut-out from two identical views, with and without the rover (scripts/capture_rover_front.mjs): a pixel is
# rover where the two differ. Prints the rover's box; crop to it (with a small margin), save as
# public/models/rover-front.webp and set ROVER_FRONT in src/map/MapApp.tsx from the crop, in CSS px (÷ 1.5).
# usage: python scripts/cutout_rover_front.py /tmp/rover-with.png /tmp/rover-without.png /tmp/rover-cut.png
import sys
import numpy as np
from PIL import Image, ImageFilter

w = np.asarray(Image.open(sys.argv[1]).convert('RGB'), dtype=np.float32)
b = np.asarray(Image.open(sys.argv[2]).convert('RGB'), dtype=np.float32)
d = np.abs(w - b).max(axis=2)
mask = d > 10  # rover pixels (render noise is a few levels at most)


def keep_large(mask: np.ndarray, min_px: int) -> np.ndarray:
    """Drop connected pieces smaller than min_px (stray lines where something else changed between the views)."""
    h, w = mask.shape
    label = np.zeros((h, w), np.int32)
    keep = np.zeros((h, w), bool)
    n = 0
    for y0, x0 in zip(*np.nonzero(mask)):
        if label[y0, x0]:
            continue
        n += 1
        stack, pix = [(y0, x0)], []
        label[y0, x0] = n
        while stack:
            y, x = stack.pop()
            pix.append((y, x))
            for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not label[yy, xx]:
                    label[yy, xx] = n
                    stack.append((yy, xx))
        if len(pix) >= min_px:
            ys, xs = zip(*pix)
            keep[list(ys), list(xs)] = True
    return keep


# The rover is one big piece: anything thinner than ~6 px is removed first, then pieces under 2% of the rover.
thick = np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(7)).filter(ImageFilter.MaxFilter(7))) > 0
big = keep_large(thick[::2, ::2], 2000)
big = np.asarray(Image.fromarray((big * 255).astype(np.uint8)).resize((mask.shape[1], mask.shape[0])).filter(ImageFilter.MaxFilter(15))) > 0
mask &= big  # thin rover parts (cables, rods) are kept where they touch the main body
m = Image.fromarray((mask * 255).astype(np.uint8))
# Fill pinholes where the rover happens to match the ground color, then soften the edge by one pixel.
m = m.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(0.8))
alpha = np.asarray(m)
out = np.dstack([w.astype(np.uint8), alpha])
ys, xs = np.nonzero(alpha > 8)
print('rover box', xs.min(), ys.min(), xs.max(), ys.max(), 'of', w.shape[1], w.shape[0])
Image.fromarray(out).save(sys.argv[3], optimize=True)
