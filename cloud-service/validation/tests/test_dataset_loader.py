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
