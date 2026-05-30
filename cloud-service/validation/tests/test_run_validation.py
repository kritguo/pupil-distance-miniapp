import os
from validation import run_validation as rv
from validation.measure_adapter import MeasureOutput


def test_run_writes_reports(tmp_path, monkeypatch):
    # 造数据集:两张图同一人
    ds = tmp_path / "dataset"
    images = ds / "images"
    images.mkdir(parents=True)
    (images / "001.jpg").write_bytes(b"x")
    (images / "002.jpg").write_bytes(b"x")
    header = "filename,subject_id,true_pd_total,true_pd_left,true_pd_right,notes\n"
    (ds / "labels.csv").write_text(
        header + "001.jpg,a,110,,,\n002.jpg,a,110,,,\n", encoding="utf-8")

    # 跳过真实 mediapipe:measure_image 返回固定结果
    def fake_measure(path):
        return MeasureOutput(ok=True, raw_total=100.0, pupil_px=270.0, diam_avg_px=50.0,
                             quality_score=0.9, overall_valid=True, img_w=900, img_h=1200)
    monkeypatch.setattr(rv, "measure_image", fake_measure)

    report_dir = tmp_path / "reports"
    summary = rv.run(str(ds), str(report_dir))

    assert (report_dir / "validation-report.md").exists()
    assert (report_dir / "per-sample.csv").exists()
    assert "PD_CALIBRATION=1.1" in summary


def test_run_handles_empty_valid_set(tmp_path, monkeypatch):
    ds = tmp_path / "dataset"
    (ds / "images").mkdir(parents=True)
    header = "filename,subject_id,true_pd_total,true_pd_left,true_pd_right,notes\n"
    (ds / "labels.csv").write_text(header + "ghost.jpg,a,110,,,\n", encoding="utf-8")
    summary = rv.run(str(ds), str(tmp_path / "reports"))
    assert "无有效样本" in summary
