"""
瞳距测量云端服务 v2.1
使用 MediaPipe 检测虹膜，OpenCV 检测卡片
增加多重验证机制提高精度

主要验证：
1. 人脸方向检测（正脸验证）
2. 双眼水平度检查
3. 卡片与人脸平面一致性检查
4. 瞳距合理性范围验证
5. 多帧一致性建议
"""
import math
import base64
import logging
from typing import Optional, List
import cv2
import numpy as np
import mediapipe as mp
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="瞳距测量服务", version="2.1.0")

# CORS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# MediaPipe Face Mesh 初始化
mp_face_mesh = mp.solutions.face_mesh

# ==================== 数据模型 ====================

class MeasureRequest(BaseModel):
    image_base64: str
    card_width_mm: float = 85.6
    camera_position: str = Field(default="unknown", description="摄像头位置: front/back/unknown")

class PdResult(BaseModel):
    total: float
    left: float
    right: float

class IrisResult(BaseModel):
    left: dict
    right: dict
    confidence: float

class CardResult(BaseModel):
    corners: List[dict]
    confidence: float
    width_px: float

class QualityResult(BaseModel):
    score: float
    issues: List[str]
    suggestion: Optional[str] = None

class ValidationResult(BaseModel):
    """多重验证结果"""
    face_frontal: bool = Field(description="人脸是否正对镜头")
    eyes_level: bool = Field(description="双眼是否水平")
    card_parallel: bool = Field(description="卡片是否与人脸平行")
    card_horizontal: bool = Field(default=False, description="卡片是否横放")
    card_near_eyes: bool = Field(default=False, description="卡片是否靠近眼睛所在平面")
    pd_in_range: bool = Field(description="瞳距是否在合理范围")
    pd_symmetry: bool = Field(default=False, description="左右单眼瞳距是否合理")
    overall_valid: bool = Field(description="整体验证是否通过")
    details: dict = Field(default_factory=dict, description="详细验证数据")

class MetaResult(BaseModel):
    width: int
    height: int

class MeasureResponse(BaseModel):
    ok: bool
    pd: Optional[PdResult] = None
    iris: Optional[IrisResult] = None
    card: Optional[CardResult] = None
    meta: Optional[MetaResult] = None
    quality: Optional[QualityResult] = None
    validation: Optional[ValidationResult] = None
    message: Optional[str] = None

# ==================== 工具函数 ====================

def decode_image(base64_str: str) -> Optional[np.ndarray]:
    """Base64 解码为 OpenCV 图像"""
    try:
        # 移除可能的 data URL 前缀
        if "," in base64_str:
            base64_str = base64_str.split(",")[1]
        img_data = base64.b64decode(base64_str)
        nparr = np.frombuffer(img_data, np.uint8)
        return cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    except Exception as e:
        logger.error(f"图片解码失败: {e}")
        return None

def distance(p1: dict, p2: dict) -> float:
    """计算两点欧氏距离"""
    return math.sqrt((p1["x"] - p2["x"])**2 + (p1["y"] - p2["y"])**2)

def round_half(v: float) -> float:
    """四舍五入到0.5mm"""
    return round(v * 2) / 2

def sort_corners(pts: np.ndarray) -> np.ndarray:
    """将四角点排序为：左上、右上、右下、左下"""
    # 按 y 坐标排序
    sorted_by_y = pts[np.argsort(pts[:, 1])]
    top = sorted_by_y[:2]
    bottom = sorted_by_y[2:]

    # 按 x 排序
    top = top[np.argsort(top[:, 0])]
    bottom = bottom[np.argsort(bottom[:, 0])]

    return np.array([top[0], top[1], bottom[1], bottom[0]])

# ==================== 多重验证机制 ====================

def validate_measurement(
    iris: dict,
    card_corners: list,
    pd: dict,
    image_shape: tuple
) -> dict:
    """
    多重验证机制，检查测量结果的可靠性

    验证项目：
    1. 人脸是否正对镜头（通过眼睛Y坐标差和鼻子位置）
    2. 双眼是否水平（Y坐标差异）
    3. 卡片是否与人脸平行（通过卡片透视变形程度）
    4. 瞳距是否在合理范围（50-80mm）
    """
    h, w = image_shape[:2]
    details = {}

    # 1. 双眼水平度检查
    left_eye = iris["left"]
    right_eye = iris["right"]
    eye_y_diff = abs(left_eye["y"] - right_eye["y"])
    eye_y_diff_ratio = eye_y_diff / h
    eyes_level = eye_y_diff_ratio < 0.03  # Y差距小于3%认为水平
    details["eye_y_diff_px"] = round(eye_y_diff, 1)
    details["eye_y_diff_ratio"] = round(eye_y_diff_ratio * 100, 2)

    # 2. 人脸正对检查（通过鼻子位置和双眼中点）
    nose_x = iris.get("nose_x", (left_eye["x"] + right_eye["x"]) / 2)
    eyes_center_x = (left_eye["x"] + right_eye["x"]) / 2
    nose_offset = abs(nose_x - eyes_center_x)
    pupil_distance_px = math.sqrt(
        (left_eye["x"] - right_eye["x"])**2 +
        (left_eye["y"] - right_eye["y"])**2
    )
    # 鼻子偏移应该小于瞳距的10%
    nose_offset_ratio = nose_offset / pupil_distance_px if pupil_distance_px > 0 else 1
    face_frontal = nose_offset_ratio < 0.1
    details["nose_offset_ratio"] = round(nose_offset_ratio * 100, 2)

    # 3. 卡片平行度检查（上下边宽度比）
    if card_corners and len(card_corners) >= 4:
        top_width = distance(card_corners[0], card_corners[1])
        bottom_width = distance(card_corners[3], card_corners[2])
        # 比值应接近1（上下边等宽表示正对）
        width_ratio = min(top_width, bottom_width) / max(top_width, bottom_width) if max(top_width, bottom_width) > 0 else 0
        card_parallel = width_ratio > 0.85  # 85%以上认为平行
        details["card_width_ratio"] = round(width_ratio * 100, 2)

        # 额外检查：左右边高度比
        left_height = distance(card_corners[0], card_corners[3])
        right_height = distance(card_corners[1], card_corners[2])
        height_ratio = min(left_height, right_height) / max(left_height, right_height) if max(left_height, right_height) > 0 else 0
        details["card_height_ratio"] = round(height_ratio * 100, 2)
        if height_ratio < 0.85:
            card_parallel = False
        avg_width = (top_width + bottom_width) / 2
        avg_height = (left_height + right_height) / 2
        card_horizontal = avg_width > avg_height * 1.15
        details["card_aspect"] = round(avg_width / avg_height, 2) if avg_height else 0

        card_center_y = sum(point["y"] for point in card_corners[:4]) / 4
        eyes_center_y = (left_eye["y"] + right_eye["y"]) / 2
        card_eye_gap_ratio = abs(card_center_y - eyes_center_y) / h
        card_near_eyes = card_eye_gap_ratio < 0.22
        details["card_eye_gap_ratio"] = round(card_eye_gap_ratio * 100, 2)
    else:
        card_parallel = False
        card_horizontal = False
        card_near_eyes = False
        details["card_width_ratio"] = 0
        details["card_height_ratio"] = 0
        details["card_aspect"] = 0
        details["card_eye_gap_ratio"] = 100

    # 4. 瞳距范围检查
    pd_in_range = 50 <= pd["total"] <= 80
    details["pd_total"] = pd["total"]

    # 5. 左右瞳距对称性检查
    pd_diff = abs(pd["left"] - pd["right"])
    pd_symmetry = pd_diff < 5  # 左右差小于5mm
    details["pd_diff"] = round(pd_diff, 1)

    # 整体验证：所有关键项目都通过
    overall_valid = eyes_level and face_frontal and card_parallel and card_horizontal and card_near_eyes and pd_in_range and pd_symmetry

    # 生成详细日志
    logger.info(f"验证结果: eyes_level={eyes_level}, face_frontal={face_frontal}, "
               f"card_parallel={card_parallel}, card_horizontal={card_horizontal}, "
               f"card_near_eyes={card_near_eyes}, "
               f"pd_in_range={pd_in_range}, pd_symmetry={pd_symmetry}")
    logger.info(f"验证详情: {details}")

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


# ==================== 虹膜检测 (MediaPipe) ====================

def detect_iris_mediapipe(image: np.ndarray) -> tuple:
    """
    使用 MediaPipe Face Mesh 检测虹膜中心
    返回: (iris_dict, confidence)
    """
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    h, w = image.shape[:2]

    with mp_face_mesh.FaceMesh(
        static_image_mode=True,
        max_num_faces=1,
        refine_landmarks=True,  # 启用虹膜精细关键点
        min_detection_confidence=0.5
    ) as face_mesh:
        results = face_mesh.process(rgb)

        if not results.multi_face_landmarks:
            logger.warning("未检测到人脸")
            return None, 0.0

        landmarks = results.multi_face_landmarks[0].landmark

        # MediaPipe 虹膜关键点索引 (refine_landmarks=True 时可用)
        # 左眼虹膜中心: 468
        # 右眼虹膜中心: 473
        # 鼻梁: 168
        LEFT_IRIS_CENTER = 468
        RIGHT_IRIS_CENTER = 473
        NOSE_BRIDGE = 168

        # 左眼上下眼睑（用于判断眼睛是否睁开）
        LEFT_EYE_TOP = 159
        LEFT_EYE_BOTTOM = 145
        RIGHT_EYE_TOP = 386
        RIGHT_EYE_BOTTOM = 374

        left_iris = landmarks[LEFT_IRIS_CENTER]
        right_iris = landmarks[RIGHT_IRIS_CENTER]
        nose = landmarks[NOSE_BRIDGE]

        # 计算置信度：检查眼睛是否睁开
        left_eye_open = abs(landmarks[LEFT_EYE_TOP].y - landmarks[LEFT_EYE_BOTTOM].y) * h
        right_eye_open = abs(landmarks[RIGHT_EYE_TOP].y - landmarks[RIGHT_EYE_BOTTOM].y) * h

        # 眼睛张开程度太小，可能是闭眼或识别不准
        if left_eye_open < 3 or right_eye_open < 3:
            confidence = 0.5
        elif left_eye_open < 6 or right_eye_open < 6:
            confidence = 0.7
        else:
            confidence = 0.95

        # 检查两眼Y坐标是否接近（应该在同一水平线）
        eye_y_diff = abs(left_iris.y - right_iris.y) * h
        if eye_y_diff > h * 0.05:  # Y差距超过5%，可能是侧脸
            confidence *= 0.7
            logger.warning(f"两眼Y坐标差距较大: {eye_y_diff:.1f}px")

        iris_result = {
            "left": {"x": left_iris.x * w, "y": left_iris.y * h},
            "right": {"x": right_iris.x * w, "y": right_iris.y * h},
            "nose_x": nose.x * w
        }

        logger.info(f"虹膜检测成功: left=({left_iris.x*w:.1f}, {left_iris.y*h:.1f}), "
                   f"right=({right_iris.x*w:.1f}, {right_iris.y*h:.1f}), conf={confidence:.2f}")

        return iris_result, confidence

# ==================== 卡片检测 (OpenCV) ====================

def detect_card_opencv(image: np.ndarray) -> tuple:
    """
    使用 OpenCV Canny + 轮廓检测卡片四角
    返回: (corners_list, confidence, width_px) 或 (None, 0.0, 0.0)
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, w = image.shape[:2]
    image_area = h * w

    # 预处理：高斯模糊 + 自适应直方图均衡
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    # 多阈值 Canny 检测，选择最佳结果
    best_card = None
    best_score = 0

    for low_thresh in [30, 50, 70]:
        high_thresh = low_thresh * 3
        edges = cv2.Canny(blurred, low_thresh, high_thresh)

        # 膨胀边缘
        kernel = np.ones((3, 3), np.uint8)
        edges = cv2.dilate(edges, kernel, iterations=1)

        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        for contour in contours:
            area = cv2.contourArea(contour)

            # 卡片面积筛选：占图片的 1.5% - 50%
            if area < image_area * 0.015 or area > image_area * 0.5:
                continue

            # 多边形逼近
            epsilon = 0.02 * cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, epsilon, True)

            # 必须是四边形
            if len(approx) != 4:
                continue

            # 检查凸性
            if not cv2.isContourConvex(approx):
                continue

            # 检查宽高比
            rect = cv2.minAreaRect(contour)
            box_w, box_h = rect[1]
            if min(box_w, box_h) < 10:
                continue

            aspect = max(box_w, box_h) / min(box_w, box_h)

            # 银行卡比例 1.586，允许 ±35% 误差（考虑透视变形）
            if aspect < 1.0 or aspect > 2.2:
                continue

            # 计算得分
            ratio_diff = abs(aspect - 1.586) / 1.586
            ratio_score = max(0, 1 - ratio_diff)

            # 面积得分：卡片占比适中得分高
            area_ratio = area / image_area
            if area_ratio < 0.05:
                area_score = area_ratio / 0.05
            elif area_ratio > 0.3:
                area_score = max(0, 1 - (area_ratio - 0.3) / 0.2)
            else:
                area_score = 1.0

            # 位置得分：卡片应该在图片上半部分（额头位置）
            pts = approx.reshape(4, 2)
            center_y = np.mean(pts[:, 1]) / h
            if center_y < 0.5:  # 上半部分
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
        logger.warning("未检测到卡片")
        return None, 0.0, 0.0  # 修复：返回3个值保持一致

    corners = [{"x": float(p[0]), "y": float(p[1])} for p in best_card]

    # 计算卡片像素宽度
    top_width = distance(corners[0], corners[1])
    bottom_width = distance(corners[3], corners[2])
    card_width_px = (top_width + bottom_width) / 2

    logger.info(f"卡片检测成功: width={card_width_px:.1f}px, conf={best_score:.2f}")

    return corners, best_score, card_width_px

# ==================== 瞳距计算 ====================

def calculate_pd(iris: dict, card_corners: list, card_width_mm: float) -> Optional[dict]:
    """
    计算瞳距
    公式: PD(mm) = 瞳孔像素距离 × (卡片实际宽度mm / 卡片像素宽度)

    注意：
    - MediaPipe 的 left/right 是被拍摄者的左右眼
    - 在照片中，被拍摄者的左眼在画面右侧，右眼在画面左侧
    - 但计算瞳距时，我们只关心总距离和到鼻梁的距离，不受左右影响
    """
    # 卡片像素宽度（上下边平均）
    top_width = distance(card_corners[0], card_corners[1])
    bottom_width = distance(card_corners[3], card_corners[2])
    card_width_px = (top_width + bottom_width) / 2
    left_height = distance(card_corners[0], card_corners[3])
    right_height = distance(card_corners[1], card_corners[2])
    card_height_px = (left_height + right_height) / 2

    if card_width_px < 20:
        logger.error(f"卡片像素宽度过小: {card_width_px}")
        return None
    if card_width_px <= card_height_px * 1.15:
        logger.error(f"卡片未横放: width={card_width_px:.1f}, height={card_height_px:.1f}")
        return None

    # 比例尺 mm/px
    scale = card_width_mm / card_width_px

    # 瞳距像素距离（总距离不受左右影响）
    pupil_distance_px = distance(iris["left"], iris["right"])

    # 总瞳距
    total_pd = pupil_distance_px * scale

    # 鼻梁中线位置
    nose_x = iris.get("nose_x")
    if nose_x is None:
        nose_x = (iris["left"]["x"] + iris["right"]["x"]) / 2

    # 确定哪只眼在画面左边，哪只在右边
    # 画面左边的眼睛对应"左PD"，画面右边的眼睛对应"右PD"
    left_eye_x = iris["left"]["x"]
    right_eye_x = iris["right"]["x"]

    # 画面中X坐标较小的是"屏幕左侧的眼睛"
    screen_left_eye_x = min(left_eye_x, right_eye_x)
    screen_right_eye_x = max(left_eye_x, right_eye_x)

    # 左PD = 鼻梁到屏幕左侧眼睛的距离
    # 右PD = 鼻梁到屏幕右侧眼睛的距离
    left_pd = abs(nose_x - screen_left_eye_x) * scale
    right_pd = abs(screen_right_eye_x - nose_x) * scale

    result = {
        "total": round_half(total_pd),
        "left": round_half(left_pd),
        "right": round_half(right_pd)
    }

    logger.info(f"瞳距计算: total={result['total']}mm, left={result['left']}mm, right={result['right']}mm")
    logger.info(f"计算参数: card_width_px={card_width_px:.1f}, scale={scale:.4f}, pupil_px={pupil_distance_px:.1f}")
    logger.info(f"眼睛位置: 屏幕左眼x={screen_left_eye_x:.1f}, 鼻梁x={nose_x:.1f}, 屏幕右眼x={screen_right_eye_x:.1f}")

    return result

# ==================== 质量评估 ====================

def assess_quality(iris_conf: float, card_conf: float, pd: dict, validation: dict = None) -> dict:
    """
    评估测量质量，整合多重验证结果

    参数:
    - iris_conf: 虹膜检测置信度
    - card_conf: 卡片检测置信度
    - pd: 瞳距结果
    - validation: 多重验证结果
    """
    issues = []
    suggestion = None

    # 基础分数（检测置信度）
    score = (iris_conf * 0.4 + card_conf * 0.4)

    # 虹膜检测问题
    if iris_conf < 0.6:
        issues.append("iris_low_confidence")
        suggestion = "请睁大眼睛，确保光线充足"
    elif iris_conf < 0.8:
        issues.append("iris_medium_confidence")

    # 卡片检测问题
    if card_conf < 0.5:
        issues.append("card_not_detected")
        suggestion = "请确保卡片完整出现在画面中"
    elif card_conf < 0.7:
        issues.append("card_low_confidence")
        if not suggestion:
            suggestion = "请确保卡片与镜头平行"

    # 整合多重验证结果（占20%权重）
    if validation:
        validation_score = 0
        validation_count = 0

        if not validation.get("eyes_level", True):
            issues.append("eyes_not_level")
            if not suggestion:
                suggestion = "请保持头部水平，双眼在同一水平线"
        else:
            validation_score += 1
        validation_count += 1

        if not validation.get("face_frontal", True):
            issues.append("face_not_frontal")
            if not suggestion:
                suggestion = "请正对镜头，不要偏头"
        else:
            validation_score += 1
        validation_count += 1

        if not validation.get("card_parallel", True):
            issues.append("card_not_parallel")
            if not suggestion:
                suggestion = "请确保卡片与脸部平行，避免倾斜"
        else:
            validation_score += 1
        validation_count += 1

        if not validation.get("card_horizontal", True):
            issues.append("card_not_horizontal")
            if not suggestion:
                suggestion = "请横放银行卡/身份证，不要竖放"
        else:
            validation_score += 1
        validation_count += 1

        if not validation.get("card_near_eyes", True):
            issues.append("card_far_from_eyes")
            if not suggestion:
                suggestion = "请将卡片横放在眉毛上方，并尽量贴近眼睛所在平面"
        else:
            validation_score += 1
        validation_count += 1

        if not validation.get("pd_in_range", True):
            issues.append("pd_out_of_range")
            if not suggestion:
                suggestion = "测量结果异常，请重新拍照"
        else:
            validation_score += 1
        validation_count += 1

        if not validation.get("pd_symmetry", True):
            issues.append("pd_asymmetric")
            if not suggestion:
                suggestion = "请正对镜头，鼻梁对准中线"
        else:
            validation_score += 1
        validation_count += 1

        # 验证分数加入总分
        if validation_count > 0:
            score += 0.2 * (validation_score / validation_count)

    # 瞳距范围检查（如果验证结果未提供）
    if pd and not validation:
        if pd["total"] < 50:
            issues.append("pd_too_small")
            score *= 0.5
            suggestion = "瞳距偏小，请检查卡片位置是否正确"
        elif pd["total"] > 80:
            issues.append("pd_too_large")
            score *= 0.5
            suggestion = "瞳距偏大，请检查卡片是否与人脸在同一平面"

        # 左右PD差距过大
        if abs(pd["left"] - pd["right"]) > 5:
            issues.append("pd_asymmetric")
            score *= 0.8
            if not suggestion:
                suggestion = "请正对镜头，鼻梁对准中线"

    return {
        "score": round(max(0, min(1, score)), 2),
        "issues": issues,
        "suggestion": suggestion
    }

# ==================== API 接口 ====================

@app.get("/")
async def root():
    return {"service": "瞳距测量服务", "version": "2.0.0", "status": "running"}

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.post("/v1/measure", response_model=MeasureResponse)
async def measure(req: MeasureRequest):
    """
    瞳距测量主接口

    请求参数:
    - image_base64: Base64编码的图片
    - card_width_mm: 卡片宽度（默认85.6mm，银行卡标准宽度）

    返回:
    - ok: 是否成功
    - pd: 瞳距结果 {total, left, right}
    - iris: 虹膜坐标
    - card: 卡片信息
    - quality: 质量评估
    """
    try:
        logger.info(f"收到测量请求, card_width_mm={req.card_width_mm}")

        # 1. 解码图片
        image = decode_image(req.image_base64)
        if image is None:
            return MeasureResponse(ok=False, message="图片解码失败")

        h, w = image.shape[:2]
        logger.info(f"图片尺寸: {w}x{h}")

        # 2. 检测虹膜 (MediaPipe)
        iris, iris_conf = detect_iris_mediapipe(image)
        if iris is None:
            return MeasureResponse(
                ok=False,
                message="未检测到人脸，请正对镜头",
                meta=MetaResult(width=w, height=h)
            )

        # 3. 检测卡片 (OpenCV)
        card_corners, card_conf, card_width_px = detect_card_opencv(image)
        if card_corners is None:
            # 返回虹膜坐标，但没有卡片
            return MeasureResponse(
                ok=False,
                message="未检测到卡片，请确保卡片完整出现在画面中",
                iris=IrisResult(
                    left=iris["left"],
                    right=iris["right"],
                    confidence=iris_conf
                ),
                meta=MetaResult(width=w, height=h)
            )

        # 4. 计算瞳距
        pd = calculate_pd(iris, card_corners, req.card_width_mm)
        if pd is None:
            return MeasureResponse(
                ok=False,
                message="瞳距计算失败",
                iris=IrisResult(
                    left=iris["left"],
                    right=iris["right"],
                    confidence=iris_conf
                ),
                card=CardResult(
                    corners=card_corners,
                    confidence=card_conf,
                    width_px=card_width_px
                ),
                meta=MetaResult(width=w, height=h)
            )

        # 5. 多重验证
        validation = validate_measurement(
            iris=iris,
            card_corners=card_corners,
            pd=pd,
            image_shape=image.shape
        )

        # 6. 质量评估（整合验证结果）
        quality = assess_quality(iris_conf, card_conf, pd, validation)

        # 7. 返回结果
        return MeasureResponse(
            ok=True,
            pd=PdResult(**pd),
            iris=IrisResult(
                left=iris["left"],
                right=iris["right"],
                confidence=iris_conf
            ),
            card=CardResult(
                corners=card_corners,
                confidence=card_conf,
                width_px=card_width_px
            ),
            meta=MetaResult(width=w, height=h),
            quality=QualityResult(**quality),
            validation=ValidationResult(**validation)
        )

    except Exception as e:
        logger.exception("测量异常")
        return MeasureResponse(ok=False, message=f"服务异常: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
