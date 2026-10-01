# FocusGuard 安装指南（v2.2.0 正面指引版）

前置要求：Node.js ≥ 18（引擎零依赖，仅用内置模块）。逐行验证：

```bat
node -v
```

**双平台说明**：本仓库同时支持两套宿主，清单各自独立，不要混用——

| 平台 | 插件结构 | 拦截语义 | 安装方式 |
|---|---|---|---|
| **ZCode** | `.zcode-plugin/plugin.json` + `hooks/hooks.json` | PreToolUse 退出码 2 / `decision:block` **硬拦截** | 插件市场（市场源刷新 + UI 更新） |
| **DSH**（Cordis 运行时，插件=npm 包） | `package.json` 的 `dsh.bundle` + `cordis.patch.yml`（另附 `.claude-plugin/` 兼容清单，命中 DSH 兼容层查找顺序第 2 位） | 钩子 fire-and-forget，无拦截语义 → **监察·留痕模式**（告警日志 + AUDIT.log 追责） | `dsh plugin add`（npm 包名或 `github:` 源） |

三处版本必须一致：`.zcode-plugin/plugin.json` ↔ 根 `marketplace.json` ↔ 引擎 `ENGINE_VERSION`（hooks/guard.mjs 顶部，`.claude-plugin/`、`package.json` 同步维护）。不一致时 SessionStart 会注入"部署版本核验 deploy-mismatch"警告。

## 一、ZCode 安装（逐行可复制）

```bat
:: 1) 取得源码（二选一）
git clone https://github.com/JohnnyEisen/focus-guard.git
:: 或：下载 zip 后解压，得到含 marketplace.json 的目录

:: 2) 验证市场清单位置（必须在仓库根目录，不是子目录）
cd /d <仓库目录>
dir /b marketplace.json
```

```text
3) ZCode → 设置 → 插件 → 插件市场 → 添加 → 选择上一步验证过的目录（含 marketplace.json 的文件夹）
4) 插件列表 → FocusGuard 聚焦护栏 → 安装
5) 新开一个会话
```

验证生效：新会话开头出现 `<focus-guard AI履职执法模型v3.0 强制生效：日常零打扰，只看行为>` 注入即为生效；工作区出现 `.ai/CASE_FILE.md` 与 `.focus-guard/AUDIT.log` 即为卷宗与留痕就绪。

源码目录内跑验收（43 用例应全绿）：

```bat
cd /d <仓库目录>
node --test tests/acceptance.test.mjs
```

## 二、DSH 安装（逐行可复制）

DSH 是基于 Cordis 框架的运行时，插件本质是一个 **npm 包**：`package.json` 内的 `dsh.bundle` 字段指向 `cordis.patch.yml`，安装后 DSH 自动把该补丁并入 profile 层栈，**无需手动编辑** `~/.dsh/profiles/web/cordis.patch.yml`。本仓库已带全套 DSH 结构（`package.json` + `cordis.patch.yml`，钩子映射写在补丁内）。

### 方式 A：dsh 命令安装

```bat
:: 1) 从 GitHub 安装（无需先发布 npm）
dsh plugin --profile web add github:JohnnyEisen/focus-guard

:: 1') profile 缺省时可省略（等价简式）
dsh plugin add github:JohnnyEisen/focus-guard

:: 2) 发布到 npm 后，直接按包名安装（示例形式，参照 dsh plugin add dsh-vps）
dsh plugin add focus-guard
```

### 方式 B：本机没有 dsh 时，用 npx

```bat
npx -y @deepseek-ai/dsh plugin --profile web add github:JohnnyEisen/focus-guard
```

> 已确认的安装源形式：npm 包名（如 `dsh plugin add dsh-vps`）与 `github:用户名/仓库名`。其余源形式（本地路径、file: 协议等）以 `dsh plugin --help` 输出为准，本文档不作臆断。

### 安装后的行为与已知边界（务必阅读）

1. **监察·留痕模式**：DSH 钩子是 fire-and-forget（事件→命令），没有退出码 2 / `decision:block` 拦截语义。guard.mjs 的六条钩子照常执行（stdin 收完整上下文 JSON），但"拦截"表现为 stderr 进告警日志（每流 64KiB）+ 全程记 AUDIT.log，事后追责；**硬拦截请在 ZCode 端使用**。
2. **卷宗落点**：引擎靠 `ZCODE_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` 环境变量定位工作区。DSH 端建议设系统环境变量 `CLAUDE_PROJECT_DIR=<你的工作区>`，卷宗 `.ai/CASE_FILE.md` 与 `.focus-guard/AUDIT.log` 才会落在工作区；未设置时落系统临时目录。
3. **会话隔离**：DSH 上下文 JSON 若含 `session_id` 字段则按会话隔离状态；否则聚合为 `default` 会话（状态文件 `%TEMP%\focus-guard-default.json`）。
4. **批示关键词**：DSH 的 user/message 载荷字段名若与 ZCode 不同，关键词预算（50/15/10）可能识别不到而落默认 10——可用回复中的【任务规模】声明上调（如"【任务规模】预计调用 30 次"），该通道只依赖文本，跨平台稳定。

## 三、FAQ

### 1. Marketplace manifest not found（ZCode）

- 原因：添加插件市场时选择的目录里没有 `marketplace.json`——选到了子目录（如 `skills/`、`.zcode-plugin/`），或 zip 未解压。
- 修复：在仓库根执行 `dir /b marketplace.json` 确认存在；重新"添加插件市场"时选择这个文件夹本身。升级后报同样的错：先移除旧市场再重新添加，或直接在插件面板更新。
- 仍失败：检查 `marketplace.json` 是否被编辑损坏（合法 JSON），用 `node -e "JSON.parse(require('fs').readFileSync('marketplace.json','utf8'));console.log('ok')"` 验证。

### 1'. DSH 报"插件清单找不到 / 清单未命中"

DSH 按固定顺序查找清单（找不到才轮到下一级）：

```text
marketplace 清单：.agents/plugins/ → .claude-plugin/ → .cursor-plugin/ → .github/plugin/ → 根目录
插件清单：        .codex-plugin/ → .claude-plugin/ → 根目录
```

- ZCode 的 `.zcode-plugin/` 格式 **DSH 不认**，属正常；本仓库的 `.claude-plugin/plugin.json` 命中 DSH 插件清单查找第 2 位（兼容层加载），根 `marketplace.json` 命中 marketplace 第 5 位。
- 仍找不到：确认安装源指向仓库根目录（含 `package.json` 的那层），而不是 `hooks/`、`skills/` 等子目录。

### 2. L3 熔断解除

- 表现：AI 输出『【熔断】无法通过现有资料定位核心问题』；改动类工具全部被拒，只读调查放行。
- 解除（人类批示即解除，全部清零）：直接下达新任务即可；或短指令回复 `继续` / `放行` / `延长`（信用延期：停滞清零 + 预算 +10）。
- 确需放开证据要求（绝境模式）：≤30 字明示短指令——`启动绝境模式` / `允许基于有限信息猜测` / 【特赦】。豁免锚点检查，资源纪律（体积闸/预算上限）仍生效。
- 应急硬重置：关闭会话，删除状态文件 `%TEMP%\focus-guard-<会话ID>.json`（会话 ID 见 `.focus-guard/AUDIT.log` 的 `session` 字段），重开会话。

### 3. 环境误判修复

- 现象：Windows Git Bash 里 `grep ... | head -5` 被拦，提示"PowerShell 禁 bash 管道"等平台规则错误。
- 原因：会话启动时 shell 检测误判（v2.0.1 已修：PSModulePath 机器级恒存不再判为 PowerShell，仅认 pwsh7 特征路径）。
- 修复：①重开会话——环境检测为会话级一次复用，仅 shell 变化时重检，新会话必然重检；②应急：删除 `%TEMP%\focus-guard-<会话ID>.json` 强制重检；③仍误判：在 `.ai/CASE_FILE.md` 留痕后报 issue，判定逻辑集中在引擎 `quickShellId()`，可按机器特征调整。
- 反向误判（真 PowerShell 会话没被管）：属"宁宽勿严"设计，不堵工作流优先；可用 `Select-String` / `Measure-Object` / `-TotalCount` 的平台友好写法。

## 四、卸载

```text
ZCode：设置 → 插件 → FocusGuard 聚焦护栏 → 卸载
DSH：  移除方式以 dsh plugin --help 为准（本文档仅确认了 add 子命令）；
       也可手动从 ~/.dsh/profiles/web/cordis.patch.yml 层栈中移除 focus-guard 条目。
```

工作区清理（可选）：删除 `<工作区>/.ai/`、`<工作区>/.focus-guard/` 与 `%TEMP%\focus-guard-*.json`。
