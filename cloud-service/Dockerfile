# 瞳距测量服务 Dockerfile
# 固定 bookworm：python:3.11-slim 现已指向 trixie，其上 libgl1-mesa-glx 被移除会导致构建失败
FROM python:3.11-slim-bookworm

# 设置时区
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# 系统依赖：使用 opencv-python-headless，无需 X11 库；libgl1/libglib 供 cv2/mediapipe，libgomp1 供 OpenMP
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制依赖文件，利用 Docker 缓存
COPY requirements.txt .

# 安装 Python 依赖（用腾讯云镜像，避免清华镜像对构建机 403）
RUN pip install --no-cache-dir -r requirements.txt \
    -i https://mirrors.cloud.tencent.com/pypi/simple \
    --trusted-host mirrors.cloud.tencent.com

# 复制应用代码
COPY main.py .

# 暴露端口
EXPOSE 8000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# 启动服务（单worker，避免MediaPipe模型重复加载）
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
