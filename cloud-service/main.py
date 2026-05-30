"""
瞳距测量云端服务 v3.0 —— 虹膜直径比例尺

核心变化（相对 v2.x）：
- 比例尺从「银行卡宽度」改为「虹膜水平直径(HVID≈11.7mm)」。
  虹膜与瞳孔在同一平面，彻底消除「卡片与眼睛不共面」带来的深度偏差，
  用户无需把卡片摆在眼睛平面，真正做到「随意拍」。
- 卡片降级为可选交叉校验：检测到卡片时给出卡片比例尺的 PD 作对照，差异过大则降低可信度；
  检测不到卡片完全不影响主流程。
- 姿态校验：左右虹膜直径不对称判偏头(yaw)、瞳线倾角判侧倾(roll)、鼻梁偏移判正脸。
- 远/近瞳距：用内聚几何把测得的「自拍距离瞳距」换算成远用 / 近用 PD，均为参考值。

返回结构对前端保持兼容：仍含 pd{total,left,right} 与 iris{left,right,confidence}，
新增 pd_far / pd_near / iris_diameter_px / method 等字段。
"""
import os
import math
import base64
import logging
import urllib.request
from typing import Optional, List, Tuple
import cv2
import numpy as np
import mediapipe as mp
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="瞳距测量服务", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

mp_face_mesh = mp.solutions.face_mesh

# ==================== 可调常量 ====================

# 水平可见虹膜直径(Horizontal Visible Iris Diameter)。成人群体均值≈11.7mm，标准差≈0.5mm。
HVID_MM = 11.7
# 系统性修正系数：用真实瞳距标定，纠正方法的整体偏高/偏低。
# 可在云托管「服务设置→环境变量」改 PD_CALIBRATION 微调，无需重新部署。
CALIBRATION_FACTOR = float(os.environ.get("PD_CALIBRATION", "1.0"))
# 瞳孔平面到眼球旋转中心的距离(mm)，用于远/近瞳距内聚换算（经验值≈13.5mm）。
EYE_ROTATION_OFFSET_MM = 13.5
# 自拍拍摄距离的默认假设(mm)，用于把「自拍距离瞳距」换算到远用瞳距（伸直手臂≈500mm）。
DEFAULT_SELFIE_DISTANCE_MM = 500.0
# 近用瞳距的参考工作距离(mm)，配老花/阅读镜常用 40cm。
NEAR_WORKING_DISTANCE_MM = 400.0

# MediaPipe 虹膜关键点索引（refine_landmarks=True 时可用）
LEFT_IRIS_CENTER = 468
LEFT_IRIS_RING = [469, 470, 471, 472]
RIGHT_IRIS_CENTER = 473
RIGHT_IRIS_RING = [474, 475, 476, 477]
NOSE_BRIDGE = 168
LEFT_EYE_TOP, LEFT_EYE_BOTTOM = 159, 145
RIGHT_EYE_TOP, RIGHT_EYE_BOTTOM = 386, 374

# ==================== 数据模型 ====================

class MeasureRequest(BaseModel):
    # 二选一：直接传 base64(本地/VPS) 或传图片URL(云托管走云存储中转，绕开 callContainer 100KB 限制)
    image_base64: Optional[str] = None
    image_url: Optional[str] = None
    card_width_mm: float = 85.6
    camera_position: str = Field(default="unknown")
    # 可选：客户端若能提供拍摄距离(mm)，远用换算会更准；否则用默认假设
    selfie_distance_mm: Optional[float] = None

class PdResult(BaseModel):
    total: float
    left: float
    right: float

class IrisResult(BaseModel):
    left: dict
    right: dict
    confidence: float
    diameter_px: float = 0.0
    diameter_left_px: float = 0.0
    diameter_right_px: float = 0.0

class CardCrossCheck(BaseModel):
    found: bool = False
    total_pd: Optional[float] = None
    diff_mm: Optional[float] = None
    width_px: float = 0.0

class QualityResult(BaseModel):
    score: float
    issues: List[str]
    suggestion: Optional[str] = None

class ValidationResult(BaseModel):
    face_frontal: bool = False
    eyes_level: bool = False
    head_straight: bool = False        # 无明显偏头(yaw)
    iris_detected: bool = False
    pd_in_range: bool = False
    pd_symmetry: bool = False
    overall_valid: bool = False
    details: dict = Field(default_factory=dict)

class MetaResult(BaseModel):
    width: int
    height: int

class MeasureResponse(BaseModel):
    ok: bool
    method: str = "iris"               # iris | none
    pd: Optional[PdResult] = None      # 主推荐（自拍距离测得，偏近用）
    pd_far: Optional[PdResult] = None  # 远用瞳距（参考）
    pd_near: Optional[PdResult] = None # 近用瞳距 40cm（参考）
    iris: Optional[IrisResult] = None
    card_cross_check: Optional[CardCrossCheck] = None
    meta: Optional[MetaResult] = None
    quality: Optional[QualityResult] = None
    validation: Optional[ValidationResult] = None
    message: Optional[str] = None

# ==================== 工具函数 ====================

def decode_image(base64_str: str) -> Optional[np.ndarray]:
    try:
        if "," in base64_str:
            base64_str = base64_str.split(",")[1]
        img_data = base64.b64decode(base64_str)
        nparr = np.frombuffer(img_data, np.uint8)
        return cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    except Exception as e:
        logger.error(f"图片解码失败: {e}")
        return None

def load_image_from_url(url: str) -> Optional[np.ndarray]:
    """从 URL(云存储临时链接)下载图片并解码。"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "iris-service"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            img_data = resp.read()
        nparr = np.frombuffer(img_data, np.uint8)
        return cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    except Exception as e:
        logger.error(f"图片下载失败: {e}")
        return None

def load_request_image(req: "MeasureRequest") -> Optional[np.ndarray]:
    """优先用 base64，否则用 URL 下载。"""
    if req.image_base64:
        return decode_image(req.image_base64)
    if req.image_url:
        return load_image_from_url(req.image_url)
    return None

def distance(p1: dict, p2: dict) -> float:
    return math.hypot(p1["x"] - p2["x"], p1["y"] - p2["y"])

def round_half(v: float) -> float:
    return round(v * 2) / 2

def sort_corners(pts: np.ndarray) -> np.ndarray:
    sorted_by_y = pts[np.argsort(pts[:, 1])]
    top = sorted_by_y[:2]
    bottom = sorted_by_y[2:]
    top = top[np.argsort(top[:, 0])]
    bottom = bottom[np.argsort(bottom[:, 0])]
    return np.array([top[0], top[1], bottom[1], bottom[0]])

# ==================== 虹膜检测 (MediaPipe) ====================

def _px(landmark, w: int, h: int) -> dict:
    return {"x": landmark.x * w, "y": landmark.y * h}

def _iris_diameter_px(landmarks, center_id: int, ring_ids: List[int], w: int, h: int) -> float:
    """虹膜直径 = 2 × 中心到环上各点像素距离的中位数。"""
    c = _px(landmarks[center_id], w, h)
    dists = [distance(c, _px(landmarks[i], w, h)) for i in ring_ids]
    if not dists:
        return 0.0
    return 2.0 * float(np.median(dists))

def detect_iris(image: np.ndarray) -> Optional[dict]:
    """
    返回 dict:
      left/right: 虹膜中心像素坐标 {x,y}
      nose_x: 鼻梁像素 x
      diam_left_px / diam_right_px / diam_avg_px: 虹膜直径
      eye_open_left/right: 眼睑开合像素
    """
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    h, w = image.shape[:2]
    with mp_face_mesh.FaceMesh(
        static_image_mode=True,
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.5,
    ) as face_mesh:
        results = face_mesh.process(rgb)
        if not results.multi_face_landmarks:
            logger.warning("未检测到人脸")
            return None
        lm = results.multi_face_landmarks[0].landmark
        if len(lm) <= max(RIGHT_IRIS_RING):
            logger.warning("关键点数量不足，未启用 refine_landmarks?")
            return None

        left = _px(lm[LEFT_IRIS_CENTER], w, h)
        right = _px(lm[RIGHT_IRIS_CENTER], w, h)
        nose = _px(lm[NOSE_BRIDGE], w, h)
        diam_left = _iris_diameter_px(lm, LEFT_IRIS_CENTER, LEFT_IRIS_RING, w, h)
        diam_right = _iris_diameter_px(lm, RIGHT_IRIS_CENTER, RIGHT_IRIS_RING, w, h)
        eye_open_left = abs(lm[LEFT_EYE_TOP].y - lm[LEFT_EYE_BOTTOM].y) * h
        eye_open_right = abs(lm[RIGHT_EYE_TOP].y - lm[RIGHT_EYE_BOTTOM].y) * h

        diam_vals = [d for d in (diam_left, diam_right) if d > 1]
        diam_avg = float(np.mean(diam_vals)) if diam_vals else 0.0

        return {
            "left": left,
            "right": right,
            "nose_x": nose["x"],
            "nose": nose,
            "diam_left_px": diam_left,
            "diam_right_px": diam_right,
            "diam_avg_px": diam_avg,
            "eye_open_left": eye_open_left,
            "eye_open_right": eye_open_right,
        }

# ==================== 卡片检测 (OpenCV, 可选交叉校验) ====================

def detect_card_opencv(image: np.ndarray) -> Tuple[Optional[list], float, float]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, w = image.shape[:2]
    image_area = h * w
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    best_card, best_score = None, 0.0

    for low_thresh in (30, 50, 70):
        edges = cv2.Canny(blurred, low_thresh, low_thresh * 3)
        edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < image_area * 0.015 or area > image_area * 0.5:
                continue
            approx = cv2.approxPolyDP(contour, 0.02 * cv2.arcLength(contour, True), True)
            if len(approx) != 4 or not cv2.isContourConvex(approx):
                continue
            box_w, box_h = cv2.minAreaRect(contour)[1]
            if min(box_w, box_h) < 10:
                continue
            aspect = max(box_w, box_h) / min(box_w, box_h)
            if aspect < 1.0 or aspect > 2.2:
                continue
            ratio_score = max(0.0, 1 - abs(aspect - 1.586) / 1.586)
            area_ratio = area / image_area
            if area_ratio < 0.05:
                area_score = area_ratio / 0.05
            elif area_ratio > 0.3:
                area_score = max(0.0, 1 - (area_ratio - 0.3) / 0.2)
            else:
                area_score = 1.0
            score = ratio_score * 0.6 + area_score * 0.4
            if score > best_score:
                best_score = score
                best_card = sort_corners(approx.reshape(4, 2))

    if best_card is None:
        return None, 0.0, 0.0
    corners = [{"x": float(p[0]), "y": float(p[1])} for p in best_card]
    top_w = distance(corners[0], corners[1])
    bottom_w = distance(corners[3], corners[2])
    card_width_px = (top_w + bottom_w) / 2
    return corners, float(best_score), float(card_width_px)

# ==================== 瞳距计算（虹膜比例尺） ====================

def _project_param(p: dict, a: dict, b: dict) -> float:
    """点 p 在直线 a->b 上的投影参数 t（沿 a->b 方向，单位与像素一致）。"""
    abx, aby = b["x"] - a["x"], b["y"] - a["y"]
    denom = abx * abx + aby * aby
    if denom <= 1e-6:
        return 0.0
    t = ((p["x"] - a["x"]) * abx + (p["y"] - a["y"]) * aby) / denom
    return t

def calculate_pd_iris(iris: dict) -> Optional[dict]:
    """用虹膜直径作比例尺计算瞳距（roll 不敏感：用欧氏距离 + 投影）。"""
    diam_avg = iris.get("diam_avg_px", 0.0)
    if diam_avg < 4:
        logger.error(f"虹膜直径过小不可信: {diam_avg}")
        return None
    scale = HVID_MM * CALIBRATION_FACTOR / diam_avg  # mm/px，取在眼睛平面（含系统性修正）

    left, right = iris["left"], iris["right"]
    pupil_px = distance(left, right)
    total_pd = pupil_px * scale

    # 单眼 PD：把鼻梁投影到双瞳连线上，得到中线脚点，沿瞳线分配（roll 不敏感）
    nose = iris.get("nose") or {"x": iris.get("nose_x", (left["x"] + right["x"]) / 2),
                                "y": (left["y"] + right["y"]) / 2}
    # 以画面左眼为 a、右眼为 b，保证 left_pd 对应画面左侧
    if left["x"] <= right["x"]:
        a, b = left, right
    else:
        a, b = right, left
    t = _project_param(nose, a, b)        # 0=在 a，1=在 b
    t = min(max(t, 0.0), 1.0)
    left_pd = total_pd * t
    right_pd = total_pd * (1 - t)

    return {
        "total": round_half(total_pd),
        "left": round_half(left_pd),
        "right": round_half(right_pd),
        "scale": scale,
        "pupil_px": pupil_px,
    }

def calculate_pd_card(iris: dict, card_corners: list, card_width_mm: float) -> Optional[float]:
    """卡片比例尺的总瞳距，仅用于交叉校验。"""
    top_w = distance(card_corners[0], card_corners[1])
    bottom_w = distance(card_corners[3], card_corners[2])
    card_width_px = (top_w + bottom_w) / 2
    if card_width_px < 20:
        return None
    scale = card_width_mm / card_width_px
    return distance(iris["left"], iris["right"]) * scale

def convert_far_near(measured_pd: dict, selfie_distance_mm: float) -> Tuple[dict, dict]:
    """
    自拍测得的是「自拍距离 D 处的会聚瞳距」。内聚几何：
      nearPD(D) = farPD × D / (D + r)，r=瞳孔到眼球旋转中心距离
    => farPD = measured × (D + r) / D
       nearPD(40cm) = farPD × Wn / (Wn + r)
    """
    r = EYE_ROTATION_OFFSET_MM
    D = max(150.0, float(selfie_distance_mm or DEFAULT_SELFIE_DISTANCE_MM))
    far_factor = (D + r) / D
    near_factor = NEAR_WORKING_DISTANCE_MM / (NEAR_WORKING_DISTANCE_MM + r)

    def scale_pd(pd: dict, k: float) -> dict:
        return {
            "total": round_half(pd["total"] * k),
            "left": round_half(pd["left"] * k),
            "right": round_half(pd["right"] * k),
        }

    far_pd = scale_pd(measured_pd, far_factor)
    near_pd = scale_pd(far_pd, near_factor)
    return far_pd, near_pd

# ==================== 姿态/质量校验 ====================

def validate(iris: dict, pd: dict, card_cross: Optional[dict], image_shape: tuple) -> dict:
    h, w = image_shape[:2]
    left, right = iris["left"], iris["right"]
    details = {}

    # roll：双瞳 y 差
    eye_y_diff = abs(left["y"] - right["y"])
    pupil_px = max(1.0, distance(left, right))
    roll_ratio = eye_y_diff / pupil_px
    eyes_level = roll_ratio < 0.12          # 约 < 7°
    details["roll_ratio"] = round(roll_ratio, 3)

    # 正脸：鼻梁相对双瞳中点的横向偏移
    nose_x = iris.get("nose_x", (left["x"] + right["x"]) / 2)
    eyes_center_x = (left["x"] + right["x"]) / 2
    nose_offset_ratio = abs(nose_x - eyes_center_x) / pupil_px
    face_frontal = nose_offset_ratio < 0.12
    details["nose_offset_ratio"] = round(nose_offset_ratio, 3)

    # 偏头(yaw)：左右虹膜直径不对称（转头时近镜头的虹膜更大）
    dl, dr = iris.get("diam_left_px", 0), iris.get("diam_right_px", 0)
    if dl > 1 and dr > 1:
        diam_asym = abs(dl - dr) / max(dl, dr)
    else:
        diam_asym = 1.0
    head_straight = diam_asym < 0.18
    details["iris_diam_asym"] = round(diam_asym, 3)

    iris_detected = iris.get("diam_avg_px", 0) >= 4
    pd_in_range = 50 <= pd["total"] <= 80
    pd_symmetry = abs(pd["left"] - pd["right"]) < 6
    details["pd_total"] = pd["total"]
    details["pd_diff"] = round(abs(pd["left"] - pd["right"]), 1)

    # 卡片交叉校验差异
    if card_cross and card_cross.get("found") and card_cross.get("total_pd"):
        details["card_diff_mm"] = card_cross.get("diff_mm")

    overall_valid = (eyes_level and face_frontal and head_straight
                     and iris_detected and pd_in_range and pd_symmetry)
    return {
        "face_frontal": face_frontal,
        "eyes_level": eyes_level,
        "head_straight": head_straight,
        "iris_detected": iris_detected,
        "pd_in_range": pd_in_range,
        "pd_symmetry": pd_symmetry,
        "overall_valid": overall_valid,
        "details": details,
    }

def assess_quality(iris: dict, validation: dict, card_cross: Optional[dict]) -> dict:
    issues, suggestion = [], None
    score = 1.0

    # 眼睛开合
    eo = min(iris.get("eye_open_left", 0), iris.get("eye_open_right", 0))
    if eo < 3:
        score *= 0.5
        issues.append("eyes_closed")
        suggestion = "请睁大眼睛、正视镜头"
    elif eo < 6:
        score *= 0.85

    checks = [
        ("eyes_level", "eyes_not_level", "请保持头部水平，双眼在同一水平线"),
        ("face_frontal", "face_not_frontal", "请正对镜头，不要偏头"),
        ("head_straight", "head_turned", "请正脸面向镜头，别侧头"),
        ("pd_in_range", "pd_out_of_range", "结果异常，请在光线充足处重拍"),
        ("pd_symmetry", "pd_asymmetric", "请正对镜头，鼻梁对准中线"),
    ]
    for key, issue, tip in checks:
        if not validation.get(key, True):
            issues.append(issue)
            score *= 0.78
            if not suggestion:
                suggestion = tip

    # 卡片交叉校验：与虹膜结果差异大 → 提示但不否决
    if card_cross and card_cross.get("found") and card_cross.get("diff_mm") is not None:
        if card_cross["diff_mm"] > 4:
            issues.append("card_iris_mismatch")
            score *= 0.9

    return {
        "score": round(max(0.0, min(1.0, score)), 2),
        "issues": issues,
        "suggestion": suggestion,
    }

# ==================== API ====================

@app.get("/")
async def root():
    return {"service": "瞳距测量服务", "version": "3.0.0", "method": "iris-diameter", "status": "running"}

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.post("/v1/measure", response_model=MeasureResponse)
async def measure(req: MeasureRequest):
    try:
        image = load_request_image(req)
        if image is None:
            return MeasureResponse(ok=False, method="none", message="图片解码失败或下载失败")
        h, w = image.shape[:2]

        iris = detect_iris(image)
        if iris is None:
            return MeasureResponse(ok=False, method="none",
                                   message="未检测到人脸，请正对镜头重拍",
                                   meta=MetaResult(width=w, height=h))

        pd = calculate_pd_iris(iris)
        if pd is None:
            return MeasureResponse(ok=False, method="none",
                                   message="虹膜识别不清晰，请在光线充足处正对镜头重拍",
                                   meta=MetaResult(width=w, height=h))

        # 卡片可选交叉校验（找不到不影响）
        card_cross = {"found": False, "total_pd": None, "diff_mm": None, "width_px": 0.0}
        corners, card_conf, card_width_px = detect_card_opencv(image)
        if corners is not None:
            card_total = calculate_pd_card(iris, corners, req.card_width_mm)
            if card_total is not None:
                card_cross = {
                    "found": True,
                    "total_pd": round_half(card_total),
                    "diff_mm": round(abs(card_total - pd["total"]), 1),
                    "width_px": card_width_px,
                }

        validation = validate(iris, pd, card_cross, image.shape)
        quality = assess_quality(iris, validation, card_cross)
        far_pd, near_pd = convert_far_near(pd, req.selfie_distance_mm)

        return MeasureResponse(
            ok=True,
            method="iris",
            pd=PdResult(total=pd["total"], left=pd["left"], right=pd["right"]),
            pd_far=PdResult(**far_pd),
            pd_near=PdResult(**near_pd),
            iris=IrisResult(
                left=iris["left"],
                right=iris["right"],
                confidence=quality["score"],
                diameter_px=round(iris.get("diam_avg_px", 0.0), 1),
                diameter_left_px=round(iris.get("diam_left_px", 0.0), 1),
                diameter_right_px=round(iris.get("diam_right_px", 0.0), 1),
            ),
            card_cross_check=CardCrossCheck(**card_cross),
            meta=MetaResult(width=w, height=h),
            quality=QualityResult(**quality),
            validation=ValidationResult(**validation),
        )
    except Exception as e:
        logger.exception("测量异常")
        return MeasureResponse(ok=False, method="none", message=f"服务异常: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
