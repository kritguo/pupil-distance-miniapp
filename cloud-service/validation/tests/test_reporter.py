import os
from validation.analyzer import SampleResult, analyze
from validation.dataset_loader import InvalidRow
from validation.reporter import render_markdown, write_csv


def _sr(raw_total, true_total, subject="a"):
    return SampleResult(
        filename="x.jpg", subject_id=subject,
        true_total=true_total, true_left=None, true_right=None,
        raw_total=raw_total, left_pd=0.0, right_pd=0.0,
        pupil_px=270.0, diam_avg_px=50.0, diam_left_px=50.0, diam_right_px=50.0,
        eye_open_min=8.0, roll_ratio=0.0, nose_offset_ratio=0.0, iris_diam_asym=0.0,
        quality_score=0.9, overall_valid=True, card_total=None, img_w=900, img_h=1200,
    )


def test_render_markdown_contains_key_sections():
    results = [_sr(100.0, 110.0), _sr(100.0, 110.0)]
    rep = analyze(results)
    md = render_markdown(rep, results, [InvalidRow(5, "bad.jpg", "image file not found")])
    assert "建议" in md and "PD_CALIBRATION" in md
    assert "1.1" in md  # 建议系数
    assert "bad.jpg" in md  # 无效样本被列出
    assert "命中率" in md


def test_write_csv_creates_file(tmp_path):
    results = [_sr(100.0, 110.0)]
    out = tmp_path / "per-sample.csv"
    write_csv(results, str(out))
    assert out.exists()
    text = out.read_text(encoding="utf-8")
    assert "filename" in text and "x.jpg" in text
