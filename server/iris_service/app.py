import base64
import io
import logging
import math
from typing import List, Optional, Tuple

import cv2
import numpy as np
from fastapi import FastAPI
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

try:
    import mediapipe as mp
except Exception:  # pragma: no cover
    mp = None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("iris_service")

app = FastAPI()

FACE_MESH = None
if mp is not None:
    FACE_MESH = mp.solutions.face_mesh.FaceMesh(
        static_image_mode=True,
        max_num_faces=1,
        refine_landmarks=True
    )


class MeasureRequest(BaseModel):
    image_base64: str
    card_width_mm: float = 85.6
    camera_position: str = Field(default="unknown", description="front/back/unknown")


def decode_image(image_base64: str) -> Optional[np.ndarray]:
    if "," in image_base64:
        image_base64 = image_base64.split(",", 1)[1]
    data = base64.b64decode(image_base64)
    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image)
        rgb = image.convert("RGB")
        return cv2.cvtColor(np.array(rgb), cv2.COLOR_RGB2BGR)
    except Exception:
        image = np.frombuffer(data, np.uint8)
        return cv2.imdecode(image, cv2.IMREAD_COLOR)


def distance(p1: dict, p2: dict) -> float:
    return math.sqrt((p1["x"] - p2["x"]) ** 2 + (p1["y"] - p2["y"]) ** 2)


def round_half(v: float) -> float:
    return round(v * 2) / 2


def sort_corners(pts: np.ndarray) -> np.ndarray:
    sorted_by_y = pts[np.argsort(pts[:, 1])]
    top = sorted_by_y[:2]
    bottom = sorted_by_y[2:]
    top = top[np.argsort(top[:, 0])]
    bottom = bottom[np.argsort(bottom[:, 0])]
    return np.array([top[0], top[1], bottom[1], bottom[0]])


def refine_pupil_center(image: np.ndarray, center: tuple, radius: float) -> tuple:
    if image is None or center is None:
        return center
    if not np.isfinite(center[0]) or not np.isfinite(center[1]):
        return center
    if radius <= 0:
        return center
    h, w = image.shape[:2]
    cx, cy = center
    r = int(max(6, radius * 2.2))
    x0 = max(0, int(cx - r))
    y0 = max(0, int(cy - r))
    x1 = min(w, int(cx + r))
    y1 = min(h, int(cy + r))
    if x1 - x0 < 6 or y1 - y0 < 6:
        return center
    roi = image[y0:y1, x0:x1]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (7, 7), 0)
    thresh_val = float(np.percentile(gray, 25))
    _, mask = cv2.threshold(gray, thresh_val, 255, cv2.THRESH_BINARY_INV)
    mask = cv2.medianBlur(mask, 5)
    moments = cv2.moments(mask)
    if moments["m00"] == 0:
        return center
    dx = float(moments["m10"] / moments["m00"])
    dy = float(moments["m01"] / moments["m00"])
    return (x0 + dx, y0 + dy)


def iris_centers(
    landmarks,
    width: int,
    height: int,
    image: Optional[np.ndarray] = None
) -> Optional[Tuple[dict, float]]:
    left_ids = [468, 469, 470, 471, 472]
    right_ids = [473, 474, 475, 476, 477]
    if len(landmarks) <= max(right_ids):
        return None
    left_eye_ids = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
    right_eye_ids = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]

    def points(ids: List[int]) -> List[tuple]:
        return [(float(landmarks[i].x * width), float(landmarks[i].y * height)) for i in ids]

    def center_from(points_list: List[tuple]) -> tuple:
        xs = [p[0] for p in points_list]
        ys = [p[1] for p in points_list]
        return (float(sum(xs) / len(xs)), float(sum(ys) / len(ys)))

    def radius_from(points_list: List[tuple], center: tuple) -> float:
        dists = [float(np.hypot(p[0] - center[0], p[1] - center[1])) for p in points_list]
        return float(np.median(dists)) if dists else 0.0

    def eye_box(ids: List[int]) -> Optional[tuple]:
        if len(landmarks) <= max(ids):
            return None
        pts = [(float(landmarks[i].x * width), float(landmarks[i].y * height)) for i in ids]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return (min(xs), min(ys), max(xs), max(ys))

    def point_in_box(point: tuple, box: Optional[tuple], margin_ratio: float = 0.25) -> bool:
        if not box or point is None:
            return False
        min_x, min_y, max_x, max_y = box
        w = max(1.0, max_x - min_x)
        h = max(1.0, max_y - min_y)
        min_x -= w * margin_ratio
        max_x += w * margin_ratio
        min_y -= h * margin_ratio
        max_y += h * margin_ratio
        return min_x <= point[0] <= max_x and min_y <= point[1] <= max_y

    left_pts = points(left_ids)
    right_pts = points(right_ids)
    left_center_raw = center_from(left_pts)
    right_center_raw = center_from(right_pts)
    left_box = eye_box(left_eye_ids)
    right_box = eye_box(right_eye_ids)
    left_eye_center = center_from([(left_box[0], left_box[1]), (left_box[2], left_box[3])]) if left_box else left_center_raw
    right_eye_center = center_from([(right_box[0], right_box[1]), (right_box[2], right_box[3])]) if right_box else right_center_raw
    left_center = left_center_raw
    right_center = right_center_raw
    used_fallback = False

    if image is not None:
        refined_left = refine_pupil_center(image, left_center_raw, radius_from(left_pts, left_center_raw))
        refined_right = refine_pupil_center(image, right_center_raw, radius_from(right_pts, right_center_raw))
        if point_in_box(refined_left, left_box):
            left_center = refined_left
        if point_in_box(refined_right, right_box):
            right_center = refined_right

    if not point_in_box(left_center, left_box):
        left_center = left_eye_center
        used_fallback = True
    if not point_in_box(right_center, right_box):
        right_center = right_eye_center
        used_fallback = True

    if not (np.isfinite(left_center[0]) and np.isfinite(left_center[1]) and np.isfinite(right_center[0]) and np.isfinite(right_center[1])):
        return None

    iris_confidence = 0.9
    if len(landmarks) > 386:
        left_eye_open = abs(landmarks[159].y - landmarks[145].y) * height
        right_eye_open = abs(landmarks[386].y - landmarks[374].y) * height
        if left_eye_open < 3 or right_eye_open < 3:
            iris_confidence = 0.5
        elif left_eye_open < 6 or right_eye_open < 6:
            iris_confidence = 0.7
        else:
            iris_confidence = 0.95
        eye_y_diff = abs(left_center[1] - right_center[1])
        if eye_y_diff > height * 0.05:
            iris_confidence *= 0.7
    if used_fallback:
        iris_confidence *= 0.8
    iris_confidence = float(max(0.0, min(1.0, iris_confidence)))

    # 返回像素坐标（保持原有行为）
    left = {"x": float(left_center[0]), "y": float(left_center[1])}
    right = {"x": float(right_center[0]), "y": float(right_center[1])}

    # 同时返回归一化坐标（0-1之间），方便前端按原图比例映射到显示区域
    left_norm = {"x": float(left_center[0] / width), "y": float(left_center[1] / height)}
    right_norm = {"x": float(right_center[0] / width), "y": float(right_center[1] / height)}

    if left["x"] > right["x"]:
        left, right = right, left
        left_norm, right_norm = right_norm, left_norm

    return {
        "left": left,
        "right": right,
        "left_normalized": left_norm,
        "right_normalized": right_norm,
        "confidence": iris_confidence
    }, iris_confidence


def detect_card_opencv(image: np.ndarray) -> Tuple[Optional[List[dict]], float, float]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, w = image.shape[:2]
    image_area = h * w
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    best_card = None
    best_score = 0.0

    for low_thresh in [30, 50, 70]:
        high_thresh = low_thresh * 3
        edges = cv2.Canny(blurred, low_thresh, high_thresh)
        kernel = np.ones((3, 3), np.uint8)
        edges = cv2.dilate(edges, kernel, iterations=1)
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        for contour in contours:
            area = cv2.contourArea(contour)
            if area < image_area * 0.015 or area > image_area * 0.5:
                continue
            epsilon = 0.02 * cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, epsilon, True)
            if len(approx) != 4:
                continue
            if not cv2.isContourConvex(approx):
                continue
            rect = cv2.minAreaRect(contour)
            box_w, box_h = rect[1]
            if min(box_w, box_h) < 10:
                continue
            aspect = max(box_w, box_h) / min(box_w, box_h)
            if aspect < 1.0 or aspect > 2.2:
                continue

            ratio_diff = abs(aspect - 1.586) / 1.586
            ratio_score = max(0, 1 - ratio_diff)
            area_ratio = area / image_area
            if area_ratio < 0.05:
                area_score = area_ratio / 0.05
            elif area_ratio > 0.3:
                area_score = max(0, 1 - (area_ratio - 0.3) / 0.2)
            else:
                area_score = 1.0
            pts = approx.reshape(4, 2)
            center_y = np.mean(pts[:, 1]) / h
            if center_y < 0.5:
                position_score = 1.0
            elif center_y < 0.7:
                position_score = 0.7
            else:
                position_score = 0.4

            score = ratio_score * 0.4 + area_score * 0.35 + position_score * 0.25
            if score > best_score:
                best_score = score
                best_card = sort_corners(pts)

    if best_card is None:
        return None, 0.0, 0.0

    corners = [{"x": float(p[0]), "y": float(p[1])} for p in best_card]
    top_width = distance(corners[0], corners[1])
    bottom_width = distance(corners[3], corners[2])
    card_width_px = (top_width + bottom_width) / 2

    return corners, float(best_score), float(card_width_px)


def extract_face_meta(landmarks, width: int, height: int) -> dict:
    face_left = landmarks[234]
    face_right = landmarks[454]
    nose_tip = landmarks[1]
    return {
        "left_x": face_left.x * width,
        "right_x": face_right.x * width,
        "nose_x": nose_tip.x * width,
        "width_px": (face_right.x - face_left.x) * width,
        "height_px": height
    }


def calculate_pd(iris: dict, card_corners: list, card_width_mm: float, nose_x: Optional[float]) -> Optional[dict]:
    top_width = distance(card_corners[0], card_corners[1])
    bottom_width = distance(card_corners[3], card_corners[2])
    card_width_px = (top_width + bottom_width) / 2
    left_height = distance(card_corners[0], card_corners[3])
    right_height = distance(card_corners[1], card_corners[2])
    card_height_px = (left_height + right_height) / 2
    if card_width_px < 20:
        return None
    if card_width_px <= card_height_px * 1.15:
        return None

    scale = card_width_mm / card_width_px
    pupil_distance_px = distance(iris["left"], iris["right"])
    total_pd = pupil_distance_px * scale

    if nose_x is None:
        nose_x = (iris["left"]["x"] + iris["right"]["x"]) / 2

    left_eye_x = iris["left"]["x"]
    right_eye_x = iris["right"]["x"]
    screen_left_eye_x = min(left_eye_x, right_eye_x)
    screen_right_eye_x = max(left_eye_x, right_eye_x)
    left_pd = abs(nose_x - screen_left_eye_x) * scale
    right_pd = abs(screen_right_eye_x - nose_x) * scale

    return {
        "total": round_half(total_pd),
        "left": round_half(left_pd),
        "right": round_half(right_pd),
        "card_width_px": float(card_width_px),
        "scale": float(scale)
    }


def validate_measurement(
    iris: dict,
    card_corners: list,
    pd: dict,
    image_shape: tuple,
    nose_x: Optional[float]
) -> dict:
    h, _ = image_shape[:2]
    details = {}

    left_eye = iris["left"]
    right_eye = iris["right"]
    eye_y_diff = abs(left_eye["y"] - right_eye["y"])
    eye_y_diff_ratio = eye_y_diff / h
    eyes_level = eye_y_diff_ratio < 0.03
    details["eye_y_diff_px"] = round(eye_y_diff, 1)
    details["eye_y_diff_ratio"] = round(eye_y_diff_ratio * 100, 2)

    pd_px = distance(left_eye, right_eye)
    eyes_center_x = (left_eye["x"] + right_eye["x"]) / 2
    nose = nose_x if nose_x is not None else eyes_center_x
    nose_offset = abs(nose - eyes_center_x)
    nose_offset_ratio = (nose_offset / pd_px * 100) if pd_px > 0 else 100.0
    face_frontal = nose_offset_ratio < 10
    details["nose_offset_ratio"] = round(nose_offset_ratio, 2)

    top_width = distance(card_corners[0], card_corners[1])
    bottom_width = distance(card_corners[3], card_corners[2])
    left_height = distance(card_corners[0], card_corners[3])
    right_height = distance(card_corners[1], card_corners[2])
    width_ratio = min(top_width, bottom_width) / max(top_width, bottom_width) if max(top_width, bottom_width) else 0.0
    height_ratio = min(left_height, right_height) / max(left_height, right_height) if max(left_height, right_height) else 0.0
    avg_width = (top_width + bottom_width) / 2
    avg_height = (left_height + right_height) / 2
    card_horizontal = avg_width > avg_height * 1.15
    card_parallel = (width_ratio > 0.85) and (height_ratio > 0.85)
    details["card_width_ratio"] = round(width_ratio * 100, 1)
    details["card_height_ratio"] = round(height_ratio * 100, 1)
    details["card_aspect"] = round(avg_width / avg_height, 2) if avg_height else 0.0

    card_center_y = sum(point["y"] for point in card_corners[:4]) / 4
    eyes_center_y = (left_eye["y"] + right_eye["y"]) / 2
    card_eye_gap_ratio = abs(card_center_y - eyes_center_y) / h
    card_near_eyes = card_eye_gap_ratio < 0.22
    details["card_eye_gap_ratio"] = round(card_eye_gap_ratio * 100, 1)

    pd_total = float(pd.get("total", 0)) if pd else 0.0
    pd_in_range = 50 <= pd_total <= 80
    details["pd_total"] = round(pd_total, 1)

    pd_diff = abs(float(pd.get("left", 0)) - float(pd.get("right", 0))) if pd else 0.0
    pd_symmetry = pd_diff < 5
    details["pd_diff"] = round(pd_diff, 1)

    overall_valid = (
        eyes_level
        and face_frontal
        and card_parallel
        and card_horizontal
        and card_near_eyes
        and pd_in_range
        and pd_symmetry
    )

    return {
        "face_frontal": face_frontal,
        "eyes_level": eyes_level,
        "card_parallel": card_parallel,
        "card_horizontal": card_horizontal,
        "card_near_eyes": card_near_eyes,
        "pd_in_range": pd_in_range,
        "pd_symmetry": pd_symmetry,
        "overall_valid": overall_valid,
        "details": details
    }


def assess_quality(iris_conf: float, card_conf: float, validation: dict) -> dict:
    issues = []
    suggestion = None

    validations = [
        validation.get("eyes_level"),
        validation.get("face_frontal"),
        validation.get("card_parallel"),
        validation.get("card_horizontal"),
        validation.get("card_near_eyes"),
        validation.get("pd_in_range"),
        validation.get("pd_symmetry")
    ]
    pass_count = sum(1 for item in validations if item)
    validation_rate = pass_count / len(validations) if validations else 0.0

    score = iris_conf * 0.4 + card_conf * 0.4 + validation_rate * 0.2
    score = round(max(0.0, min(1.0, score)), 2)

    if not validation.get("eyes_level"):
        issues.append("eyes_level")
        suggestion = suggestion or "请保持头部水平，双眼在同一水平线"
    if not validation.get("face_frontal"):
        issues.append("face_frontal")
        suggestion = suggestion or "请正对镜头，不要偏头"
    if not validation.get("card_parallel"):
        issues.append("card_parallel")
        suggestion = suggestion or "请确保卡片与镜头平行"
    if not validation.get("card_horizontal"):
        issues.append("card_horizontal")
        suggestion = suggestion or "请横放银行卡/身份证，不要竖放"
    if not validation.get("card_near_eyes"):
        issues.append("card_near_eyes")
        suggestion = suggestion or "请将卡片横放在眉毛上方，并尽量贴近眼睛所在平面"
    if not validation.get("pd_in_range"):
        issues.append("pd_in_range")
        suggestion = suggestion or "测量结果异常，请重新拍摄"
    if not validation.get("pd_symmetry"):
        issues.append("pd_symmetry")
        suggestion = suggestion or "请调整鼻梁中线，保持正脸"

    return {
        "score": score,
        "issues": issues,
        "suggestion": suggestion,
        "iris_confidence": round(iris_conf, 2),
        "card_confidence": round(card_conf, 2),
        "validation_rate": round(validation_rate, 2)
    }


@app.post("/v1/measure")
def measure(req: MeasureRequest):
    if FACE_MESH is None:
        return {"ok": False, "error": "mediapipe_unavailable"}

    image = decode_image(req.image_base64)
    if image is None:
        return {"ok": False, "error": "image_decode_failed"}

    height, width = image.shape[:2]
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    result = FACE_MESH.process(rgb)
    if not result.multi_face_landmarks:
        return {"ok": False, "error": "face_not_found"}

    landmarks = result.multi_face_landmarks[0].landmark
    iris_result = iris_centers(landmarks, width, height, image)
    if iris_result is None:
        return {
            "ok": False,
            "error": "iris_not_found",
            "meta": {"width": width, "height": height, "camera_position": req.camera_position}
        }

    iris, iris_conf = iris_result
    face_meta = extract_face_meta(landmarks, width, height)
    card_corners, card_conf, _ = detect_card_opencv(image)
    if card_corners is None:
        return {
            "ok": False,
            "error": "card_not_found",
            "meta": {"width": width, "height": height, "camera_position": req.camera_position},
            "iris": iris,
            "face": face_meta
        }

    pd = calculate_pd(iris, card_corners, req.card_width_mm, face_meta.get("nose_x"))
    if not pd:
        return {
            "ok": False,
            "error": "pd_calc_failed",
            "meta": {"width": width, "height": height, "camera_position": req.camera_position},
            "iris": iris,
            "face": face_meta,
            "card": {"corners": card_corners, "confidence": card_conf}
        }

    validation = validate_measurement(
        iris=iris,
        card_corners=card_corners,
        pd=pd,
        image_shape=image.shape,
        nose_x=face_meta.get("nose_x")
    )
    quality = assess_quality(iris_conf, card_conf, validation)

    face_width_mm = None
    if pd.get("scale") and face_meta.get("width_px"):
        face_width_mm = face_meta["width_px"] * pd["scale"]

    return {
        "ok": True,
        "meta": {"width": width, "height": height, "camera_position": req.camera_position},
        "iris": iris,
        "face": {
            "left_x": face_meta.get("left_x"),
            "right_x": face_meta.get("right_x"),
            "nose_x": face_meta.get("nose_x"),
            "width": round_half(face_width_mm) if face_width_mm else None
        },
        "card": {
            "corners": card_corners,
            "confidence": card_conf
        },
        "pd": {
            "total": pd["total"],
            "left": pd["left"],
            "right": pd["right"]
        },
        "validation": validation,
        "quality": quality
    }
