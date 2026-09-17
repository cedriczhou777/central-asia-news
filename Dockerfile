FROM node:20-slim

WORKDIR /app

# corepack 的 pnpm 版本必须与 package.json 的 packageManager 对齐（pnpm@9.0.0）。
# 旧版写 pnpm@latest：corepack 先下一个 latest，pnpm 检测到 packageManager 又切回 9.0.0，
# 白下一次，日志里还会冒出一句 "Update available! 9.0.0 → 12.4.2" 干扰排查。
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

COPY . .

# 安装 → 构建 → 裁掉 devDependencies → 清缓存，必须写在同一条 RUN 里。
# Docker 是分层存储：在后面的层里删除文件，前面的层照样留在镜像里，体积一点不省。
# 想真正瘦身，「产生」和「删除」只能发生在同一个层里。
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm prune --prod \
 && rm -rf .next/cache \
 && rm -rf "$(pnpm store path)"

# 构建期冒烟：确认裁剪后的依赖树里，服务真正需要的两个外部包还在。
# 依据是构建产物本身 —— dist/server.js 的外部 require 只有 next 和 node-cron
# （其余全是 node: 内置模块，见 `grep -oE 'require\("[^"]+"\)' dist/server.js`）。
# 这类问题如果在运行时才炸，只会表现为「部署失败：探针 connection refused」，排查成本高得多；
# 放在构建期失败则不会影响正在运行的旧版本。
RUN node -e "require('next'); require('node-cron'); console.log('runtime deps ok')"

EXPOSE 3000

CMD ["pnpm", "start"]
