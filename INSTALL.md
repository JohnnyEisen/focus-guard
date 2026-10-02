# FocusGuard 安装指南（v2.5.3）

前置要求：Node.js ≥ 18.17（引擎零依赖，仅用内置模块；与 `package.json` 的 `engines` 一致）。逐行验证：

```bat
node -v
```

**双平台说明**：本仓库同时支持两套宿主，清单各自独立，不要混用——

| 平台 | 插件结构 | 拦截语义 | 安装方式 |
|---|---|---|---|
| **ZCode** | `.zcode-plugin/plugin.json` + `hooks/hooks.json` | PreToolUse 退出码 2 / `decision:block` **硬拦截** | 插件市场（市场源刷新 + UI 更新） |
| **DSH**（Cordis 运行时） | 官方桥 `@deepseek-ai/dsh-hooks-claude-code` 挂载本仓库 `hooks/hooks.json`（Claude 方言） | **同等硬拦截**：exit 2 阻断工具/提示、`ask` 原生审批、stderr 原文透传给模型、Stop 打回强制续步 | profile 的 `cordis.patch.yml` 挂桥（见下文逐行步骤） |

版本必须全链一致（**五处清单 + 引擎号 + 引擎头注释**）：`package.json`、根 `marketplace.json`、`.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json` 的 `version`，与 `hooks/guard.mjs` 顶部的 `ENGINE_VERSION` 及首行注释版本号。不一致时 SessionStart 会注入"部署版本核验 deploy-mismatch"警告；本地验收有专门用例锁定该一致性（`node --test tests/acceptance.test.mjs`）。

## 一、ZCode 安装（逐行可复制）

```bat
:: 1) 取得源码（二选一）
git clone https://github.com/irisblackwood/focus-guard.git
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

验证生效：新会话开头出现 `<focus-guard AI履职执法模型v3.0：日常零打扰，只看行为>【触发】…` 的注入即为生效（该字符串是引擎 `SESSION_RULES` 的开头，逐字镜像见 `docs/RULES.md` 第四部分；早期文档此处曾写过引擎里并不存在的措辞，以本判据为准）；工作区出现 `.ai/CASE_FILE.md` 与 `.focus-guard/AUDIT.log` 即为卷宗与留痕就绪。

源码目录内跑质量闸（86 用例应全绿；仓库已带 CI，推送即自动跑）：

```bat
cd /d <仓库目录>
npm test         :: 验收 86 用例（等价于 node --test tests/acceptance.test.mjs）
npm run eval     :: 对抗评测：61 条高危写法 + 34 条良性命令，有漏检或误报即失败
npm run check    :: test + eval
```

## 二、DSH 安装（逐行可复制，v2.5.0 起为硬拦截）

机制：DSH 官方桥 `@deepseek-ai/dsh-hooks-claude-code`（`dsh` 应用自带，无需安装）直接运行本仓库的 Claude 方言 `hooks/hooks.json`——六条钩子在 DSH 上获得与 ZCode 同级的**硬拦截**：PreToolUse deny/ask、退出码 2 阻断、stderr 原文透传给模型、Stop 打回强制续步。

```text
1) 取得仓库到固定目录（示例 E:\focus-guard-main，git clone 或下载解压）
   git clone https://github.com/irisblackwood/focus-guard.git E:\focus-guard-main

2) 编辑 profile 补丁层（本机 desktop profile 示例）：
   %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
   在顶层数组末尾追加（路径按实际安装目录改，必须绝对路径）：

- name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: 'E:/focus-guard-main/hooks/hooks.json'
    pluginRoot: 'E:/focus-guard-main'

3) 重启 DSH 会话生效。
```

要点与已知差异（相对 ZCode，均来自官方桥文档，逐条核实过）：

1. **硬拦截语义完整**：PreToolUse `deny`/`ask` 均支持；阻断原因 stderr 原文透传给模型（高危审批单、污染告警、委派提醒模型全部可见）；`deny > ask > allow` 合并。
2. **卷宗落点自动正确**：桥为每个钩子进程设置 `CLAUDE_PROJECT_DIR` = 会话工作区，卷宗/AUDIT.log 直接落工作区，无需手工设环境变量。
3. **PostToolUseFailure 无对应事件**（桥不支持 23 个 Claude 事件之一）：失败不计入停滞检测，停滞仅由重复/无进展触发。
4. **Stop 载荷无收尾文本**（`last_assistant_message` 恒缺、`transcript_path` 恒空串）：引擎 2.5.0 起按此签名自适应，2.5.2 起放宽为"**无收尾文本且 `transcript_path` 缺失或为空串**"，锚点/审批单打回一律降级为仅审计（`dsh-stop-observe` 留痕），避免桥接强制续跑死循环。
5. **SessionStart 为 detached**：注入可能错过首个请求，从第二条消息起生效；批示关键词（50/15/10）随 UserPromptSubmit 正常工作。
6. **configPath 只在进程加载时解析一次**，相对路径从启动目录解析——务必用绝对路径；修改后需重启 DSH。
7. `--dry-run` 等特例语义与 ZCode 完全一致（同一引擎）。

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
- 原因：会话启动时 shell 检测误判。判定链（`quickShellId()`）：先看 `SHELL`（bash/zsh/sh 分别识别），再看 `PSModulePath` 是否含**带版本号的 pwsh7 路径**（`…\PowerShell\<版本>\…`）或 Store 包路径（`…\WindowsApps\microsoft.powershell…`），最后看 `ComSpec`。2.0.1 修掉"机器级 PSModulePath 恒存即判 PowerShell"，2.5.2 进一步收窄为只认带版本/包路径（此前只写 `C:\Program Files\PowerShell\Modules` 也会误判）。
- 修复：①重开会话——环境检测为会话级一次复用，仅 shell 变化时重检，新会话必然重检；②应急：删除 `%TEMP%\focus-guard-<会话ID>.json` 强制重检（会话 ID 经消毒，异常字符会带短哈希后缀）；③仍误判：在 `.ai/CASE_FILE.md` 留痕后报 issue，判定逻辑集中在引擎 `quickShellId()`，可按机器特征调整。
- 反向误判（真 PowerShell 会话没被管）：属"宁宽勿严"设计，不堵工作流优先；可用 `Select-String` / `Measure-Object` / `-TotalCount` 的平台友好写法。

### 4. 升级后版本没变（部署漂移：源码 2.5.2，运行副本仍是 2.4.0）

- 表现：`.focus-guard/AUDIT.log` 的 `rules-registered` 事件仍记 `引擎v2.4.0`；`%USERPROFILE%\.zcode\cli\plugins\installed_plugins.json` 中 `focus-guard` 的 `version` / `installPath` 仍指向旧版；新会话注入带【部署版本核验】警告。
- 原因：钩子运行的是**插件安装副本**（`...\.zcode\cli\plugins\cache\<市场名>\focus-guard\<版本>\`），改源码不会自动生效。
- 修复：ZCode → 设置 → 插件 → 插件市场 → 刷新 → 对 FocusGuard 执行更新（必要时先移除市场再重新添加）；确认缓存目录出现新版本号后重开会话。
- 自检：`node --test tests/acceptance.test.mjs` 全绿即源码五处清单与引擎号一致；注册表 ↔ 市场源 ↔ 运行引擎三方一致性由 SessionStart 持续核验（`deploy-mismatch` 事件）。

## 四、卸载

```text
ZCode：设置 → 插件 → FocusGuard 聚焦护栏 → 卸载
DSH：  从 %USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml 中删除 dsh-hooks-claude-code 条目并重启会话；
       若曾以 dsh plugin add 安装过旧版监察包，一并用 dsh plugin remove 卸载。
```

工作区清理（可选）：删除 `<工作区>/.ai/`、`<工作区>/.focus-guard/` 与 `%TEMP%\focus-guard-*.json`。
