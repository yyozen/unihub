#!/bin/bash

# 准备插件仓库的快速脚本
# 用法: ./scripts/prepare-plugin-repo.sh [目标目录]

set -e

TARGET_DIR="${1:-../unihub-plugins}"
CURRENT_DIR=$(pwd)

echo "🚀 准备创建插件仓库..."
echo "📁 目标目录: $TARGET_DIR"
echo ""

# 检查目标目录是否存在
if [ -d "$TARGET_DIR" ]; then
    read -p "⚠️  目标目录已存在，是否继续？(y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ 已取消"
        exit 1
    fi
else
    mkdir -p "$TARGET_DIR"
fi

cd "$TARGET_DIR"

echo "📦 创建目录结构..."
mkdir -p plugins marketplace scripts .github/workflows

echo "📝 创建 package.json..."
cat > package.json << 'EOF'
{
  "name": "unihub-plugins",
  "version": "1.0.0",
  "description": "Official plugins for UniHub",
  "private": true,
  "scripts": {
    "build:all": "node scripts/build-all.js",
    "package:all": "node scripts/package-all.js",
    "publish:all": "node scripts/publish-to-cdn.js",
    "update-marketplace": "node scripts/update-marketplace.js"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/t8y2/unihub-plugins.git"
  },
  "author": "UniHub Team",
  "license": "MIT",
  "devDependencies": {
    "adm-zip": "^0.5.10",
    "cos-nodejs-sdk-v5": "^2.14.4"
  }
}
EOF

echo "📝 创建 pnpm-workspace.yaml..."
cat > pnpm-workspace.yaml << 'EOF'
packages:
  - 'plugins/*'
EOF

echo "📝 创建 .gitignore..."
cat > .gitignore << 'EOF'
node_modules/
dist/
*.zip
*.log
.DS_Store
.env.local
.env
EOF

echo "📝 创建 README.md..."
cat > README.md << 'EOF'
# UniHub Official Plugins

官方插件仓库，包含所有 UniHub 官方维护的插件。

## 快速开始

```bash
# 安装依赖
pnpm install

# 构建所有插件
pnpm run build:all

# 打包所有插件
pnpm run package:all

# 发布到 CDN
pnpm run publish:all
```

## 插件列表

查看 [marketplace/plugins.json](./marketplace/plugins.json) 获取完整插件列表。

## 开发指南

### 本地开发

```bash
cd plugins/your-plugin
pnpm install
pnpm run dev
```

### 构建插件

```bash
pnpm run build
pnpm run package
```

## 发布流程

1. 提交代码到 main 分支
2. GitHub Actions 自动构建
3. 自动上传到 CDN
4. 更新 marketplace/plugins.json
5. 主仓库自动同步

## License

MIT
EOF

echo "📋 复制插件代码..."
if [ -d "$CURRENT_DIR/official-plugins" ]; then
    cp -r "$CURRENT_DIR/official-plugins/"* plugins/ 2>/dev/null || true
    echo "✅ 已复制 $(ls -1 plugins | wc -l) 个插件"
else
    echo "⚠️  未找到 official-plugins 目录，跳过"
fi

echo "📋 复制 marketplace 配置..."
if [ -f "$CURRENT_DIR/marketplace/plugins.json" ]; then
    cp "$CURRENT_DIR/marketplace/plugins.json" marketplace/
    echo "✅ 已复制 marketplace/plugins.json"
else
    echo "⚠️  未找到 marketplace/plugins.json，创建空配置"
    cat > marketplace/plugins.json << 'EOF'
{
  "version": "1.0.0",
  "lastUpdated": "2025-01-27T00:00:00Z",
  "plugins": []
}
EOF
fi

echo "📋 复制构建脚本..."
if [ -f "$CURRENT_DIR/scripts/upload-to-cos.js" ]; then
    cp "$CURRENT_DIR/scripts/upload-to-cos.js" scripts/
    echo "✅ 已复制上传脚本"
fi

echo ""
echo "✨ 插件仓库准备完成！"
echo ""
echo "📍 位置: $TARGET_DIR"
echo ""
echo "🔧 下一步操作："
echo "  1. cd $TARGET_DIR"
echo "  2. git init"
echo "  3. git add ."
echo "  4. git commit -m 'feat: initial plugin repository'"
echo "  5. git remote add origin https://github.com/t8y2/unihub-plugins.git"
echo "  6. git push -u origin main"
echo ""
echo "  然后参考 MIGRATION_GUIDE.md 完成剩余步骤"
echo ""
