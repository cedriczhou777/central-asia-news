/**
 * 运行时端口解析 —— 全项目唯一的端口口径。
 *
 * 背景：改之前端口有三套说法（container.config.json 声明 3000、
 * start.sh 与 pipeline 路由写死 5000），一旦哪边对不上就是静默失败。
 *
 * 优先级（前者优先）：
 *   1. DEPLOY_RUN_PORT —— 部署平台注入的运行端口
 *   2. PORT            —— 通用约定，微信云托管等平台会注入
 *   3. 3000            —— 兜底值，与 container.config.json 的 container.port 及 Dockerfile 的 EXPOSE 保持一致
 *
 * 注意：scripts/start.sh 在拉起 node 之前会把解析结果写回 PORT 环境变量，
 * 所以生产环境里 process.env.PORT 已经是最终值，这里的兜底只会影响本地直跑。
 */
export const DEFAULT_PORT = '3000';

export function resolvePort(): string {
  return (
    process.env.DEPLOY_RUN_PORT?.trim() ||
    process.env.PORT?.trim() ||
    DEFAULT_PORT
  );
}

/** 服务自身的访问地址，供内部接口互调使用。 */
export function resolveSelfBaseUrl(): string {
  return `http://localhost:${resolvePort()}`;
}
