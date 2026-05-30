# 测量精度离线验证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建一套离线批量工具,把「带真实验光 PD 的人脸照片」跑过现有虹膜测量算法,产出量化误差报告(系统偏差、最优 `PD_CALIBRATION`、个体虹膜差异、残差相关性、卡片对照)。

**Architecture:** 在 `cloud-service/validation/` 下做一个独立 Python 包,**复用 `cloud-service/main.py` 的算法函数**(不改算法)。分四个单元:数据加载器 → 测量适配器 → 误差分析器 → 报告器,由 `run_validation.py` 串联。测量值以 `PD_CALIBRATION=1.0` 为基线采集,标定系数在分析阶段解析求解(测量值对系数线性)。

**Tech Stack:** Python 3.11、复用 `main.py`(mediapipe / opencv-python-headless / numpy)、pytest 测试。

---

## 运行约定

- 所有命令在 `cloud-service/` 目录下执行,包以 `validation` 名运行:`python -m validation.run_validation`。
- 测试:`cd cloud-service && python -m pytest validation/tests -v`。需要先 `pip install pytest`(若环境未装)。
- `validation/tests/` 下的 loader / analyzer / reporter 测试**只依赖标准库 + numpy**,不需要 mediapipe;只有 `measure_adapter` 的「真实图片」集成测试需要 mediapipe,且无 fixture 时自动 skip。

## 文件结构

| 文件 | 职责 |
|---|---|
| `cloud-service/validation/__init__.py` | 包标识(空) |
| `cloud-service/validation/dataset_loader.py` | 读 `labels.csv`、配对图片、校验完整性、列出无效行 |
| `cloud-service/validation/measure_adapter.py` | 调 `main.py` 算法把单图跑成 `MeasureOutput`;纯函数 `build_output` 负责组装 |
| `cloud-service/validation/analyzer.py` | 真值×测量值 → 指标、最优标定、个体虹膜、相关性、卡片对照 |
| `cloud-service/validation/reporter.py` | 渲染 markdown / CSV / 控制台 |
| `cloud-service/validation/run_validation.py` | CLI 入口,串联以上 |
| `cloud-service/validation/dataset/labels.csv.template` | 真值表模板 |
| `cloud-service/validation/dataset/README.md` | 数据集格式说明 |
| `cloud-service/validation/.gitignore` | 忽略 `dataset/images/`(人脸隐私)与产出大文件 |
| `cloud-service/validation/reports/.gitkeep` | 报告输出目录占位 |
| `cloud-service/validation/tests/*.py` | 各单元测试 |

---

## Task 1: 包脚手架 + 数据集模板 + gitignore

**Files:**
- Create: `cloud-service/validation/__init__.py`
- Create: `cloud-service/validation/dataset/labels.csv.template`
- Create: `cloud-service/validation/dataset/README.md`
- Create: `cloud-service/validation/.gitignore`
- Create: `cloud-service/validation/reports/.gitkeep`
- Create: `cloud-service/validation/tests/__init__.py`
- Test: `cloud-service/validation/tests/test_smoke.py`

- [ ] **Step 1: Write the failing test**

`cloud-service/validation/tests/test_smoke.py`:
```python
def test_package_imports():
    import validation
    assert validation is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cloud-service && python -m pytest validation/tests/test_smoke.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'validation'`

- [ ] **Step 3: Create the scaffold files**

`cloud-service/validation/__init__.py`:
```python
# 测量精度离线验证工具包
```

`cloud-service/validation/tests/__init__.py`:
```python
```

`cloud-service/validation/.gitignore`:
```gitignore
# 人脸照片属隐私,不入库
dataset/images/
# 报告产出可保留 markdown,但忽略大体积 csv 缓存
reports/*.csv
```

`cloud-service/validation/reports/.gitkeep`:
```
```

`cloud-service/validation/dataset/labels.csv.template`:
```csv
filename,subject_id,true_pd_total,true_pd_left,true_pd_right,notes
001.jpg,zhang,63.0,31.5,31.5,验光单
002.jpg,zhang,63.0,31.5,31.5,同一人第二张
003.jpg,li,60.5,30.0,30.5,
```

`cloud-service/validation/dataset/README.md`:
```markdown
# 验证数据集

1. 把正脸照片放进 `images/`(如 `001.jpg`)。
2. 复制 `labels.csv.template` 为 `labels.csv`,逐行填真实验光 PD。
   - `true_pd_left` / `true_pd_right` 可留空(只验总 PD)。
   - `subject_id`:同一个人多张照片填同一个 id,用于量化个体虹膜差异。
3. 运行:`cd cloud-service && python -m validation.run_validation`
4. 报告输出在 `validation/reports/`。

> 照片含人脸,已在 `.gitignore` 排除,不会提交到仓库。
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cloud-service && python -m pytest validation/tests/test_smoke.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd cloud-service
git add validation/
git commit -m "feat(validation): scaffold offline accuracy validation package"
```

---

## Task 2: 数据加载器 `dataset_loader.py`

**Files:**
- Create: `cloud-service/validation/dataset_loader.py`
- Test: `cloud-service/validation/tests/test_dataset_loader.py`

- [ ] **Step 1: Write the failing test**

`cloud-service/validation/tests/test_dataset_loader.py`:
```python
import os
from validation.dataset_loader import load_dataset


def _make_dataset(tmp_path, rows):
    images = tmp_path / "images"
    images.mkdir()
    header = "filename,subject_id,true_pd_total,true_pd_left,true_pd_right,notes\n"
    (tmp_path / "labels.csv").write_text(header + "".join(rows), encoding="utf-8")
    return images


def test_valid_and_invalid_rows(tmp_path):
    images = _make_dataset(tmp_path, [
        "001.jpg,zhang,63.0,31.5,31.5,ok\n",   # valid
        "002.jpg,li,,,,missing total\n",        # invalid: no true_pd_total
        "ghost.jpg,wang,60,,,no image file\n",  # invalid: image missing
    ])
    (images / "001.jpg").write_bytes(b"x")
    samples, invalid = load_dataset(str(tmp_path))
    assert len(samples) == 1
    assert samples[0].filename == "001.jpg"
    assert samples[0].subject_id == "zhang"
    assert samples[0].true_total == 63.0
    assert samples[0].true_left == 31.5
    assert {iv.reason for iv in invalid} == {"missing true_pd_total", "image file not found"}


def test_optional_left_right_blank(tmp_path):
    images = _make_dataset(tmp_path, ["010.jpg,a,62,,,only total\n"])
    (images / "010.jpg").write_bytes(b"x")
    samples, invalid = load_dataset(str(tmp_path))
    assert len(samples) == 1
    assert samples[0].true_left is None and samples[0].true_right is None


def test_subject_id_defaults_to_filename(tmp_path):
    images = _make_dataset(tmp_path, ["020.jpg,,62,,,no subject\n"])
    (images / "020.jpg").write_bytes(b"x")
    samples, _ = load_dataset(str(tmp_path))
    assert samples[0].subject_id == "020.jpg"


def test_missing_labels_file_raises(tmp_path):
    (tmp_path / "images").mkdir()
    try:
        load_dataset(str(tmp_path))
        assert False, "should raise"
    except FileNotFoundError:
        pass
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cloud-service && python -m pytest validation/tests/test_dataset_loader.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'validation.dataset_loader'`

- [ ] **Step 3: Write the implementation**

`cloud-service/validation/dataset_loader.py`:
```python
import csv
import os
from dataclasses import dataclass
from typing import List, Optional, Tuple


@dataclass
class Sample:
    filename: str
    image_path: str
    subject_id: str
    true_total: float
    true_left: Optional[float]
    true_right: Optional[float]
    notes: str


@dataclass
class InvalidRow:
    line_no: int
    filename: str
    reason: str


def _parse_float(value: Optional[str]) -> Optional[float]:
    s = (value or "").strip()
    if s == "":
        return None
    return float(s)


def load_dataset(dataset_dir: str) -> Tuple[List[Sample], List[InvalidRow]]:
    labels_path = os.path.join(dataset_dir, "labels.csv")
    images_dir = os.path.join(dataset_dir, "images")
    if not os.path.exists(labels_path):
        raise FileNotFoundError(f"labels.csv not found: {labels_path}")

    samples: List[Sample] = []
    invalid: List[InvalidRow] = []
    with open(labels_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for line_no, row in enumerate(reader, start=2):  # line 1 = header
            filename = (row.get("filename") or "").strip()
            if not filename:
                invalid.append(InvalidRow(line_no, "", "missing filename"))
                continue
            image_path = os.path.join(images_dir, filename)
            if not os.path.exists(image_path):
                invalid.append(InvalidRow(line_no, filename, "image file not found"))
                continue
            try:
                true_total = _parse_float(row.get("true_pd_total"))
            except ValueError:
                invalid.append(InvalidRow(line_no, filename, "true_pd_total not a number"))
                continue
            if true_total is None:
                invalid.append(InvalidRow(line_no, filename, "missing true_pd_total"))
                continue
            try:
                true_left = _parse_float(row.get("true_pd_left"))
                true_right = _parse_float(row.get("true_pd_right"))
            except ValueError:
                invalid.append(InvalidRow(line_no, filename, "true_pd_left/right not a number"))
                continue
            samples.append(Sample(
                filename=filename,
                image_path=image_path,
                subject_id=(row.get("subject_id") or "").strip() or filename,
                true_total=true_total,
                true_left=true_left,
                true_right=true_right,
                notes=(row.get("notes") or "").strip(),
            ))
    return samples, invalid
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cloud-service && python -m pytest validation/tests/test_dataset_loader.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
cd cloud-service
git add validation/dataset_loader.py validation/tests/test_dataset_loader.py
git commit -m "feat(validation): dataset loader with row validation"
```

---

## Task 3: 测量适配器 `measure_adapter.py`

**Files:**
- Create: `cloud-service/validation/measure_adapter.py`
- Test: `cloud-service/validation/tests/test_measure_adapter.py`

适配器拆成两半:纯函数 `build_output`(从算法返回的 dict 组装,不依赖 main,可单测)+ `measure_image`(I/O + 调 main 的真实图片集成,无 fixture 时 skip)。

- [ ] **Step 1: Write the failing test**

`cloud-service/validation/tests/test_measure_adapter.py`:
```python
import os
import pytest
from validation.measure_adapter import build_output, measure_image, MeasureOutput


def test_build_output_assembles_unrounded_total():
    iris = {
        "diam_avg_px": 50.0, "diam_left_px": 49.0, "diam_right_px": 51.0,
        "eye_open_left": 8.0, "eye_open_right": 7.0,
    }
    pd = {"total": 63.0, "left": 31.5, "right": 31.5, "scale": 0.234, "pupil_px": 270.0}
    validation = {
        "overall_valid": True,
        "details": {"roll_ratio": 0.02, "nose_offset_ratio": 0.03, "iris_diam_asym": 0.04},
    }
    quality = {"score": 0.92}
    out = build_output(iris, pd, 64.0, validation, quality, (1200, 900, 3))
    assert out.ok is True
    assert out.raw_total == pytest.approx(270.0 * 0.234)  # 未取整
    assert out.pupil_px == 270.0
    assert out.diam_avg_px == 50.0
    assert out.eye_open_min == 7.0
    assert out.iris_diam_asym == 0.04
    assert out.quality_score == 0.92
    assert out.overall_valid is True
    assert out.card_total == 64.0
    assert out.img_w == 900 and out.img_h == 1200


FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "sample_face.jpg")


@pytest.mark.skipif(not os.path.exists(FIXTURE), reason="no fixture face image")
def test_measure_image_real_face():
    out = measure_image(FIXTURE)
    assert out.ok is True
    assert 40.0 < out.raw_total < 90.0
    assert out.pupil_px > 0 and out.diam_avg_px > 0


def test_measure_image_missing_file_returns_not_ok():
    out = measure_image("/no/such/file.jpg")
    assert out.ok is False
    assert out.reason == "image_read_failed"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cloud-service && python -m pytest validation/tests/test_measure_adapter.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'validation.measure_adapter'`

- [ ] **Step 3: Write the implementation**

`cloud-service/validation/measure_adapter.py`:
```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cloud-service && python -m pytest validation/tests/test_measure_adapter.py -v`
Expected: PASS（`test_build_output_assembles_unrounded_total`、`test_measure_image_missing_file_returns_not_ok` 通过;`test_measure_image_real_face` 因无 fixture 而 SKIPPED)

- [ ] **Step 5: Commit**

```bash
cd cloud-service
git add validation/measure_adapter.py validation/tests/test_measure_adapter.py
git commit -m "feat(validation): measure adapter reusing main.py algorithm"
```

---

## Task 4: 误差分析器 A — 指标 + 最优标定 `analyzer.py`

**Files:**
- Create: `cloud-service/validation/analyzer.py`
- Test: `cloud-service/validation/tests/test_analyzer_metrics.py`

- [ ] **Step 1: Write the failing test**

`cloud-service/validation/tests/test_analyzer_metrics.py`:
```python
import pytest
from validation.analyzer import (
    SampleResult, compute_metrics, unbiased_calibration, optimal_calibration_mae,
)


def _sr(raw_total, true_total, subject="a"):
    return SampleResult(
        filename="x.jpg", subject_id=subject,
        true_total=true_total, true_left=None, true_right=None,
        raw_total=raw_total, left_pd=0.0, right_pd=0.0,
        pupil_px=270.0, diam_avg_px=50.0, diam_left_px=50.0, diam_right_px=50.0,
        eye_open_min=8.0, roll_ratio=0.0, nose_offset_ratio=0.0, iris_diam_asym=0.0,
        quality_score=0.9, overall_valid=True, card_total=None, img_w=900, img_h=1200,
    )


def test_compute_metrics_basic():
    results = [_sr(63.0, 63.0), _sr(65.0, 63.0)]  # errors 0, +2
    m = compute_metrics(results, 1.0)
    assert m.n == 2
    assert m.mean_error == pytest.approx(1.0)
    assert m.mae == pytest.approx(1.0)
    assert m.max_abs == pytest.approx(2.0)
    assert m.within_1mm_pct == pytest.approx(50.0)
    assert m.within_2mm_pct == pytest.approx(100.0)


def test_unbiased_calibration():
    results = [_sr(100.0, 110.0), _sr(100.0, 110.0)]
    assert unbiased_calibration(results) == pytest.approx(1.10)


def test_optimal_calibration_mae():
    results = [_sr(100.0, 110.0), _sr(100.0, 110.0)]
    k = optimal_calibration_mae(results)
    assert k == pytest.approx(1.10, abs=0.0011)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cloud-service && python -m pytest validation/tests/test_analyzer_metrics.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'validation.analyzer'`

- [ ] **Step 3: Write the implementation**

`cloud-service/validation/analyzer.py`:
```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cloud-service && python -m pytest validation/tests/test_analyzer_metrics.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
cd cloud-service
git add validation/analyzer.py validation/tests/test_analyzer_metrics.py
git commit -m "feat(validation): error metrics and optimal calibration solver"
```

---

## Task 5: 误差分析器 B — 个体虹膜 / 相关性 / 卡片 / 汇总

**Files:**
- Modify: `cloud-service/validation/analyzer.py`(追加内容,不改 Task 4 已有定义)
- Test: `cloud-service/validation/tests/test_analyzer_advanced.py`

- [ ] **Step 1: Write the failing test**

`cloud-service/validation/tests/test_analyzer_advanced.py`:
```python
import pytest
from validation.analyzer import (
    SampleResult, iris_variance, correlations, card_comparison, analyze, Report,
)


def _sr(raw_total, true_total, subject="a", card_total=None, pupil_px=270.0, diam=50.0):
    return SampleResult(
        filename="x.jpg", subject_id=subject,
        true_total=true_total, true_left=None, true_right=None,
        raw_total=raw_total, left_pd=0.0, right_pd=0.0,
        pupil_px=pupil_px, diam_avg_px=diam, diam_left_px=diam, diam_right_px=diam,
        eye_open_min=8.0, roll_ratio=0.0, nose_offset_ratio=0.0, iris_diam_asym=0.0,
        quality_score=0.9, overall_valid=True, card_total=card_total, img_w=900, img_h=1200,
    )


def test_iris_variance_single_subject_self_calibrates_to_zero():
    # 单样本:用其自身有效虹膜直径反算,误差应为 0
    r = _sr(raw_total=63.0, true_total=63.0, pupil_px=270.0, diam=50.0)
    iv = iris_variance([r])
    assert iv.n_subjects == 1
    assert iv.mean_hvid == pytest.approx(63.0 * 50.0 / 270.0)
    assert iv.individual_calibrated_mae == pytest.approx(0.0, abs=1e-9)


def test_correlations_returns_keys():
    results = [_sr(63.0, 63.0), _sr(65.0, 63.0), _sr(61.0, 63.0)]
    cors = correlations(results, 1.0)
    assert set(cors.keys()) == {
        "iris_diam_asym", "quality_score", "eye_open_min", "resolution_min_dim",
    }


def test_card_comparison_counts_closer():
    # 卡片真值更接近:iris 偏 +3,card 偏 +0.5
    results = [_sr(66.0, 63.0, card_total=63.5), _sr(66.0, 63.0, card_total=63.5)]
    cc = card_comparison(results, 1.0)
    assert cc["n"] == 2
    assert cc["card_mae"] == pytest.approx(0.5)
    assert cc["iris_mae"] == pytest.approx(3.0)
    assert cc["card_closer_pct"] == pytest.approx(100.0)


def test_card_comparison_none_when_no_card():
    assert card_comparison([_sr(63.0, 63.0)], 1.0) is None


def test_analyze_bundles_report():
    results = [_sr(100.0, 110.0), _sr(100.0, 110.0)]
    rep = analyze(results)
    assert isinstance(rep, Report)
    assert rep.k_mae == pytest.approx(1.10, abs=0.0011)
    assert rep.metrics_before.calibration == 1.0
    assert rep.metrics_after.mae < rep.metrics_before.mae
    assert rep.n_valid == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cloud-service && python -m pytest validation/tests/test_analyzer_advanced.py -v`
Expected: FAIL — `ImportError: cannot import name 'iris_variance'`

- [ ] **Step 3: Append the implementation to `analyzer.py`**

在 `cloud-service/validation/analyzer.py` 末尾追加:
```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cloud-service && python -m pytest validation/tests/test_analyzer_advanced.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
cd cloud-service
git add validation/analyzer.py validation/tests/test_analyzer_advanced.py
git commit -m "feat(validation): iris variance, correlations, card comparison, analyze()"
```

---

## Task 6: 报告器 `reporter.py`

**Files:**
- Create: `cloud-service/validation/reporter.py`
- Test: `cloud-service/validation/tests/test_reporter.py`

- [ ] **Step 1: Write the failing test**

`cloud-service/validation/tests/test_reporter.py`:
```python
import os
from validation.analyzer import SampleResult, analyze
from validation.dataset_loader import InvalidRow
from validation.reporter import render_markdown, write_csv


def _sr(raw_total, true_total, subject="a"):
    return SampleResult(
        filename="x.jpg", subject_id=subject,
        true_total=true_total, true_left=None, true_right=None,
        raw_total=raw_total, left_pd=0.0, right_pd=0.0,
        pupil_px=270.0, diam_avg_px=50.0, diam_left_px=50.0, diam_right_px=50.0,
        eye_open_min=8.0, roll_ratio=0.0, nose_offset_ratio=0.0, iris_diam_asym=0.0,
        quality_score=0.9, overall_valid=True, card_total=None, img_w=900, img_h=1200,
    )


def test_render_markdown_contains_key_sections():
    results = [_sr(100.0, 110.0), _sr(100.0, 110.0)]
    rep = analyze(results)
    md = render_markdown(rep, results, [InvalidRow(5, "bad.jpg", "image file not found")])
    assert "建议" in md and "PD_CALIBRATION" in md
    assert "1.1" in md  # 建议系数
    assert "bad.jpg" in md  # 无效样本被列出
    assert "命中率" in md


def test_write_csv_creates_file(tmp_path):
    results = [_sr(100.0, 110.0)]
    out = tmp_path / "per-sample.csv"
    write_csv(results, str(out))
    assert out.exists()
    text = out.read_text(encoding="utf-8")
    assert "filename" in text and "x.jpg" in text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cloud-service && python -m pytest validation/tests/test_reporter.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'validation.reporter'`

- [ ] **Step 3: Write the implementation**

`cloud-service/validation/reporter.py`:
```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cloud-service && python -m pytest validation/tests/test_reporter.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
cd cloud-service
git add validation/reporter.py validation/tests/test_reporter.py
git commit -m "feat(validation): markdown/csv/console reporter"
```

---

## Task 7: 入口串联 `run_validation.py` + 端到端 + 文档

**Files:**
- Create: `cloud-service/validation/run_validation.py`
- Test: `cloud-service/validation/tests/test_run_validation.py`
- Modify: `cloud-service/README.md`(追加「精度验证」一节)

- [ ] **Step 1: Write the failing test**

`cloud-service/validation/tests/test_run_validation.py`:
```python
import os
from validation import run_validation as rv
from validation.measure_adapter import MeasureOutput


def test_run_writes_reports(tmp_path, monkeypatch):
    # 造数据集:两张图同一人
    ds = tmp_path / "dataset"
    images = ds / "images"
    images.mkdir(parents=True)
    (images / "001.jpg").write_bytes(b"x")
    (images / "002.jpg").write_bytes(b"x")
    header = "filename,subject_id,true_pd_total,true_pd_left,true_pd_right,notes\n"
    (ds / "labels.csv").write_text(
        header + "001.jpg,a,110,,,\n002.jpg,a,110,,,\n", encoding="utf-8")

    # 跳过真实 mediapipe:measure_image 返回固定结果
    def fake_measure(path):
        return MeasureOutput(ok=True, raw_total=100.0, pupil_px=270.0, diam_avg_px=50.0,
                             quality_score=0.9, overall_valid=True, img_w=900, img_h=1200)
    monkeypatch.setattr(rv, "measure_image", fake_measure)

    report_dir = tmp_path / "reports"
    summary = rv.run(str(ds), str(report_dir))

    assert (report_dir / "validation-report.md").exists()
    assert (report_dir / "per-sample.csv").exists()
    assert "PD_CALIBRATION=1.1" in summary


def test_run_handles_empty_valid_set(tmp_path, monkeypatch):
    ds = tmp_path / "dataset"
    (ds / "images").mkdir(parents=True)
    header = "filename,subject_id,true_pd_total,true_pd_left,true_pd_right,notes\n"
    (ds / "labels.csv").write_text(header + "ghost.jpg,a,110,,,\n", encoding="utf-8")
    summary = rv.run(str(ds), str(tmp_path / "reports"))
    assert "无有效样本" in summary
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cloud-service && python -m pytest validation/tests/test_run_validation.py -v`
Expected: FAIL — `AttributeError: module 'validation.run_validation' has no attribute 'run'`

- [ ] **Step 3: Write the implementation**

`cloud-service/validation/run_validation.py`:
```python
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
```

> 注:`measure_image` 失败的样本(无脸 / 虹膜不清 / 读图失败)通过 `_failed_row` 并入 `invalid` 清单,与加载阶段的无效行一起在报告「无效样本」区列出,不污染统计。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cloud-service && python -m pytest validation/tests/test_run_validation.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: 全量测试 + 文档 + 提交**

Run 全部测试:
```bash
cd cloud-service && python -m pytest validation/tests -v
```
Expected: 全部 PASS(`test_measure_image_real_face` SKIPPED)

在 `cloud-service/README.md` 末尾追加:
```markdown
## 精度验证(离线)

把带真实验光 PD 的照片放进 `validation/dataset/`,运行:

\`\`\`bash
cd cloud-service
pip install pytest            # 首次
python -m validation.run_validation
\`\`\`

报告输出在 `validation/reports/validation-report.md`,含:总体误差、
建议的 `PD_CALIBRATION` 值、个体虹膜差异、残差相关性、卡片对照。
数据集格式见 `validation/dataset/README.md`。照片含人脸,已 gitignore。
```

提交:
```bash
cd cloud-service
git add validation/run_validation.py validation/tests/test_run_validation.py README.md
git commit -m "feat(validation): CLI entrypoint, end-to-end test, docs"
```

---

## Self-Review

**1. Spec coverage**
- 数据集格式(`images/ + labels.csv`,subject_id,可选左右)→ Task 1 模板 + Task 2 加载器 ✅
- 直接 import main.py、基线 calibration=1.0 → Task 3 `measure_image` ✅
- 误差报告 6 块:总体指标 / 最优标定 / 个体虹膜 / 残差相关性 / 卡片对照 / 无效样本 → Task 4+5 分析、Task 6 报告 ✅
- 主目标最小化 MAE + 无偏系数参考 → Task 4 `optimal_calibration_mae` / `unbiased_calibration` ✅
- 输出 markdown + CSV + 控制台,reports/ 存档 → Task 6 + Task 7 ✅
- 无效样本显式列出不污染统计 → Task 2(加载阶段)+ Task 7(测量失败也并入 invalid)✅
- 可重复运行结果稳定 → 纯函数 + 固定 calibration=1.0,确定性 ✅
- 不改算法、不改小程序 → 仅新增 `validation/` + README 追加,`main.py` 零改动 ✅

**2. Placeholder scan**:无 TBD/TODO;所有步骤含完整代码与命令。Task 7 的三元写法已在 Step 3b 显式修正为清晰版本。

**3. Type consistency**:
- `MeasureOutput`(Task 3)字段被 Task 7 `_to_sample_result` 逐一映射到 `SampleResult`(Task 4),字段名一致。
- `Report` / `Metrics` / `IrisVariance`(Task 4/5)被 Task 6 reporter 按相同属性名读取。
- `InvalidRow(line_no, filename, reason)`(Task 2)在 Task 6/7 按相同字段名使用。
- 函数名 `load_dataset` / `measure_image` / `build_output` / `compute_metrics` / `optimal_calibration_mae` / `unbiased_calibration` / `iris_variance` / `correlations` / `card_comparison` / `analyze` / `render_markdown` / `write_csv` / `render_console` / `run` 全程一致。
