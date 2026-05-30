from dataclasses import dataclass
from typing import List, Optional
import numpy as np


@dataclass
class SampleResult:
    filename: str
    subject_id: str
    true_total: float
    true_left: Optional[float]
    true_right: Optional[float]
    raw_total: float
    left_pd: float
    right_pd: float
    pupil_px: float
    diam_avg_px: float
    diam_left_px: float
    diam_right_px: float
    eye_open_min: float
    roll_ratio: float
    nose_offset_ratio: float
    iris_diam_asym: float
    quality_score: float
    overall_valid: bool
    card_total: Optional[float]
    img_w: int
    img_h: int


@dataclass
class Metrics:
    n: int
    calibration: float
    mean_error: float
    std_error: float
    mae: float
    p50_abs: float
    p90_abs: float
    max_abs: float
    within_1mm_pct: float
    within_2mm_pct: float


def compute_metrics(results: List[SampleResult], k: float) -> Metrics:
    errs = np.array([k * r.raw_total - r.true_total for r in results], dtype=float)
    abs_errs = np.abs(errs)
    n = len(results)
    return Metrics(
        n=n,
        calibration=round(k, 4),
        mean_error=float(np.mean(errs)),
        std_error=float(np.std(errs, ddof=1)) if n > 1 else 0.0,
        mae=float(np.mean(abs_errs)),
        p50_abs=float(np.percentile(abs_errs, 50)),
        p90_abs=float(np.percentile(abs_errs, 90)),
        max_abs=float(np.max(abs_errs)),
        within_1mm_pct=float(np.mean(abs_errs <= 1.0) * 100),
        within_2mm_pct=float(np.mean(abs_errs <= 2.0) * 100),
    )


def unbiased_calibration(results: List[SampleResult]) -> float:
    """令平均误差归零的系数:sum(true)/sum(measured)。"""
    sum_m = sum(r.raw_total for r in results)
    sum_t = sum(r.true_total for r in results)
    if sum_m <= 0:
        return 1.0
    return sum_t / sum_m


def optimal_calibration_mae(results: List[SampleResult],
                            lo: float = 0.80, hi: float = 1.20, step: float = 0.001) -> float:
    """主目标:网格搜索最小化总 PD 的 MAE。"""
    best_k, best_mae = 1.0, float("inf")
    k = lo
    while k <= hi + 1e-9:
        mae = compute_metrics(results, k).mae
        if mae < best_mae:
            best_mae, best_k = mae, k
        k += step
    return round(best_k, 4)
