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


@dataclass
class IrisVariance:
    n_subjects: int
    mean_hvid: float
    std_hvid: float
    min_hvid: float
    max_hvid: float
    individual_calibrated_mae: float  # 若按个人虹膜标定可达到的误差下限


@dataclass
class Report:
    metrics_before: Metrics
    metrics_after: Metrics
    k_mae: float
    k_unbiased: float
    iris: Optional[IrisVariance]
    correlations: dict
    card: Optional[dict]
    n_valid: int


def iris_variance(results: List[SampleResult]) -> Optional[IrisVariance]:
    by_subject = {}
    for r in results:
        if r.pupil_px <= 0 or r.diam_avg_px <= 0:
            continue
        # true = (HVID_eff / diam) * pupil  =>  HVID_eff = true * diam / pupil
        h = r.true_total * (r.diam_avg_px / r.pupil_px)
        by_subject.setdefault(r.subject_id, []).append((r, h))
    if not by_subject:
        return None

    subj_hvids = [float(np.mean([h for _, h in items])) for items in by_subject.values()]
    cal_abs = []
    for items in by_subject.values():
        hbar = float(np.mean([h for _, h in items]))
        for r, _ in items:
            measured = hbar * (r.pupil_px / r.diam_avg_px)  # 用个人平均虹膜直径反推
            cal_abs.append(abs(measured - r.true_total))

    return IrisVariance(
        n_subjects=len(by_subject),
        mean_hvid=float(np.mean(subj_hvids)),
        std_hvid=float(np.std(subj_hvids, ddof=1)) if len(subj_hvids) > 1 else 0.0,
        min_hvid=float(np.min(subj_hvids)),
        max_hvid=float(np.max(subj_hvids)),
        individual_calibrated_mae=float(np.mean(cal_abs)) if cal_abs else 0.0,
    )


def _pearson(x, y) -> Optional[float]:
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    if len(x) < 2 or np.std(x) == 0 or np.std(y) == 0:
        return None
    return float(np.corrcoef(x, y)[0, 1])


def correlations(results: List[SampleResult], k: float) -> dict:
    abs_err = [abs(k * r.raw_total - r.true_total) for r in results]
    return {
        "iris_diam_asym": _pearson([r.iris_diam_asym for r in results], abs_err),
        "quality_score": _pearson([r.quality_score for r in results], abs_err),
        "eye_open_min": _pearson([r.eye_open_min for r in results], abs_err),
        "resolution_min_dim": _pearson([min(r.img_w, r.img_h) for r in results], abs_err),
    }


def card_comparison(results: List[SampleResult], k: float) -> Optional[dict]:
    rows = [r for r in results if r.card_total is not None]
    if not rows:
        return None
    iris_mae = float(np.mean([abs(k * r.raw_total - r.true_total) for r in rows]))
    card_mae = float(np.mean([abs(r.card_total - r.true_total) for r in rows]))
    closer = float(np.mean([
        abs(r.card_total - r.true_total) < abs(k * r.raw_total - r.true_total) for r in rows
    ]) * 100)
    return {"n": len(rows), "iris_mae": iris_mae, "card_mae": card_mae, "card_closer_pct": closer}


def analyze(results: List[SampleResult]) -> Report:
    k_mae = optimal_calibration_mae(results)
    return Report(
        metrics_before=compute_metrics(results, 1.0),
        metrics_after=compute_metrics(results, k_mae),
        k_mae=k_mae,
        k_unbiased=round(unbiased_calibration(results), 4),
        iris=iris_variance(results),
        correlations=correlations(results, k_mae),
        card=card_comparison(results, k_mae),
        n_valid=len(results),
    )
