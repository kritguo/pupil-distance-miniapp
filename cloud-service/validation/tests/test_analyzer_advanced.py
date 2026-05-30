import pytest
from validation.analyzer import (
    SampleResult, iris_variance, correlations, card_comparison, analyze, Report,
)


def _sr(raw_total, true_total, subject="a", card_total=None, pupil_px=270.0, diam=50.0):
    return SampleResult(
        filename="x.jpg", subject_id=subject,
        true_total=true_total, true_left=None, true_right=None,
        raw_total=raw_total, left_pd=0.0, right_pd=0.0,
        pupil_px=pupil_px, diam_avg_px=diam, diam_left_px=diam, diam_right_px=diam,
        eye_open_min=8.0, roll_ratio=0.0, nose_offset_ratio=0.0, iris_diam_asym=0.0,
        quality_score=0.9, overall_valid=True, card_total=card_total, img_w=900, img_h=1200,
    )


def test_iris_variance_single_subject_self_calibrates_to_zero():
    # 单样本:用其自身有效虹膜直径反算,误差应为 0
    r = _sr(raw_total=63.0, true_total=63.0, pupil_px=270.0, diam=50.0)
    iv = iris_variance([r])
    assert iv.n_subjects == 1
    assert iv.mean_hvid == pytest.approx(63.0 * 50.0 / 270.0)
    assert iv.individual_calibrated_mae == pytest.approx(0.0, abs=1e-9)


def test_correlations_returns_keys():
    results = [_sr(63.0, 63.0), _sr(65.0, 63.0), _sr(61.0, 63.0)]
    cors = correlations(results, 1.0)
    assert set(cors.keys()) == {
        "iris_diam_asym", "quality_score", "eye_open_min", "resolution_min_dim",
    }


def test_card_comparison_counts_closer():
    # 卡片真值更接近:iris 偏 +3,card 偏 +0.5
    results = [_sr(66.0, 63.0, card_total=63.5), _sr(66.0, 63.0, card_total=63.5)]
    cc = card_comparison(results, 1.0)
    assert cc["n"] == 2
    assert cc["card_mae"] == pytest.approx(0.5)
    assert cc["iris_mae"] == pytest.approx(3.0)
    assert cc["card_closer_pct"] == pytest.approx(100.0)


def test_card_comparison_none_when_no_card():
    assert card_comparison([_sr(63.0, 63.0)], 1.0) is None


def test_analyze_bundles_report():
    results = [_sr(100.0, 110.0), _sr(100.0, 110.0)]
    rep = analyze(results)
    assert isinstance(rep, Report)
    assert rep.k_mae == pytest.approx(1.10, abs=0.0011)
    assert rep.metrics_before.calibration == 1.0
    assert rep.metrics_after.mae < rep.metrics_before.mae
    assert rep.n_valid == 2
