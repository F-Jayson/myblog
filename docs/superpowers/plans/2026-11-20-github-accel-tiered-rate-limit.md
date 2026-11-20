# GitHub 加速下载分档限速 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 GitHub 加速节点按用户身份限速——游客 10 MiB/s、登录用户 100 MiB/s，并让主站与前台显示当前档位。

**Architecture:** 档位（guest/member）写入签名 ticket 的 `t` 字段，节点侧在四个出流点插入令牌桶 Transform 流，按 ticket 档位选择速率；游客的每 IP 并发收窄到 1，避免多开连接绕过单连接限速。主站只负责按登录态签发带档位的 ticket，不感知具体速率。

**Tech Stack:** TypeScript（Node 22 ESM）、node:test、Vite/React、pnpm workspace、Transform 流（node:stream）。

**Spec:** `docs/superpowers/specs/2026-11-20-github-accel-tiered-rate-limit-design.md`

## Global Constraints

- ticket 载荷 JSON 字段顺序固定为 `u,e,k,t`，不得由对象字面量顺序以外的任何地方决定。
- 旧 ticket（无 `t`）必须继续可用并判为 `guest`；非法 `t` 同样判 `guest`，不得报错。
- 速率 0 表示不限速，必须与"未配置"区分开：配置默认值分别是 10485760 / 104857600。
- 主站不新增环境变量；节点新增变量名固定为 `ACCEL_GUEST_BYTES_PER_SECOND`、`ACCEL_MEMBER_BYTES_PER_SECOND`、`ACCEL_GUEST_CONCURRENCY_PER_IP`。
- 单测一律 `node:test`（`import { describe, it } from "node:test"` 或 `import test from "node:test"`），包内 import 带 `.ts` 后缀。
- 中文注释与中文 error/日志文案，与现有代码风格一致。
- 不得改动既有的 95 个节点用例与 32 个主站 github 用例的语义（只允许新增与必要的常量替换）。

## Review Focus

- 限速只加在响应流而漏掉缓存分支：客户端在缓存命中时速度应同样受限（同一 ticket 两次请求速率一致）。
- `destroy()`/客户端中断后定时器残留：反复中断后进程不应挂起或内存增长。
- `Range` 续传与 206 响应在限速下的行为：断点续传仍应正常工作且仍受限。
- 上游断连发生在限速等待期间：不能把半截字节当完整文件落盘。
- 登录用户与游客共用同一 IP 时的并发计数：游客收窄不得影响登录用户的并发额度。

---

### Task 1: 加速节点分档限速

**Files:**
- Create: `packages/github-accel/src/throttle.ts`
- Create: `packages/github-accel/test/throttle.test.ts`
- Modify: `packages/github-accel/src/config.ts`、`packages/github-accel/src/ratelimit.ts`、`packages/github-accel/src/ticket.ts`、`packages/github-accel/src/server.ts`
- Test: `packages/github-accel/test/config.test.ts`、`ratelimit.test.ts`、`ticket.test.ts`、`server.test.ts`

**Interfaces:**
- Produces: `createThrottleStream(options: ThrottleOptions): Transform`；`pipeToClient(source: Readable, dest: Writable, bytesPerSecond: number, now?: () => number): void`；`ThrottleOptions { bytesPerSecond: number; burstSeconds?: number; now?: () => number }`
- Produces: `AccelConfig` 新增 `guestBytesPerSecond`、`memberBytesPerSecond`、`guestConcurrencyPerIp`（number）
- Produces: `AccessGuard.acquire(ip: string, now?: number, options?: { concurrencyPerIp?: number })`
- Produces: `ticket.ts` 的 `TicketTier = "guest" | "member"`、`TicketPayload { u: string; e: number; k: "file" | "git"; t?: TicketTier }`；`verifyTicket` 返回的 `payload.t` 已归一化为 `"guest" | "member"`

- [ ] 步骤见任务清单（throttle 单测 → 配置 → 并发 → ticket 向量 → 四个注入点 → health/响应头 → commit）
- [ ] 完成判据：`pnpm --filter @jayson-blog/github-accel type-check && pnpm --filter @jayson-blog/github-accel test` 全绿

### Task 2: 主站签发带档位的 ticket

**Files:**
- Modify: `apps/api/src/githubAccel.ts`、`apps/api/src/server.ts`
- Test: `apps/api/test/github-accel.test.ts`

**Interfaces:**
- Consumes: `TicketTier` 语义同 Task 1（两处实现必须向量一致）
- Produces: `buildDownloadTicket(resolved, config, now?, tier?)`、`buildCloneInfo(resolved, config, tier?)` 的 tier 缺省为 `"guest"`；`createTicket(payload, secret)` 写 `t`；`verifyTicket` 返回归一化 `t`
- Produces: `GET /api/tools/github/config` 响应新增 `rates: { guest: number; member: number }`（节点未升级时字段缺省）

- [ ] 步骤：新向量断言 → `t` 进 payload → 路由 tier 判定（`loadCommentUser`）→ config 带 rates → commit
- [ ] 完成判据：`cd apps/api && node --test --import tsx test/github-accel.test.ts` 全绿

### Task 3: 前台显示当前档位

**Files:**
- Modify: `apps/web/src/githubAccel.ts`、`apps/web/src/GithubAccelPage.tsx`、`apps/web/src/styles.css`
- Test: 无自动化（以浏览器实测为准）

**Interfaces:**
- Consumes: `GithubAccelConfig` 新增可选 `rates?: { guest: number; member: number }`
- Produces: `formatBytesPerSecond(bytes: number): string`（10485760 → "10 MiB/s"）

- [ ] 步骤：类型 + 格式化函数 → 状态条下"当前身份"行 → 使用限制文案 → 浏览器实测 → commit
- [ ] 完成判据：`pnpm --filter @jayson-blog/web type-check` 通过，且 /tools/github 页面在游客与登录两种状态下文案正确

### Task 4: 文档与部署说明

**Files:**
- Modify: `docs/github-accelerator.md`、`packages/github-accel/README.md`（若有对应段落）
- Create: `docs/github-accelerator-deploy.md`

- [ ] 步骤：协议文档补 `t` 字段与新向量 → 节点 README 补三个变量 → 写独立部署说明（节点部署、环境变量、nginx/系统调优、限速验证方法、常见问题）→ commit
