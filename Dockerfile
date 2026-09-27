# syntax=docker/dockerfile:1

# ---- 依赖层 ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

# ---- 构建层 ----
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- 验收层（compose 的 verify 一次性服务使用）----
FROM node:20-alpine AS verify
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 一次性运行：类型检查 + Vitest 穷举/性能测试，结束即退出
CMD ["npm", "run", "verify"]

# ---- 页面托管层：纯静态文件，无在线服务调用 ----
FROM nginx:1.27-alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
