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
            try:
                true_total = _parse_float(row.get("true_pd_total"))
            except ValueError:
                invalid.append(InvalidRow(line_no, filename, "true_pd_total not a number"))
                continue
            if true_total is None:
                invalid.append(InvalidRow(line_no, filename, "missing true_pd_total"))
                continue
            image_path = os.path.join(images_dir, filename)
            if not os.path.exists(image_path):
                invalid.append(InvalidRow(line_no, filename, "image file not found"))
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
