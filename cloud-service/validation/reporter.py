import csv
from typing import List
from validation.analyzer import Report, SampleResult
from validation.dataset_loader import InvalidRow


def _fmt(v, nd=2):
    if v is None:
        return "—"
    return f"{v:.{nd}f}"


def render_markdown(report: Report, results: List[SampleResult],
                    invalid: List[InvalidRow]) -> str:
    b, a = report.metrics_before, report.metrics_after
    lines = []
    lines.append("# 测量精度验证报告")
    lines.append("")
    lines.append(f"有效样本:{report.n_valid}　无效样本:{len(invalid)}")
    lines.append("")

    lines.append("## 1. 总体误差(标定前 calibration=1.0)")
    lines.append("")
    lines.append("| 指标 | 值 |")
    lines.append("|---|---|")
    lines.append(f"| 平均误差(系统偏差) | {_fmt(b.mean_error)} mm |")
    lines.append(f"| 标准差 | {_fmt(b.std_error)} mm |")
    lines.append(f"| MAE | {_fmt(b.mae)} mm |")
    lines.append(f"| P90 绝对误差 | {_fmt(b.p90_abs)} mm |")
    lines.append(f"| 最大绝对误差 | {_fmt(b.max_abs)} mm |")
    lines.append(f"| ±1mm 命中率 | {_fmt(b.within_1mm_pct, 1)}% |")
    lines.append(f"| ±2mm 命中率 | {_fmt(b.within_2mm_pct, 1)}% |")
    lines.append("")

    lines.append("## 2. 最优全局标定")
    lines.append("")
    lines.append(f"**建议把 `PD_CALIBRATION` 设为 {report.k_mae}**(最小化 MAE)。")
    lines.append(f"参考:令平均误差归零的无偏系数 = {report.k_unbiased}。")
    if report.calibration_at_boundary:
        lines.append("")
        lines.append("> ⚠️ **警告:最优系数命中了搜索范围边界 "
                     f"[{report.k_mae}],真实最优值可能在范围外。这通常意味着系统偏差异常大"
                     "(虹膜假设或数据有问题),请先核查数据与拍摄,不要直接采用此系数。**")
    lines.append("")
    lines.append("| 指标 | 标定前 | 标定后 |")
    lines.append("|---|---|---|")
    lines.append(f"| MAE | {_fmt(b.mae)} | {_fmt(a.mae)} mm |")
    lines.append(f"| 平均误差 | {_fmt(b.mean_error)} | {_fmt(a.mean_error)} mm |")
    lines.append(f"| ±2mm 命中率 | {_fmt(b.within_2mm_pct, 1)} | {_fmt(a.within_2mm_pct, 1)}% |")
    lines.append("")

    lines.append("## 3. 个体虹膜差异(#1 误差源)")
    lines.append("")
    if report.iris is None:
        lines.append("无足够数据。")
    else:
        iv = report.iris
        lines.append(f"- 人数:{iv.n_subjects}")
        lines.append(f"- 反推有效虹膜直径:均值 {_fmt(iv.mean_hvid)}mm,标准差 {_fmt(iv.std_hvid)}mm,"
                     f"范围 {_fmt(iv.min_hvid)}–{_fmt(iv.max_hvid)}mm")
        lines.append(f"- **若按个人虹膜标定,MAE 下限可至 {_fmt(iv.individual_calibrated_mae)}mm**"
                     f"(对比全局标定后 {_fmt(a.mae)}mm,差距越大越值得做个人标定)")
    lines.append("")

    lines.append("## 4. 残差相关性(误差 vs 因素,Pearson r)")
    lines.append("")
    for key, val in report.correlations.items():
        lines.append(f"- {key}: {_fmt(val, 3) if val is not None else '—'}")
    lines.append("")

    lines.append("## 5. 卡片交叉对照")
    lines.append("")
    if report.card is None:
        lines.append("样本中未检出卡片,无对照。")
    else:
        c = report.card
        lines.append(f"- 有卡片样本:{c['n']}")
        lines.append(f"- 虹膜法 MAE:{_fmt(c['iris_mae'])}mm,卡片法 MAE:{_fmt(c['card_mae'])}mm")
        lines.append(f"- 卡片更接近真值的比例:{_fmt(c['card_closer_pct'], 1)}%"
                     f"(高则说明卡片个人标定值得做)")
    lines.append("")

    lines.append("## 6. 无效样本")
    lines.append("")
    if not invalid:
        lines.append("无。")
    else:
        lines.append("| 行号 | 文件 | 原因 |")
        lines.append("|---|---|---|")
        for iv in invalid:
            lines.append(f"| {iv.line_no} | {iv.filename} | {iv.reason} |")
    lines.append("")
    return "\n".join(lines)


def write_csv(results: List[SampleResult], path: str) -> None:
    cols = [
        "filename", "subject_id", "true_total", "raw_total", "left_pd", "right_pd",
        "pupil_px", "diam_avg_px", "iris_diam_asym", "quality_score",
        "overall_valid", "card_total", "img_w", "img_h",
    ]
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(cols)
        for r in results:
            writer.writerow([getattr(r, c) for c in cols])


def render_console(report: Report) -> str:
    b, a = report.metrics_before, report.metrics_after
    return (
        f"有效样本 {report.n_valid} | 标定前 MAE {b.mae:.2f}mm "
        f"→ 建议 PD_CALIBRATION={report.k_mae} 后 MAE {a.mae:.2f}mm | "
        f"±2mm 命中率 {a.within_2mm_pct:.0f}%"
    )
