import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from precision_pd import calculate_precision_pd


def test_precision_pd_blends_card_and_iris_with_iris_split():
    iris_pd = {"total": 63.0, "left": 31.0, "right": 32.0}

    result = calculate_precision_pd(iris_pd, 65.0)

    assert result["ok"] is True
    assert result["method"] == "precision_card_iris"
    assert result["pd"] == {"total": 64.5, "left": 31.5, "right": 33.0}
    assert result["diff_mm"] == 2.0


def test_precision_pd_rejects_missing_card():
    result = calculate_precision_pd({"total": 63.0, "left": 31.0, "right": 32.0}, None)

    assert result["ok"] is False
    assert result["reason"] == "card_missing"


def test_precision_pd_rejects_card_iris_mismatch():
    result = calculate_precision_pd({"total": 63.0, "left": 31.0, "right": 32.0}, 68.0)

    assert result["ok"] is False
    assert result["reason"] == "card_iris_mismatch"
    assert result["diff_mm"] == 5.0
