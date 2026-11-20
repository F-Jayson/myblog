# 多阶段构建：构建阶段装 devDependencies 只是为了 tsc，运行阶段只带 dist，镜像里没有依赖树。
FROM node:22-alpine AS build
WORKDIR /app
# 先只拷 package.json，依赖层可被缓存；改代码不会触发重装。
COPY package.json ./
RUN npm install --no-audit --no-fund --loglevel=error
COPY tsconfig.json ./
COPY src ./src
RUN ./node_modules/.bin/tsc -p tsconfig.json

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
	ACCEL_HOST=0.0.0.0 \
	ACCEL_PORT=8787 \
	ACCEL_CACHE_DIR=/data/cache
WORKDIR /app
# 缓存目录必须属于运行用户：否则 node 用户写不了 .part，命中率永远是 0。
RUN mkdir -p /data/cache && chown -R node:node /data
COPY --from=build /app/dist ./dist
COPY package.json ./
# 非 root 运行：这个服务会把公网流量转成对 GitHub 的请求，逃逸面越小越好。
USER node
EXPOSE 8787
VOLUME ["/data/cache"]
# 健康检查直接打本机 /api/health：主站也是靠这个接口判断节点是否可达。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:' + (process.env.ACCEL_PORT || '8787') + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]
