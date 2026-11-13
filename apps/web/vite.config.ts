import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/** 仓库根目录：.env 与 pnpm workspace 都在这一层 */
const repoRoot = "../..";
const defaultProxyTarget = "http://localhost:5180";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const proxyTarget = env.API_PROXY_TARGET || defaultProxyTarget;

  return {
    envDir: repoRoot,
    plugins: [react()],
    server: {
      port: 5174,
      strictPort: true,
      proxy: {
        "/api": { target: proxyTarget, changeOrigin: true },
        // 知识库 OAuth 的 /oauth/* 端点在网关根路径上，开发环境必须一起代理
        "/oauth": { target: proxyTarget, changeOrigin: true },
        // WebDAV 挂载端点：桌面/手机客户端直接连 /dav，开发环境同样走代理
        "/dav": { target: proxyTarget, changeOrigin: true },
      },
    },
    build: {
      outDir: "dist",
    },
  };
});
