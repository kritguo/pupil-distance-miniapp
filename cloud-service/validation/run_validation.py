import argparse
import os
from validation.dataset_loader import load_dataset
from validation.measure_adapter import measure_image
from validation.analyzer import SampleResult, analyze
from validation.reporter import render_markdown, write_csv, render_console

DEFAULT_DATASET = os.path.join(os.path.dirname(__file__), "dataset")
DEFAULT_REPORTS = os.path.join(os.path.dirname(__file__), "reports")


def _to_sample_result(sample, out) -> SampleResult:
    return SampleResult(
        filename=sample.filename, subject_id=sample.subject_id,
        true_total=sample.true_total, true_left=sample.true_left, true_right=sample.true_right,
        raw_total=out.raw_total, left_pd=out.left_pd, right_pd=out.right_pd,
        pupil_px=out.pupil_px, diam_avg_px=out.diam_avg_px,
        diam_left_px=out.diam_left_px, diam_right_px=out.diam_right_px,
        eye_open_min=out.eye_open_min, roll_ratio=out.roll_ratio,
        nose_offset_ratio=out.nose_offset_ratio, iris_diam_asym=out.iris_diam_asym,
        quality_score=out.quality_score, overall_valid=out.overall_valid,
        card_total=out.card_total, img_w=out.img_w, img_h=out.img_h,
    )


def _failed_row(sample, out):
    from validation.dataset_loader import InvalidRow
    return InvalidRow(line_no=-1, filename=sample.filename, reason=f"measure_failed:{out.reason}")


def render_markdown_empty(invalid) -> str:
    lines = ["# 测量精度验证报告", "", "**无有效样本。**", "", "## 无效样本", ""]
    if not invalid:
        lines.append("无(数据集为空)。")
    else:
        lines.append("| 行号 | 文件 | 原因 |")
        lines.append("|---|---|---|")
        for iv in invalid:
            lines.append(f"| {iv.line_no} | {iv.filename} | {iv.reason} |")
    return "\n".join(lines)


def run(dataset_dir: str, report_dir: str) -> str:
    samples, invalid = load_dataset(dataset_dir)
    results = []
    for s in samples:
        out = measure_image(s.image_path)
        if out.ok:
            results.append(_to_sample_result(s, out))
        else:
            invalid.append(_failed_row(s, out))

    os.makedirs(report_dir, exist_ok=True)
    if not results:
        md = render_markdown_empty(invalid)
        with open(os.path.join(report_dir, "validation-report.md"), "w", encoding="utf-8") as f:
            f.write(md)
        return f"无有效样本(无效 {len(invalid)} 条),请检查 {dataset_dir}"

    report = analyze(results)
    md = render_markdown(report, results, invalid)
    with open(os.path.join(report_dir, "validation-report.md"), "w", encoding="utf-8") as f:
        f.write(md)
    write_csv(results, os.path.join(report_dir, "per-sample.csv"))
    return render_console(report)


def main():
    parser = argparse.ArgumentParser(description="测量精度离线验证")
    parser.add_argument("--dataset", default=DEFAULT_DATASET, help="数据集目录")
    parser.add_argument("--report-dir", default=DEFAULT_REPORTS, help="报告输出目录")
    args = parser.parse_args()
    summary = run(args.dataset, args.report_dir)
    print(summary)
    print(f"报告已写入:{args.report_dir}")


if __name__ == "__main__":
    main()
