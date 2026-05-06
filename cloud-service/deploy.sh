#!/bin/bash
# 瞳距测量服务部署脚本
# 在腾讯云服务器上执行

set -e

echo "========== 瞳距测量服务部署 =========="

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Docker 未安装，正在安装...${NC}"
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
fi

# 检查 Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo -e "${YELLOW}安装 Docker Compose...${NC}"
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
fi

echo -e "${GREEN}Docker 版本:${NC} $(docker --version)"
echo -e "${GREEN}Docker Compose 版本:${NC} $(docker-compose --version)"

# 停止旧容器
echo -e "${YELLOW}停止旧服务...${NC}"
docker-compose down 2>/dev/null || true
docker stop iris-service 2>/dev/null || true
docker rm iris-service 2>/dev/null || true

# 构建新镜像
echo -e "${YELLOW}构建新镜像...${NC}"
docker-compose build --no-cache

# 启动服务
echo -e "${YELLOW}启动服务...${NC}"
docker-compose up -d

# 等待服务启动
echo -e "${YELLOW}等待服务启动...${NC}"
sleep 5

# 检查服务状态
if curl -s http://localhost:8000/health | grep -q "ok"; then
    echo -e "${GREEN}✅ 服务启动成功！${NC}"
    echo ""
    echo "服务地址: http://localhost:8000"
    echo "健康检查: http://localhost:8000/health"
    echo "API 文档: http://localhost:8000/docs"
    echo ""
    echo "查看日志: docker-compose logs -f"
else
    echo -e "${RED}❌ 服务启动失败${NC}"
    echo "查看日志: docker-compose logs"
    exit 1
fi

echo ""
echo "========== 部署完成 =========="
