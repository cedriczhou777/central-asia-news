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

# 构建期冒烟：确认裁剪后的依赖树里，服务真正需要的包还在。
#
# ⚠️ 2026-10-11 扩了清单。原来只查 next + node-cron（依据是 `dist/server.js` 的外部
# require 只有这两个）。但那只覆盖了**入口文件**，而 Next 的路由是**按需加载**的 ——
# 路由里的 require 在构建期根本不出现，漏掉一个就是「部署成功、探针过了，
# 第一条请求才 500」。所以这里改成**按 dependencies 逐个 load**：
# 清单与 package.json 的 dependencies 一致（10 个，逐个都有运行期引用点，
# 判据与维护纪律见 AGENTS.md 的「运行时依赖只有 10 个」）。
#
# 依据仍然是构建产物本身（`grep -oE 'require\("[^"]+"\)' dist/server.js`
# → http / next / node-cron / url，其余全是 node: 内置），加上**路由侧**的运行期引用。
# 这类问题如果在运行时才炸，只会表现为「部署失败：探针 connection refused」
# 或「第一条请求 500」，排查成本高得多；放在构建期失败则不会影响正在运行的旧版本。
RUN node -e "for (const m of ['next','node-cron','@supabase/supabase-js','rss-parser','cheerio','clsx','tailwind-merge']) require(m); console.log('runtime deps ok')"

# sharp 探针：推送前要把外链封面（中亚媒体站大量用 .webp）转成微信素材接口认的 JPEG。
# sharp 已在 package.json 的 dependencies 里**显式声明** —— 这是必需的，别删：
# pnpm 只对直接依赖在根 node_modules 建软链，而 next build 的类型检查会解析
# import('sharp')，解析不到就直接 TS2307 构建失败。（scripts/build.sh 里有对应的提前诊断。）
# 这里只做「报告」不做「断言」：万一 pnpm prune --prod 把它裁掉了，
# 代码会退回内置品牌图，推送照常出草稿（只是封面用默认图），不能因此让构建失败。
RUN node -e "try{const s=require('sharp');console.log('sharp 可用，封面可按文章图生成:', s.versions.vips)}catch(e){console.log('[warn] sharp 不可用，封面将退回内置品牌图:', e.code||e.message)}"

EXPOSE 3000

CMD ["pnpm", "start"]
