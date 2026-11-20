# GitHub 加速节点：游客 / 登录用户分档限速（设计）

日期：2026-11-20
状态：已获批（用户在对话中选择"方案 A：限速"，并采纳"单连接令牌桶 + 档位写入 ticket + 游客并发收窄"）

## 1. 意图与为什么

加速节点部署在带宽充足的独立服务器上，入口留在主站 `/tools/github`。功能上线后所有访客（含未登录游客）都能白吃节点带宽，而"登录后更快"正是站点把游客转成注册用户最自然的卖点。

需求原文（m00856）："限制游客使用的速率，比如限制游客带宽为10MB，注册登录用户可以享受100MB"。用户确认（m00901）这里的 MB 指**每秒速率**，不是流量额度。

目标：
- 游客每连接上限 10 MiB/s，已登录用户每连接上限 100 MiB/s，两者都可通过环境变量改。
- 登录用户必须能**明显**感到更快，而游客不能靠"多开几个连接"把总量刷回来。

非目标：
- 不做流量额度（累计字节数上限）、不做按账号计费的会员体系。
- 不做节点侧的用户数据库：节点永远不接触用户身份，只信主站签名。

反目标（技术上跑通但算失败）：
- 节点为了区分身份去查数据库或调主站接口 —— 那会让节点变成主站的从属服务，失去"独立服务器、独立扩容"的部署价值。
- 限速实现让缓存落盘变慢或让大文件下载被 Node 空闲超时掐断。

## 2. 约束

- **字节只经过节点**：主站 302 之后就退出链路，任何限速只能做在节点。
- **两端 ticket 算法必须逐字节一致**：`apps/api/src/githubAccel.ts` 与 `packages/github-accel/src/ticket.ts` 各有一份实现，且两端启动时都用 `assertTicketAlgorithm()` 校验文档里的固定测试向量（改结构不同步 = 启动即崩）。
- **滚动发布期间存在旧 ticket**：主站与节点分别部署，不可能同时上线。因此 `t` 字段必须**可缺省**，缺省按游客处理。
- 主站前端所有 API 请求已自带 `Authorization: Bearer`（`apps/web/src/api.ts:76-77`），主站也有可选登录中间件 `loadCommentUser`（`apps/api/src/server.ts:474`），身份不需要新做。

## 3. 方案对比（对话中已选定）

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| A 单连接令牌桶 | ticket 带档位，节点按档位给每条连接一个令牌桶；游客每 IP 并发收窄到 1 | **采用**。二十行可测代码即可满足"登录明显更快"，且不需要跨连接共享状态 |
| B 每 IP 聚合令牌桶 | 多连接共享一个桶 | 放弃：收益只在"用户多开连接"一个场景，而该场景已被 A 的并发收窄压住，代价是节点侧要维护可回收的共享状态 |
| C nginx `limit_rate` / tc | 不改代码，只改部署 | 放弃：只能按连接限速，无法区分游客与登录用户；拆 location 反而比写代码更绕 |

## 4. 设计

### 4.1 ticket 增加档位字段 `t`

```text
JSON = { "u": string, "e": number, "k": "file" | "git", "t"?: "guest" | "member" }
```

- 字段顺序固定 `u, e, k, t`（JSON.stringify 按插入顺序，顺序变了签名就变）。
- `createTicket` 一律写 `t`，未指定时写 `"guest"`。
- `verifyTicket` 里 `t` **可缺省**：缺省或非法值一律归为 `"guest"`。缺省不报错，是为了让旧 ticket 在滚动发布窗口里继续可用。
- 新增固定测试向量（两端单测 + 文档同步）：
  - file/guest `…"t":"guest"}` → `c1f6b1ac1ab2aaac6e0a3c8e5d19f943`
  - file/member → `7ef37acc7057c396f905918b914e77cb`
  - git/guest → `954481962b3921ce992e13fcb4343fe7`
  - git/member → `9644aedea787e8ec02ba5bf8a337daff`
  - 旧的无 `t` 向量 `1fdb9326cecbc1dae9177cd18b229837` 保留，作为"向后兼容"的断言。

安全边界：档位在签名之内，游客无法篡改；但**签名短链可被转发**，别人拿到登录用户签发的链接也能按 member 速率下载，直到过期（默认 30 分钟）。这可接受——它不是权限，只是速度档位，且链接有时效。文档要写明这一点。

### 4.2 节点侧限速：单连接令牌桶

新文件 `packages/github-accel/src/throttle.ts`：

```ts
export interface ThrottleOptions { bytesPerSecond: number; burstSeconds?: number; now?: () => number }
export function createThrottleStream(options: ThrottleOptions): Transform
export function pipeToClient(source, res, bytesPerSecond, now?): void
```

- 令牌桶容量 = `max(bytesPerSecond × 0.1, 64 KiB)`。10 MiB/s 时约 1 MB 突发，100 MiB/s 时约 10 MB——前者让首包立刻出站，后者避免 16 KB 一块在 1 ms 定时器精度上退化（100 MiB/s 下 16 KB 只需 0.16 ms，逐块 sleep 会被定时器粒度拖到跑不满标称速率）。
- `bytesPerSecond <= 0` 表示不限速，直接裸 pipe。
- `destroy` 时清掉待触发的定时器，否则中断的下载会留下一个把事件循环钉住的 timer。
- 等待期间 `_transform` 不回调 → pipe 的背压自动作用到上游 socket，内存不会堆积；GitHub 侧 TCP 窗口填满后自然会降速。

注入点共 4 处（漏一处就等于没限速）：
1. `serveFromCache` 的 `openReadStream().pipe(res)`（缓存命中，最容易被漏）
2. `serveFromUpstream` 不可缓存分支的 `upstream.pipe(res)`
3. `streamWithCache` 的 `pipeline(upstream, tee, res)` → 变成 `pipeline(upstream, tee, throttle, res)`，节流放在 tee **之后**：缓存文件仍按上游速度落盘，只有发往客户端的字节被拖慢
4. `handleGit` 的 `upstream.pipe(res)`

### 4.3 档位如何到达节点

- `/download/<ticket>`、`/git/<ticket>/...`：ticket 里的 `t`。
- `/download?url=`、无 ticket 的 `/git/...`（`ACCEL_ALLOW_PUBLIC=true` 时的公开路径）：一律 `guest`。
- 响应头带 `x-accel-tier: guest|member` 与 `x-accel-rate: <bytes/s>`，便于运维现场确认；`/api/health` 增加 `guestBytesPerSecond` / `memberBytesPerSecond` 两个字段供主站展示。

### 4.4 并发额度也分档

`AccessGuard.acquire(ip, now, options?: { concurrencyPerIp?: number })`：新增可选第三参数，缺省仍用构造时的 `concurrencyPerIp`，**既有调用与单测不受影响**。

- 游客每 IP 并发默认 1（`ACCEL_GUEST_CONCURRENCY_PER_IP`），登录用户沿用现有 `ACCEL_CONCURRENCY_PER_IP`（默认 3）。
- 因此"游客开多连接"最多 1 × 10 MiB/s，登录用户最多 3 × 100 MiB/s。

### 4.5 配置（节点）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ACCEL_GUEST_BYTES_PER_SECOND` | 10485760（10 MiB/s） | 0 = 不限速 |
| `ACCEL_MEMBER_BYTES_PER_SECOND` | 104857600（100 MiB/s） | 0 = 不限速 |
| `ACCEL_GUEST_CONCURRENCY_PER_IP` | 1 | 游客每 IP 并发 |

主站不需要新增变量——档位由登录态决定，速率由节点决定。

### 4.6 主站

- `apps/api/src/githubAccel.ts`：`TicketPayload` 加 `t`；`createTicket` 写 `t`；`verifyTicket` 容错；`buildDownloadTicket` / `buildCloneInfo` 接 `tier` 参数；`assertTicketAlgorithm` 换成新向量组（保留旧向量做兼容断言）。
- `apps/api/src/server.ts`：github 相关路由挂 `loadCommentUser`，按 `req.commentUser` 是否存在决定 `tier`。`/api/tools/github/config` 增加 `rates: { guest, member }`（从节点 `/api/health` 读，节点未升级时缺省）。

### 4.7 前台

`/tools/github` 页面顶部状态条下加一行"当前身份"：未登录显示"游客 · 10 MiB/s，登录后 100 MiB/s"并给登录入口；已登录显示"已登录 · 100 MiB/s"。"使用限制"列表补充档位说明。

## 5. 影响与风险

- **传输时间变长**：200 MB 的游客要 20 秒、1 GB 要 100 秒，上游连接保持更久，GitHub 侧中途断连的概率上升。现有缓存只在"完整收到且长度吻合"时 rename，断连不会留下脏条目，客户端可 Range 续传。
- **滚动发布**：先发节点（能验旧 ticket，缺省 guest）再发主站（开始写 `t`）是安全的；反过来会让节点收到含 `t` 的 ticket —— 因为签名是对收到的 payload 字符串直接重算，不是重新拼 JSON，所以旧节点同样能验签，只是忽略 `t` 并按游客限速。
- 迁移期所有已签发请求最多 30 分钟后自然过期。

## 6. 验收标准

1. `pnpm -r type-check`、`pnpm -r build` 通过；`pnpm test:github`（节点 + 主站）全绿。
2. 节点单测覆盖：令牌桶速率误差 ≤ 5%、`0` 不限速、中断不留定时器、`x-accel-tier` 头、游客/登录两档下载实测速率比 ≈ 10:1（用本地假上游，不依赖 GitHub）。
3. 主站单测覆盖：tier 进入 ticket、旧 ticket 缺 `t` 判为 guest、非法 `t` 判为 guest、四个新固定向量。
4. 真机联调：本机起节点（guest 1 MiB/s 便于观察）+ 主站，游客下载 2 MB 文件耗时 ≈ 2 秒以上，登录后同样文件明显更快。
