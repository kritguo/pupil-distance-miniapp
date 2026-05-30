# 瞳距测量云端服务

基于 MediaPipe + OpenCV 的瞳距测量 API 服务。

## 技术栈

- **框架**: FastAPI + Uvicorn
- **虹膜检测**: MediaPipe Face Mesh (478 关键点 + 虹膜精细定位)
- **卡片检测**: OpenCV Canny + 轮廓逼近
- **部署**: Docker + Caddy (HTTPS)

## 目录结构

```
cloud-service/
├── main.py              # 主服务代码
├── requirements.txt     # Python 依赖
├── Dockerfile           # Docker 镜像配置
├── docker-compose.yml   # Docker Compose 配置
├── deploy.sh            # 部署脚本
├── Caddyfile            # Caddy HTTPS 配置
└── README.md            # 说明文档
```

## 部署步骤

### 1. 上传代码到服务器

```bash
# 本地执行
scp -r cloud-service/ root@your-server:/opt/iris-service/
```

### 2. SSH 登录服务器并部署

```bash
ssh root@your-server
cd /opt/iris-service
chmod +x deploy.sh
./deploy.sh
```

### 3. 配置 Caddy HTTPS

```bash
# 复制 Caddyfile 到 Caddy 配置目录
cp Caddyfile /etc/caddy/Caddyfile

# 重载 Caddy
systemctl reload caddy
```

## API 接口

### POST /v1/measure

测量瞳距。

**请求体**:
```json
{
  "image_base64": "base64编码的图片",
  "card_width_mm": 85.6
}
```

**响应**:
```json
{
  "ok": true,
  "pd": {
    "total": 63.5,
    "left": 31.5,
    "right": 32.0
  },
  "iris": {
    "left": {"x": 350, "y": 420},
    "right": {"x": 650, "y": 420},
    "confidence": 0.95
  },
  "card": {
    "corners": [...],
    "confidence": 0.88,
    "width_px": 520
  },
  "quality": {
    "score": 0.85,
    "issues": [],
    "suggestion": null
  },
  "meta": {
    "width": 1920,
    "height": 1080
  }
}
```

### GET /health

健康检查。

### GET /docs

Swagger API 文档。

## 本地测试

```bash
# 安装依赖
pip install -r requirements.txt

# 启动服务
python main.py

# 测试
curl http://localhost:8000/health
```

## 常用命令

```bash
# 查看日志
docker-compose logs -f

# 重启服务
docker-compose restart

# 停止服务
docker-compose down

# 重新构建并启动
docker-compose up -d --build
```

## 性能优化

- MediaPipe 模型首次加载约 2-3 秒，之后每次请求约 200-500ms
- 建议服务器配置: 2核4G 以上
- 内存限制: 2G (docker-compose.yml 中配置)

## 故障排查

1. **MediaPipe 安装失败**: 确保系统有 libgl1-mesa-glx 等依赖
2. **内存不足**: 增加服务器内存或调整 Docker 内存限制
3. **卡片检测不准**: 调整 Canny 阈值参数

## 精度验证(离线)

把带真实验光 PD 的照片放进 `validation/dataset/`,运行:

```bash
cd cloud-service
pip install pytest            # 首次
python -m validation.run_validation
```

报告输出在 `validation/reports/validation-report.md`,含:总体误差、
建议的 `PD_CALIBRATION` 值、个体虹膜差异、残差相关性、卡片对照。
数据集格式见 `validation/dataset/README.md`。照片含人脸,已 gitignore。
