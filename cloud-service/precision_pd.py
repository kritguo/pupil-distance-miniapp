import os


PRECISION_CARD_DIFF_LIMIT_MM = float(os.environ.get("PRECISION_CARD_DIFF_LIMIT_MM", "3.0"))
PRECISION_CARD_WEIGHT = float(os.environ.get("PRECISION_CARD_WEIGHT", "0.7"))


def round_half(value: float) -> float:
    return round(value * 2) / 2


def _split_by_iris_ratio(total_pd: float, iris_pd: dict) -> dict:
    iris_total = float(iris_pd.get("total") or 0)
    if iris_total <= 0:
        left_ratio = 0.5
    else:
        left_ratio = float(iris_pd.get("left") or iris_total / 2) / iris_total
        left_ratio = min(max(left_ratio, 0.35), 0.65)

    total = round_half(total_pd)
    left = round_half(total_pd * left_ratio)
    right = round_half(total - left)
    return {"total": total, "left": left, "right": right}


def calculate_precision_pd(
    iris_pd: dict,
    card_total_pd,
    *,
    diff_limit_mm: float = PRECISION_CARD_DIFF_LIMIT_MM,
    card_weight: float = PRECISION_CARD_WEIGHT,
) -> dict:
    if not iris_pd or not iris_pd.get("total"):
        return {"ok": False, "reason": "iris_missing", "diff_mm": None}
    if card_total_pd is None:
        return {"ok": False, "reason": "card_missing", "diff_mm": None}

    iris_total = float(iris_pd["total"])
    card_total = float(card_total_pd)
    diff_mm = round(abs(card_total - iris_total), 1)
    if diff_mm > diff_limit_mm:
        return {"ok": False, "reason": "card_iris_mismatch", "diff_mm": diff_mm}

    card_weight = min(max(float(card_weight), 0.0), 1.0)
    iris_weight = 1.0 - card_weight
    total_pd = card_total * card_weight + iris_total * iris_weight

    return {
        "ok": True,
        "method": "precision_card_iris",
        "pd": _split_by_iris_ratio(total_pd, iris_pd),
        "diff_mm": diff_mm,
        "card_weight": card_weight,
        "iris_weight": iris_weight,
    }
