import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from image_sizing import get_resize_dimensions


def test_large_portrait_image_is_downscaled_with_ratio_preserved():
    assert get_resize_dimensions(3024, 4032, 1280) == (960, 1280)


def test_large_landscape_image_is_downscaled_with_ratio_preserved():
    assert get_resize_dimensions(4032, 3024, 1280) == (1280, 960)


def test_small_image_is_not_upscaled():
    assert get_resize_dimensions(900, 1200, 1280) == (900, 1200)
