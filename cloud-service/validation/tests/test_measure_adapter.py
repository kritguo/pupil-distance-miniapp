import os
import pytest
from validation.measure_adapter import build_output, measure_image, MeasureOutput


def test_build_output_assembles_unrounded_total():
    iris = {
        "diam_avg_px": 50.0, "diam_left_px": 49.0, "diam_right_px": 51.0,
        "eye_open_left": 8.0, "eye_open_right": 7.0,
    }
    pd = {"total": 63.0, "left": 31.5, "right": 31.5, "scale": 0.234, "pupil_px": 270.0}
    validation = {
        "overall_valid": True,
        "details": {"roll_ratio": 0.02, "nose_offset_ratio": 0.03, "iris_diam_asym": 0.04},
    }
    quality = {"score": 0.92}
    out = build_output(iris, pd, 64.0, validation, quality, (1200, 900, 3))
    assert out.ok is True
    assert out.raw_total == pytest.approx(270.0 * 0.234)  # 未取整
    assert out.pupil_px == 270.0
    assert out.diam_avg_px == 50.0
    assert out.eye_open_min == 7.0
    assert out.iris_diam_asym == 0.04
    assert out.quality_score == 0.92
    assert out.overall_valid is True
    assert out.card_total == 64.0
    assert out.img_w == 900 and out.img_h == 1200


FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "sample_face.jpg")


@pytest.mark.skipif(not os.path.exists(FIXTURE), reason="no fixture face image")
def test_measure_image_real_face():
    out = measure_image(FIXTURE)
    assert out.ok is True
    assert 40.0 < out.raw_total < 90.0
    assert out.pupil_px > 0 and out.diam_avg_px > 0


def test_measure_image_missing_file_returns_not_ok():
    out = measure_image("/no/such/file.jpg")
    assert out.ok is False
    assert out.reason == "image_read_failed"
