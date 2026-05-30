# 验证数据集

1. 把正脸照片放进 `images/`(如 `001.jpg`)。
2. 复制 `labels.csv.template` 为 `labels.csv`,逐行填真实验光 PD。
   - `true_pd_left` / `true_pd_right` 可留空(只验总 PD)。
   - `subject_id`:同一个人多张照片填同一个 id,用于量化个体虹膜差异。
3. 运行:`cd cloud-service && python -m validation.run_validation`
4. 报告输出在 `validation/reports/`。

> 照片含人脸,已在 `.gitignore` 排除,不会提交到仓库。
