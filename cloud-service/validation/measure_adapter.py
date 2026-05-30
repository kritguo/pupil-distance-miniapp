import os
from dataclasses import dataclass
from typing import Optional


@dataclass
class MeasureOutput:
    ok: bool
    reason: str = ""
    raw_total: float = 0.0          # 总 PD,calibration=1.0 基线,未取整
    left_pd: float = 0.0            # 取自 main(0.5mm 量化,够用)
    right_pd: float = 0.0
    pupil_px: float = 0.0
    diam_avg_px: float = 0.0
    diam_left_px: float = 0.0
    diam_right_px: float = 0.0
    eye_open_min: float = 0.0
    roll_ratio: float = 0.0
    nose_offset_ratio: float = 0.0
    iris_diam_asym: float = 0.0
    quality_score: float = 0.0
    overall_valid: bool = False
    card_total: Optional[float] = None
    img_w: int = 0
    img_h: int = 0


def build_output(iris, pd, card_total, validation, quality, img_shape) -> MeasureOutput:
    """从 main.py 各函数的返回 dict 组装 MeasureOutput(纯函数,可单测)。"""
    h, w = img_shape[0], img_shape[1]
    details = validation.get("details", {})
    return MeasureOutput(
        ok=True,
        raw_total=pd["pupil_px"] * pd["scale"],  # scale 已含 calibration=1.0
        left_pd=pd["left"],
        right_pd=pd["right"],
        pupil_px=pd["pupil_px"],
        diam_avg_px=iris.get("diam_avg_px", 0.0),
        diam_left_px=iris.get("diam_left_px", 0.0),
        diam_right_px=iris.get("diam_right_px", 0.0),
        eye_open_min=min(iris.get("eye_open_left", 0.0), iris.get("eye_open_right", 0.0)),
        roll_ratio=details.get("roll_ratio", 0.0),
        nose_offset_ratio=details.get("nose_offset_ratio", 0.0),
        iris_diam_asym=details.get("iris_diam_asym", 0.0),
        quality_score=quality.get("score", 0.0),
        overall_valid=validation.get("overall_valid", False),
        card_total=card_total,
        img_w=w,
        img_h=h,
    )


def measure_image(path: str) -> MeasureOutput:
    """读图 → 调 main.py 算法 → MeasureOutput。基线 calibration 固定 1.0。"""
    os.environ["PD_CALIBRATION"] = "1.0"  # 必须在 import main 之前
    import cv2
    import main  # cloud-service/main.py,运行目录在 cloud-service 时可直接 import

    image = cv2.imread(path)
    if image is None:
        return MeasureOutput(ok=False, reason="image_read_failed")
    h, w = image.shape[0], image.shape[1]

    iris = main.detect_iris(image)
    if iris is None:
        return MeasureOutput(ok=False, reason="no_face", img_w=w, img_h=h)

    pd = main.calculate_pd_iris(iris)
    if pd is None:
        return MeasureOutput(ok=False, reason="iris_unreliable", img_w=w, img_h=h)

    card_total = None
    corners, _score, _width_px = main.detect_card_opencv(image)
    if corners is not None:
        card_total = main.calculate_pd_card(iris, corners, 85.6)

    card_cross = {
        "found": card_total is not None,
        "total_pd": card_total,
        "diff_mm": (abs(card_total - pd["total"]) if card_total is not None else None),
    }
    validation = main.validate(iris, pd, card_cross, image.shape)
    quality = main.assess_quality(iris, validation, card_cross)
    return build_output(iris, pd, card_total, validation, quality, image.shape)
