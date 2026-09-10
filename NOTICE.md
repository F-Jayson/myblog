# Open Source Notices

本项目的页面视觉、部分文字结构和静态图片资源参考并复用了工作区内的
`Firefly-master` 项目。该项目使用 MIT License，版权归 saicaca（2024）和
CuteLeaf（2025）所有，完整许可文本见 `Firefly-master/LICENSE`。

本项目直接使用的主要开源组件如下。各组件的完整许可文本和版权声明以其
发布包或源代码仓库中的 LICENSE 文件为准。

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| React / React DOM | 前端界面 | MIT |
| React Router | 前端路由 | MIT |
| Vue | `md-editor-v3` 运行时桥接 | MIT |
| md-editor-v3 | Markdown 文章编辑器 | MIT |
| Lucide React | 界面图标 | ISC |
| Marked | Markdown 渲染 | MIT |
| DOMPurify | HTML 内容净化 | MPL-2.0 OR Apache-2.0 |
| Express / CORS | HTTP API 服务 | MIT |
| mysql2 | MySQL 客户端与连接池 | MIT |
| Zod | API 输入校验 | MIT |
| dotenv | 环境变量加载 | BSD-2-Clause |
| Vite / @vitejs/plugin-react | 前端构建工具 | MIT |
| TypeScript | 类型检查与编译 | Apache-2.0 |
| tsx | TypeScript 开发运行器 | MIT |

间接依赖的许可信息可在安装依赖后通过 `pnpm licenses list` 查看。
