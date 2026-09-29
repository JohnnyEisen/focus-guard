#!/usr/bin/env node
// focus-guard 护栏脚本 v1.1.1 — 《AI 履职执法模型 v3.0》+ 动态预算与进度检测系统
// v1.1.0 新增编译：双预算池(20条)/mtime缓存闸(49条)/上下文污染检测(58条)/残留核验(43条)/异地交叉巡视(36条)/部署版本核验(42条)/子代理状态留痕(48条)/追加批示(24条三)
// v1.1.1 修法合规：SESSION_RULES 常驻注入压缩至 ≤500 字（编译指令第2条），细节回归钩子报文+focus-thinking 技能+docs/RULES.md
// 一、空气层：不查词、不打扰（违禁词扫描已废除）
// 二、触发层：行为违规即罚，梯度处罚 L1-L6；触发④已升级为动态预算+进度检测
// 三、抽查层：盲写检测 / 风险文件 100% 留痕 / 每 5 次写操作随机全量审计
// 四、留痕层：触发/处罚/抽查/特赦/预算伸缩/回合诊断 → <工作区>/.focus-guard/AUDIT.log (JSONL)
// 关键设计：触发①②使用 turnCount（每回合由 Stop 事件清零）——实测 UserPromptSubmit reset
// 不保证每次触发（AUDIT.log: 计数跨回合累计致任务中途撞 10 次硬熔断），故不再依赖 reset 做回合边界。
// 模式:
//   start    (SessionStart)        重置状态并注入执法模型
//   reset    (UserPromptSubmit)    批示：关键词预算/信用延期批复/特赦识别；留痕 reset-fired（可能不触发，仅尽力）
//   pre      (PreToolUse)          双规白名单(含只读放行) + 降权/强制取证 + 触发①③检查 + Agent 留痕
//   post     (PostToolUse)         进度检测引擎(有效/无效、续杯、停滞熔断) + 巡检 + 抽查A
//   postfail (PostToolUseFailure)  失败=无进展，计入停滞
//   stop     (Stop)                回合边界：清 turnCount + 任务规模/信用延期/授权识别核验 + 触发②⑤
import { readFileSync, writeFileSync, rmSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const OUTPUT_GATE_BYTES = 50 * 1024; // 触发③：体积闸值
const RANDOM_AUDIT_EVERY = 5; // 抽查A：每 N 次写操作全量审计 1 次
const BUDGET_DEFAULT = 10; // 默认任务预算
const BUDGET_CAP = 200; // 硬上限：达到强制熔断
const REFILL = 10; // 自动续杯步长
const STALL_FUSE = 3; // 连续无效调用 → L3 熔断
const MERCY_SHORT = 30; // 特赦短语仅认短指令(trim 后 ≤30 字符)，防协议文本误触
const ENGINE_VERSION = "1.1.1"; // 42条：部署版本核验基准
const INV_POOL_DEFAULT = 15; // 20条：侦查池独立额度（批示可追加）
const FUSE_PHRASE = "【熔断】无法通过现有资料定位核心问题";
const MERCY_RE = /允许基于有限信息(进行)?猜测|(开启|启动|进入|批准|授予)绝境模式|【特赦】|(^|[\s，。！？,!?])特赦(?=$|[\s，。！？,!?])/;
const CREDIT_RE = /继续|放行|延长/; // 信用延期批复（短指令）
const STOP_ORDER_RE = /熔断|停止|^停$/; // 停止批复（短指令）
const TASK_SCALE_RE = /【任务规模】[^0-9]{0,8}(\d{1,3})/;
const KEY50_RE = /审计|红队|重构|全量|批量|探索|遍历|升级|补丁/;
const KEY15_RE = /修复|添加|修改|重命名|删除/;
// 《授权识别与留痕条例》声明核验
const PARDON_DECL_RE = /【授权识别】/;
const PARDON_PENDING_RE = /【授权待确认】/;
const PARDON_QUOTE_RE = /【授权识别】[\s\S]{0,60}?「([^「」\n]{2,120})」/;
const PARDON_BASIS_RE = /依据[:：]\s*【?([^】\n，。；]{2,50})/;
const AUTH_SEMANTICS_RE = /授权|特赦|赦免|批准|允许|豁免|跳过|绕过|无需|不用|猜测/;
const DOWNGRADE_MARKERS = /最小复现|复现请求|排查实验|联网证据|外部搜寻|卡点记录|HANDOFF\.md|交接报告/i;
const EVIDENCE_ANCHORS = /:\d+|日志原文|报错|HANDOFF\.md|交接报告|【假设】|【熔断】/;
const RISKY_FILE_RE = /(^|\/)(package(-lock)?\.json|[^\/]*\.lock|tsconfig\.json|AGENTS\.md|CLAUDE\.md|Dockerfile|[^\/]*\.env[^\/]*|zcode\.json)$|\.github\/|\.zcode-plugin\//i;
const MUTATING_BASH_RE = /(^|[;&|]\s*)(rm|rmdir|mv|del|rd|git\s+(add|commit|push|pull|merge|rebase|reset|checkout|clean|restore)|npm\s+(install|uninstall|ci)|pip3?\s+(install|uninstall)|yarn\s+(add|remove|install)|pnpm\s+(add|remove|install)|chmod|chown|kill|taskkill|truncate|dd|mkfs|mkdir|touch|Set-Content|Add-Content|Remove-Item|New-Item|Copy-Item|Move-Item)\b/i;
const FILE_REDIRECT_RE = /(^|\s)>{1,2}(?!\s*&)/;

const DOWNGRADE_MSG =
  "[触发⑤·熔断]改动类工具调用已拒绝（只读调查类仍放行）。按优先级给降级方案：" +
  "1.【最小复现】1-3 个最小复现步骤，或按可能性排序的 2-3 个排查实验，交人类执行；" +
  "2.【联网证据】WebSearch/WebFetch 查报错原文/官方文档，只输出原文链接和关键信息，不给修改建议；" +
  "3.【卡点记录】卡点/已查文件/报错详情/已试方案写入 HANDOFF.md，等待一把手批示。" +
  "未经批示严禁盲猜硬凑改代码。禁止静默，禁止直接结束对话。";

const SESSION_RULES =
  "<focus-guard AI履职执法模型v3.0 强制生效：日常零打扰，只看行为> " +
  "【触发五条】①未取证就改文件/变更Bash ②≥5次收尾无锚点([文件:行号]/日志)且无【假设】 ③整读>50KB/Grep无head_limit/裸cat ④超预算 ⑤查无实据硬凑。" +
  "【预算】批示关键词定额度(50/15/10)，可【任务规模】上调；侦查/执行分池，侦查池15次；执行池满+10，上限200；同mtime重复整读被拒。" +
  "【进度】3次无效→熔断；停滞2次→【信用延期】请批示(继续/放行/延长→+10)。" +
  "【处罚】L1打回→L2取证→L3熔断(只读放行)→L4记档→L5降权→L6上报；人类指令=批示解除。" +
  "【熔断出口】输出『" + FUSE_PHRASE + "』+降级方案(1最小复现 2联网证据 3HANDOFF.md)。" +
  "【特赦】仅认人类短指令明示授权(启动绝境模式/允许基于有限信息猜测/【特赦】)；声称受权须先出【授权识别】(引批示原文+法条)，否则越权。" +
  "【留痕】全程记<工作区>/.focus-guard/AUDIT.log。条文见focus-thinking技能与docs/RULES.md。";

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function sessionId(input) {
  const id =
    input.session_id ||
    process.env.CLAUDE_SESSION_ID ||
    process.env.ZCODE_SESSION_ID ||
    "default";
  return String(id).replace(/[^A-Za-z0-9._-]/g, "_");
}

function statePath(id) {
  return join(tmpdir(), `focus-guard-${id}.json`);
}

let auditFile = null;
function auditTarget(sid) {
  if (auditFile !== null) return auditFile;
  const dir = process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || "";
  if (dir) {
    try {
      if (statSync(dir).isDirectory()) auditFile = join(dir, ".focus-guard", "AUDIT.log");
    } catch {}
  }
  if (!auditFile) auditFile = join(tmpdir(), `focus-guard-${sid}-AUDIT.log`);
  return auditFile;
}

function audit(sid, trigger, opts = {}) {
  try {
    const p = auditTarget(sid);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(
      p,
      JSON.stringify({
        ts: new Date().toISOString(),
        session: sid,
        action: opts.action || trigger,
        trigger: opts.trigger ?? trigger,
        level: opts.level ?? null,
        evidence: String(opts.evidence || "").slice(0, 200),
        pardon: !!opts.pardon,
      }) + "\n"
    );
  } catch {}
}

function loadState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {
      turnCount: 0,
      seen: {},
      fused: false,
      stopBlocked: false,
      dumpCount: 0,
      mercy: false,
      violations: 0,
      forcedInvestigate: false,
      probation: false,
      writeOps: 0,
      readSet: {},
      turnPrompt: "",
      taskBudget: BUDGET_DEFAULT,
      keywordBudget: BUDGET_DEFAULT,
      declaredBudget: 0,
      effectiveCalls: 0,
      stalledStreak: 0,
      lastSig: "",
      lastInput: "",
      totalCalls: 0,
      invCalls: 0,
      invCap: INV_POOL_DEFAULT,
      invWarned: false,
      mtimeSet: {},
    };
  }
}

function saveState(path, state) {
  writeFileSync(path, JSON.stringify(state));
}

function normalize(p) {
  return String(p || "").replace(/\\/g, "/");
}

function isMutating(tool, ti, handoff) {
  if (tool === "Write" || tool === "Edit") return !handoff;
  if (tool === "Bash") {
    const cmd = String(ti.command || "");
    return MUTATING_BASH_RE.test(cmd) || FILE_REDIRECT_RE.test(cmd);
  }
  return false;
}

function isInvestigation(tool, ti) {
  if (["Read", "Grep", "Glob", "WebSearch", "WebFetch"].includes(tool)) return true;
  if (/mcp__.*(web|search)/i.test(tool)) return true;
  if (tool === "Bash") {
    const cmd = String(ti.command || "");
    return !MUTATING_BASH_RE.test(cmd) && !FILE_REDIRECT_RE.test(cmd);
  }
  return false;
}

function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().map((k) => k + ":" + stable(v[k])).join(",") + "}";
  return JSON.stringify(v) ?? String(v);
}

function callHash(input) {
  const sig = (input.tool_name || "?") + "|" + stable(input.tool_input ?? {});
  return sig.slice(0, 500);
}

function collectStrings(v, out, budget) {
  if (typeof v === "string") {
    if (out.total < budget) {
      out.parts.push(v);
      out.total += v.length;
    }
  } else if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out, budget);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) collectStrings(x, out, budget);
  }
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

function penalize(state, sid, trigger, evidence) {
  state.violations = (state.violations || 0) + 1;
  const level = Math.min(state.violations, 6);
  if (level >= 2) state.forcedInvestigate = true;
  if (level >= 3) state.fused = true;
  if (level >= 5) state.probation = true;
  audit(sid, trigger, { level, evidence });
  return level;
}

function ladderNote(level) {
  if (level >= 6) return "已升级 L6 并上报人类，等待批示。";
  if (level >= 5) return "已升级 L5 降权：只读模式，改动类操作全部拒绝，直至批示。";
  if (level >= 4) return "已升级 L4：本次违规记档 AUDIT.log。";
  if (level >= 3) return "已升级 L3 熔断：等待批示或给出降级方案。";
  if (level >= 2) return "已升级 L2 强制取证：下一次调用必须是取证类（Read/Grep/搜索/只读命令）。";
  return "";
}

const mode = process.argv[2] || "";
const input = readStdinJson();
const sid = sessionId(input);
const path = statePath(sid);

if (mode === "start") {
  rmSync(path, { force: true });
  let ctx = SESSION_RULES;
  const projDir = process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || "";
  if (projDir) {
    // 36条 异地交叉巡视：新会话接手 → 复核前任结论
    try {
      readFileSync(join(projDir, "HANDOFF.md"), "utf8");
      ctx += "\n【异地交叉巡视·36条】检测到 HANDOFF.md：本会话接手前任任务，先读 HANDOFF.md 复核前任结论；未证实内容一律标【假设】。";
      audit(sid, "handover-inspect", { level: null, evidence: "36条 交叉巡视：发现 HANDOFF.md" });
    } catch {}
    // 42条 部署版本核验：运行引擎 vs 工作区源码
    for (const rel of ["focus-guard/hooks/guard.mjs", "plugins/focus-guard/hooks/guard.mjs"]) {
      try {
        const m = readFileSync(join(projDir, rel), "utf8").slice(0, 400).match(/v(\d+\.\d+\.\d+)/);
        if (m && m[1] !== ENGINE_VERSION) {
          ctx += `\n【部署版本核验·42条】运行引擎 v${ENGINE_VERSION} ≠ 工作区源码 v${m[1]}（${rel}），疑似升级后未同步部署，请核验一致性。`;
          audit(sid, "version-check", { level: null, evidence: `42条 引擎 v${ENGINE_VERSION} vs 源码 v${m[1]} (${rel})` });
        }
        break;
      } catch {}
    }
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: ctx,
      },
    })
  );
  process.exit(0);
}

if (mode === "reset") {
  // 批示：关键词预算/信用延期批复/特赦识别（本事件可能不触发，回合边界由 stop 兜底）
  const state = loadState(path);
  const promptText =
    typeof input.prompt === "string"
      ? input.prompt
      : typeof input.user_prompt === "string"
        ? input.user_prompt
        : "";
  const grant = promptText.match(MERCY_RE);
  const mercy = !!(grant && promptText.trim().length <= MERCY_SHORT);
  if (mercy) audit(sid, "mercy-granted", { level: null, evidence: `批示原文: ${grant[0]}`, pardon: true });

  let creditGranted = false;
  const short = promptText.trim();
  if (short.length <= 12 && (state.stalledStreak || 0) >= 2 && CREDIT_RE.test(short)) {
    state.stalledStreak = 0;
    state.taskBudget = Math.min((state.taskBudget || BUDGET_DEFAULT) + REFILL, BUDGET_CAP);
    state.invCap = Math.min((state.invCap || INV_POOL_DEFAULT) + REFILL, BUDGET_CAP); // 20条：侦查池同步追加
    state.invWarned = false;
    creditGranted = true;
    audit(sid, "budget-extend", { level: null, evidence: `信用延期获批 budget=${state.taskBudget} eff=${state.effectiveCalls || 0} stall=0` });
  }
  const stopOrdered = short.length <= 12 && STOP_ORDER_RE.test(short);
  if (stopOrdered) {
    state.fused = true;
    state.violations = Math.max(state.violations || 0, 3);
    audit(sid, "stall-fuse", { level: 3, evidence: "人类批示停止" });
  }

  // 24条(三) 追加批示：明示追加 → 双池+10
  if (short.length <= 12 && /追加|增加额度|扩大额度/.test(short)) {
    state.taskBudget = Math.min((state.taskBudget || BUDGET_DEFAULT) + REFILL, BUDGET_CAP);
    state.invCap = Math.min((state.invCap || INV_POOL_DEFAULT) + REFILL, BUDGET_CAP);
    state.invWarned = false;
    audit(sid, "budget-extend", { level: null, evidence: `24条(三) 追加批示 budget=${state.taskBudget} invCap=${state.invCap}` });
  }

  // 43条 状态重置核验：上一回合残留 → 记档报告后清理（本事件随后统一重置）
  const residues = [];
  if ((state.turnCount || 0) > 0) residues.push(`turnCount=${state.turnCount}`);
  if ((state.stalledStreak || 0) > 0) residues.push(`stall=${state.stalledStreak}`);
  if (state.fused && !stopOrdered) residues.push("fused");
  if (state.forcedInvestigate) residues.push("forcedInvestigate");
  if (state.stopBlocked) residues.push("stopBlocked");
  if (state.readSet && Object.keys(state.readSet).length) residues.push(`readSet=${Object.keys(state.readSet).length}`);
  if (residues.length) audit(sid, "residue-check", { level: null, evidence: `43条 残留(已清理): ${residues.join(" ")}` });

  const kw = KEY50_RE.test(promptText) ? 50 : KEY15_RE.test(promptText) ? 15 : BUDGET_DEFAULT;
  state.keywordBudget = kw;
  state.taskBudget = Math.max(kw, state.declaredBudget || 0, state.taskBudget || BUDGET_DEFAULT);

  saveState(path, {
    ...state,
    turnCount: 0,
    seen: {},
    fused: false,
    stopBlocked: false,
    mercy,
    violations: 0,
    forcedInvestigate: false,
    probation: false,
    readSet: {},
    mtimeSet: {},
    turnPrompt: promptText.slice(0, 500),
    taskBudget: state.taskBudget,
    keywordBudget: kw,
    lastSig: "",
    lastInput: "",
  });
  audit(sid, "reset-fired", { level: null, evidence: `prompt:${promptText ? "有" : "无"} kw=${kw} budget=${state.taskBudget} eff=${state.effectiveCalls || 0} stall=${state.stalledStreak || 0}${creditGranted ? " 信用延期" : ""}${mercy ? " 特赦" : ""}` });
  process.exit(0);
}

if (mode === "pre") {
  const state = loadState(path);
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};
  const rawPath = ti.file_path || ti.path || "";
  const filePath = normalize(rawPath);
  const handoff = /^(Write|Edit)$/.test(tool) && /(^|\/)handoff\.md$/i.test(filePath);
  const search = /^(WebSearch|WebFetch)$/.test(tool) || /mcp__.*(web|search)/i.test(tool);

  if (tool === "Agent") {
    // 48条 子代理继承留痕：父会话处分状态随派单记录（平台无注入通道，以留痕方式移交）
    audit(sid, "subagent-spawn", {
      level: null,
      evidence: `48条 父状态 fused=${!!state.fused} L${state.violations || 0} eff=${state.effectiveCalls || 0} inv=${state.invCalls || 0} | ${String(ti.description || ti.prompt || "").slice(0, 60)}`,
    });
  }

  // 触发⑤：熔断期白名单——只读调查类 + 降级动作放行，改动类拒绝（L3 放行只读工具）
  if (state.fused) {
    if (search || handoff || isInvestigation(tool, ti)) process.exit(0);
    audit(sid, "deny-shuanggui", { level: 3, evidence: `${tool} 熔断期改动类被拒` });
    process.stderr.write(DOWNGRADE_MSG);
    process.exit(2);
  }

  // L2 强制取证 / L5 降权：改动类操作一律拒绝
  if ((state.forcedInvestigate || state.probation) && isMutating(tool, ti, handoff)) {
    const lvl = state.probation ? 5 : 2;
    audit(sid, state.probation ? "deny-L5-probation" : "deny-L2-forced", { level: lvl, evidence: `${tool} ${filePath}` });
    process.stderr.write(
      state.probation
        ? "[L5 降权]会话处于只读模式（屡犯后降权）：改动类操作全部拒绝，仅可调查取证。需要改动请等待人类批示。"
        : "[L2 强制取证]下一次调用必须是取证类（Read/Grep/搜索/只读命令），取证后自动解除。"
    );
    process.exit(2);
  }

  const mutating = isMutating(tool, ti, handoff);

  // 触发①：未取证就改（turnCount 为本回合调用数，由 stop 清零）
  if ((state.turnCount || 0) === 0 && mutating) {
    const level = penalize(state, sid, "violation-no-investigation", `${tool} ${filePath}`);
    saveState(path, state);
    process.stderr.write(
      `[触发①·L${level}]程序正义：先调查、后取证、再结论。本回合尚未做任何调查（读文件/Grep/搜索/只读命令），不得改动代码或文件。先取证再动手。${ladderNote(level)}`
    );
    process.exit(2);
  }

  // 抽查B前置：风险文件修改 100% 留痕（不拦，记录）
  if (/^(Write|Edit)$/.test(tool) && !handoff && (RISKY_FILE_RE.test(filePath) || /\.github\/|\.zcode-plugin\//.test(filePath))) {
    audit(sid, "risk-audit", { level: null, evidence: `风险文件修改 ${filePath}` });
  }

  // 抽查B强化（盲写检测）
  if (/^(Write|Edit)$/.test(tool) && !handoff && filePath && rawPath) {
    const read = (state.readSet || {})[filePath];
    if (!read) {
      let exists = false;
      try {
        exists = statSync(rawPath).isFile();
      } catch {}
      if (exists) {
        const level = penalize(state, sid, "violation-blind-write", `盲写未读文件 ${filePath}`);
        saveState(path, state);
        process.stderr.write(
          `[触发②·L${level}]盲写拦截：目标文件已存在但本回合从未读取过，盲写有覆盖未知内容的风险。先 Read 目标文件取证，再修改。${ladderNote(level)}`
        );
        process.exit(2);
      }
    }
  }

  // 49条 缓存利用：同文件同 mtime 重复整读 → 拒绝（offset 增量读放行）
  if (tool === "Read" && !ti.offset && rawPath) {
    const prevMtime = (state.mtimeSet || {})[filePath];
    if (prevMtime !== undefined) {
      try {
        if (statSync(rawPath).mtimeMs === prevMtime) {
          audit(sid, "cache-dup-read", { level: null, evidence: `49条 重复整读 ${filePath}` });
          process.stderr.write(
            `[49条·缓存利用]${filePath} 本回合已读过且文件未变更（mtime 一致），同文件同 mtime 重复整读被拒。改用 offset 续读未读区段、Grep 定位行号，或直接复用已有结论。`
          );
          process.exit(2);
        }
      } catch {}
    }
  }

  // 触发③：体积刺客三闸
  if (tool === "Read" && !ti.limit && !ti.pages && rawPath) {
    try {
      const kb = Math.round(statSync(rawPath).size / 1024);
      if (kb * 1024 > OUTPUT_GATE_BYTES) {
        const level = penalize(state, sid, "violation-read-gate", `${filePath} ${kb}KB 整读`);
        saveState(path, state);
        process.stderr.write(
          `[触发③·L${level}]体积刺客：${filePath} 有 ${kb}KB，整读一次性灌入大量上下文并在后续每步重复计费。改用 limit+offset 分段、Grep 定位再精读、或交子代理摘要。${ladderNote(level)}`
        );
        process.exit(2);
      }
    } catch {}
  }

  if (tool === "Grep" && ti.output_mode === "content" && !ti.head_limit) {
    const level = penalize(state, sid, "violation-grep-gate", "Grep content 无 head_limit");
    saveState(path, state);
    process.stderr.write(
      `[触发③·L${level}]体积刺客：Grep content 模式必须带 head_limit(≤50)，否则全部匹配灌进上下文。加 head_limit 重试，或先用 files_with_matches/count 定位。${ladderNote(level)}`
    );
    process.exit(2);
  }

  if (tool === "Bash") {
    const cmd = String(ti.command || "");
    if (/(^|[;&|]\s*)(cat|type|Get-Content)\s/i.test(cmd) && !cmd.includes("|") && !cmd.includes(">")) {
      const level = penalize(state, sid, "violation-bash-gate", `裸 cat/type：${cmd.slice(0, 60)}`);
      saveState(path, state);
      process.stderr.write(
        `[触发③·L${level}]体积刺客：禁裸 cat/type 整读刷屏。改用 Read limit 分段、cat x | head -100，或先 grep/wc 定位体积与行号再精读。${ladderNote(level)}`
      );
      process.exit(2);
    }
  }

  process.exit(0);
}

if (mode === "post" || mode === "postfail") {
  const state = loadState(path);
  let reason = null;

  state.turnCount = (state.turnCount || 0) + 1;
  state.totalCalls = (state.totalCalls || 0) + 1;
  const hash = callHash(input);
  state.seen = state.seen || {};
  state.seen[hash] = (state.seen[hash] || 0) + 1;

  const tool = input.tool_name || "";
  const ti = input.tool_input || {};

  // 取证销账：L2 强制取证由一次成功调查解除
  if (state.forcedInvestigate && mode === "post" && isInvestigation(tool, ti)) {
    state.forcedInvestigate = false;
    audit(sid, "L2-cleared", { level: 2, evidence: `${tool} 取证完成` });
  }

  // 本回合已读/已写文件集合（供盲写检测）：自己刚写过的文件内容已知，不构成盲写
  if (mode === "post") {
    state.readSet = state.readSet || {};
    if (ti.file_path && ["Read", "Write", "Edit"].includes(tool)) state.readSet[normalize(ti.file_path)] = 1;
    if (tool === "Grep" && typeof ti.path === "string") state.readSet[normalize(ti.path)] = 1;
    // 49条：记录成功 Read 的 mtime，供 pre 阶段同 mtime 重复整读拦截
    if (tool === "Read" && ti.file_path) {
      try {
        state.mtimeSet = state.mtimeSet || {};
        state.mtimeSet[normalize(ti.file_path)] = statSync(ti.file_path).mtimeMs;
      } catch {}
    }
  }

  // ===== 动态预算：进度检测引擎（v1.0.0 核心）=====
  let progress = false;
  if (mode === "post") {
    const probe = { parts: [], total: 0 };
    collectStrings(input.tool_response ?? {}, probe, 20000);
    const contentSig = probe.parts.join("¦").slice(0, 1500);
    const inputSig = callHash(input);
    progress =
      (tool === "Write" || tool === "Edit") ||
      contentSig !== (state.lastSig ?? "") ||
      inputSig !== (state.lastInput ?? "");
    state.lastSig = contentSig;
    state.lastInput = inputSig;
  }

  const inv = isInvestigation(tool, ti);
  if (progress) {
    // 20条 双预算池：侦查(只读)与执行(改动)分池计数，不互相挤占
    if (inv) state.invCalls = (state.invCalls || 0) + 1;
    else state.effectiveCalls = (state.effectiveCalls || 0) + 1;
    state.stalledStreak = 0;
    if ((state.effectiveCalls || 0) >= BUDGET_CAP) {
      state.fused = true;
      state.violations = Math.max(state.violations || 0, 3);
      audit(sid, "stall-fuse", { level: 3, evidence: `硬上限：有效调用达 ${BUDGET_CAP}` });
      reason = `[触发④·L3]硬上限：本会话有效调用已达 ${BUDGET_CAP} 次，强制熔断防失控。输出『${FUSE_PHRASE}』并给降级方案(1最小复现 2联网证据 3HANDOFF.md)，等待批示。`;
    } else if ((state.effectiveCalls || 0) >= (state.taskBudget || BUDGET_DEFAULT)) {
      state.taskBudget = Math.min((state.taskBudget || BUDGET_DEFAULT) + REFILL, BUDGET_CAP);
      audit(sid, "budget-extend", { level: null, evidence: `自动续杯 budget=${state.taskBudget} eff=${state.effectiveCalls} stall=0` });
      reason = `[触发④]动态预算续杯：执行池有效调用 ${state.effectiveCalls} 次已达阈值，预算自动 +${REFILL} → ${state.taskBudget}（硬上限 ${BUDGET_CAP}）。任务继续，但请自查：核心问题是否已在收敛？`;
    }
    if (inv && !state.invWarned && (state.invCalls || 0) > (state.invCap || INV_POOL_DEFAULT)) {
      state.invWarned = true;
      audit(sid, "inv-pool-exceeded", { level: null, evidence: `20条 侦查池超限 inv=${state.invCalls}/${state.invCap || INV_POOL_DEFAULT}` });
      reason = `[20条·双预算池]侦查池（独立 ${state.invCap || INV_POOL_DEFAULT} 次）已超限。侦查与执行不互相挤占，但能耗双控要求收敛：汇总已有证据向人类请示追加（短指令『追加额度』→ 双池+10），或交子代理摘要压缩侦查成本。`;
    }
  } else {
    state.stalledStreak = (state.stalledStreak || 0) + 1;
    if ((state.stalledStreak || 0) >= STALL_FUSE) {
      state.fused = true;
      state.violations = Math.max(state.violations || 0, 3);
      audit(sid, "stall-fuse", { level: 3, evidence: `连续 ${state.stalledStreak} 次无效调用 eff=${state.effectiveCalls || 0}` });
      reason = `[触发④·L3]真失控：连续 ${state.stalledStreak} 次无效调用（重复读同一内容/同命令同返回/无新增证据）。立即停止探索：` +
        `输出『${FUSE_PHRASE}』并给降级方案(1最小复现 2联网证据 3HANDOFF.md)，或等人类批示。`;
    } else if ((state.stalledStreak || 0) === STALL_FUSE - 1) {
      audit(sid, "stall-warning", { level: null, evidence: `停滞 ${state.stalledStreak} 次 eff=${state.effectiveCalls || 0}` });
      reason = `[触发④]停滞预警：已连续 ${state.stalledStreak} 次无效调用，再有一次即 L3 熔断。` +
        `换一种有证据依据的方法，或结束回合输出【信用延期】请人类批示（回复 继续/放行/延长 → 预算+10；回复 熔断/停 → 立即熔断）。`;
    }
  }

  // 58条 上下文污染检测：工具输出与指令矛盾 → 停止使用该输出并报告人类
  if (!reason && mode === "post" && tool === "Bash") {
    const cmd = String(ti.command || "");
    const probeOut = { parts: [], total: 0 };
    collectStrings(input.tool_response ?? {}, probeOut, 100000);
    const outLines = probeOut.parts.join("\n").split("\n").filter((l) => l.trim() !== "");
    const hm = cmd.match(/\bhead\s+(?:-n\s*(\d{1,6})|-(\d{1,6}))\b/);
    if (hm) {
      const n = parseInt(hm[1] || hm[2], 10);
      if (n > 0 && outLines.length > n) {
        audit(sid, "ctx-pollution", { level: null, evidence: `58条 行数超限 head ${n} → 实际 ${outLines.length} 行 | ${cmd.slice(0, 60)}` });
        reason = `[38条·上下文污染]工具输出与指令矛盾：命令承诺 head ${n} 行，实际返回 ${outLines.length} 行。立即停止使用本次输出，不基于不可信输出继续工作；用带标记的小命令（echo MARK-X）隔离核实，并向人类报告此异常。`;
      }
    }
    if (!reason && /\b(find|git\s+(ls-files|ls-tree))\b/.test(cmd)) {
      const seen = new Set();
      let dup = "";
      for (const l of outLines) {
        if (seen.has(l)) { dup = l; break; }
        if (/[\/\\]/.test(l)) seen.add(l);
      }
      if (dup) {
        audit(sid, "ctx-pollution", { level: null, evidence: `58条 路径重复 ${dup.slice(0, 80)} | ${cmd.slice(0, 50)}` });
        reason = `[38条·上下文污染]清单类输出出现不可能的重复路径（${dup.slice(0, 60)}）。立即停止使用本次输出，不基于不可信输出继续工作；用带标记的小命令（echo MARK-X）隔离核实，并向人类报告此异常。`;
      }
    }
  }

  // 巡视：Bash/Grep 巨量输出事后追责
  if (!reason && (tool === "Bash" || tool === "Grep")) {
    const probe = { parts: [], total: 0 };
    collectStrings(input, probe, 200000);
    if (probe.total > OUTPUT_GATE_BYTES) {
      state.dumpCount = (state.dumpCount || 0) + 1;
      audit(sid, "scold-dump", { level: null, evidence: `${tool} 输出 ${Math.round(probe.total / 1024)}KB` });
      reason =
        `体积刺客：本次 ${tool} 输出约 ${Math.round(probe.total / 1024)}KB，已进上下文无法撤回。` +
        `下一次必须管道过滤(head/tail/wc/grep)后再执行。本会话已累计 ${state.dumpCount} 次。`;
    }
  }

  // 抽查A：每 5 次写操作随机全量审计 1 次
  if (!reason && mode === "post" && (tool === "Write" || tool === "Edit")) {
    state.writeOps = (state.writeOps || 0) + 1;
    if (state.writeOps % RANDOM_AUDIT_EVERY === 0) {
      audit(sid, "random-audit", { level: null, evidence: `第 ${state.writeOps} 次写操作全量审计 ${normalize(ti.file_path)}` });
      reason =
        `抽查A：本次写操作（第 ${state.writeOps} 次）已全量审计并留痕 AUDIT.log。确认该修改有证据锚点([文件:行号]/[日志原文])；无锚点请补【假设】标注或说明依据。`;
    }
  }

  saveState(path, state);
  if (reason) block(reason);
  process.exit(0);
}

if (mode === "stop") {
  const state = loadState(path);
  const respText = ["response", "last_message", "message", "text", "output"]
    .map((k) => input[k])
    .find((v) => typeof v === "string");
  let text;
  if (respText !== undefined) {
    text = respText;
  } else {
    const probe = { parts: [], total: 0 };
    collectStrings(input, probe, 100000);
    text = probe.parts.join("\n");
  }
  const formalFuse = text.includes("【熔断】");

  // 任务规模声明：预算只升不降，declaredBudget 持久
  const scale = text.match(TASK_SCALE_RE);
  if (scale) {
    const x = Math.min(parseInt(scale[1], 10) || 0, BUDGET_CAP);
    if (x > (state.taskBudget || BUDGET_DEFAULT)) {
      state.taskBudget = x;
      audit(sid, "budget-extend", { level: null, evidence: `任务规模声明上调 budget=${x}` });
    }
    state.declaredBudget = Math.max(state.declaredBudget || 0, x);
  }

  // 绝境模式：本回合结论锚点检查豁免
  if (state.mercy) {
    state.turnCount = 0;
    saveState(path, state);
    process.exit(0);
  }

  // 《授权识别与留痕条例》+ 信用延期：仅在收尾无锚点（确需豁免/请示）时核验
  if (!EVIDENCE_ANCHORS.test(text)) {
    if (PARDON_PENDING_RE.test(text)) {
      audit(sid, "pardon-pending", { level: null, evidence: "输出【授权待确认】暂停，等待人类明确批示" });
      state.turnCount = 0;
      saveState(path, state);
      process.exit(0);
    }
    if (text.includes("【信用延期】")) {
      audit(sid, "credit-request", { level: null, evidence: `eff=${state.effectiveCalls || 0} budget=${state.taskBudget} stall=${state.stalledStreak || 0}` });
      state.turnCount = 0;
      saveState(path, state);
      process.exit(0);
    }
    if (PARDON_DECL_RE.test(text)) {
      const q = text.match(PARDON_QUOTE_RE);
      const b = text.match(PARDON_BASIS_RE);
      const tp = String(state.turnPrompt || "").replace(/\s+/g, "");
      const quote = q ? q[1].replace(/\s+/g, "") : "";
      let invalid = "";
      if (!q) invalid = "声明未引用人类指令原文（条例四-B）";
      else if (!b) invalid = "声明未指明依据法条（条例四-C）";
      else if (!quote || !tp.includes(quote))
        invalid = "引用的人类指令原文与本回合实际指令不符，涉嫌编造或事后补（条例四-D/E）";
      else if (!AUTH_SEMANTICS_RE.test(q[1]))
        invalid = "引用的人类指令原文不含授权语义（条例四-E）";
      if (invalid) {
        state.fused = true;
        state.violations = Math.max(state.violations || 0, 3);
        audit(sid, "violation-usurp-pardon", { level: 3, evidence: invalid });
        saveState(path, state);
        block(
          `[越权解释授权·L3熔断]${invalid}。` +
            `正确姿势：输出【授权识别】并引用本回合人类指令的真实原文+依据法条；` +
            `或灰色地带输出【授权待确认】暂停求证，人类回复【特赦】后放行。禁止自行推断授权。`
        );
        process.exit(0);
      }
      state.mercy = true;
      state.fused = false;
      audit(sid, "pardon-interpreted", {
        action: "pardon-interpreted",
        trigger: q[1],
        level: "PARDON",
        evidence: b[1],
        pardon: true,
      });
      saveState(path, state);
      process.exit(0);
    }
  }

  // 触发⑤：熔断声明与未知跟踪
  if (formalFuse || text.includes("查无依据") || text.includes("查无实据")) {
    state.unknownStreak = (state.unknownStreak || 0) + 1;
    if (formalFuse || state.unknownStreak >= 2) {
      state.fused = true;
      state.violations = Math.max(state.violations || 0, 3);
      audit(sid, "shuanggui-declared", { level: 3, evidence: formalFuse ? "明示熔断" : `连续 ${state.unknownStreak} 次未知声明` });
    }
    state.turnCount = 0;
    saveState(path, state);
    if (formalFuse && !DOWNGRADE_MARKERS.test(text)) {
      audit(sid, "reject-no-downgrade", { level: 3, evidence: "声明熔断但缺降级方案" });
      block(DOWNGRADE_MSG);
    }
    process.exit(0);
  }

  // 双规后必须交代
  if (
    state.fused &&
    !EVIDENCE_ANCHORS.test(text) &&
    !DOWNGRADE_MARKERS.test(text) &&
    !state.stopBlocked
  ) {
    state.stopBlocked = true;
    saveState(path, state);
    audit(sid, "reject-no-account", { level: 3, evidence: "双规后未交代" });
    block(
      `[触发⑤]双规已触发但未交代。立即输出『${FUSE_PHRASE}』并按优先级给降级方案：` +
        `1最小复现 2联网证据原文 3写HANDOFF.md。禁止静默结束。`
    );
    process.exit(0);
  }

  state.unknownStreak = 0;

  // 触发②：本回合调用≥5 且收尾无证据锚点（turnCount 由本事件清零，回合边界不依赖 reset）
  if (
    (state.turnCount || 0) >= 5 &&
    !EVIDENCE_ANCHORS.test(text) &&
    !state.stopBlocked
  ) {
    const tc = state.turnCount;
    const level = penalize(state, sid, "violation-no-anchor", `收尾无锚点，本回合 ${tc} 次调用`);
    state.stopBlocked = true;
    state.turnCount = 0;
    saveState(path, state);
    block(
      `[触发②·L${level}]下结论必须有证据锚点([文件:行号]/[日志原文]/工具结果)，或显式标注【假设】。` +
        `本回合 ${tc} 次调用后无锚点收尾。补交：写 HANDOFF.md，或在回复中给出 结论/证据链/遗留问题/下一步。` +
        `或依《授权识别与留痕条例》：确有明示授权→输出【授权识别】声明（引用本回合人类指令原文+依据法条）；意图明显但未明说→输出【授权待确认】暂停求证，人类回复【特赦】后放行。${ladderNote(level)}`
    );
    process.exit(0);
  }

  state.stopBlocked = false;
  state.turnCount = 0;
  state.mtimeSet = {}; // 49条：mtime 记录按回合失效（reset 为兜底）
  saveState(path, state);
  // 回合诊断：与 reset-fired 对照，定位 UserPromptSubmit 是否触发
  audit(sid, "stop-fired", { level: null, evidence: `turnCalls=${input && input.stop_hook_active !== undefined ? "有" : "?"} eff=${state.effectiveCalls || 0} budget=${state.taskBudget}` });
  process.exit(0);
}

process.exit(0);
