import pytest
from validation.analyzer import (
    SampleResult, compute_metrics, unbiased_calibration, optimal_calibration_mae,
)


def _sr(raw_total, true_total, subject="a"):
    return SampleResult(
        filename="x.jpg", subject_id=subject,
        true_total=true_total, true_left=None, true_right=None,
        raw_total=raw_total, left_pd=0.0, right_pd=0.0,
        pupil_px=270.0, diam_avg_px=50.0, diam_left_px=50.0, diam_right_px=50.0,
        eye_open_min=8.0, roll_ratio=0.0, nose_offset_ratio=0.0, iris_diam_asym=0.0,
        quality_score=0.9, overall_valid=True, card_total=None, img_w=900, img_h=1200,
    )


def test_compute_metrics_basic():
    results = [_sr(63.0, 63.0), _sr(65.0, 63.0)]  # errors 0, +2
    m = compute_metrics(results, 1.0)
    assert m.n == 2
    assert m.mean_error == pytest.approx(1.0)
    assert m.mae == pytest.approx(1.0)
    assert m.max_abs == pytest.approx(2.0)
    assert m.within_1mm_pct == pytest.approx(50.0)
    assert m.within_2mm_pct == pytest.approx(100.0)


def test_unbiased_calibration():
    results = [_sr(100.0, 110.0), _sr(100.0, 110.0)]
    assert unbiased_calibration(results) == pytest.approx(1.10)


def test_optimal_calibration_mae():
    results = [_sr(100.0, 110.0), _sr(100.0, 110.0)]
    k = optimal_calibration_mae(results)
    assert k == pytest.approx(1.10, abs=0.0011)
