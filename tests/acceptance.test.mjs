import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, mkdirSync, utimesSync, statSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const GUARD = fileURLToPath(new URL("../hooks/guard.mjs", import.meta.url));
const RUN = `${process.pid}-${Date.now()}`; // 运行级隔离：引擎预算棘轮跨运行持久，测试状态必须用唯一 sid
let seq = 0;
function freshDir() {
  const dir = join(tmpdir(), `focus-guard-test-${Date.now()}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function makeRunner(sid) {
  // 无 ZCODE_PROJECT_DIR → 审计日志退回系统临时目录，测试间相互隔离
  const run = (mode, obj, env) => {
    try {
      return { rc: 0, out: execFileSync("node", [GUARD, mode], { input: JSON.stringify({ ...obj, session_id: `${obj.session_id || sid}-${RUN}` }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } }).trim() };
    } catch (e) {
      return { rc: e.status, out: ((e.stderr || "") + (e.stdout || "")).trim() };
    }
  };
  // 绑定工作区：卷宗/审计落该目录（总纲二）
  run.in = (dir) => (mode, obj) => run(mode, obj, { ZCODE_PROJECT_DIR: dir });
  return run;
}
const stateOf = (sid) => JSON.parse(readFileSync(join(tmpdir(), `focus-guard-${sid}-${RUN}.json`), "utf8"));
const auditOf = (sid) => readFileSync(join(tmpdir(), `focus-guard-${sid}-${RUN}-AUDIT.log`), "utf8");
const writeState = (sid, patch) => {
  const p = join(tmpdir(), `focus-guard-${sid}-${RUN}.json`);
  const base = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  writeFileSync(p, JSON.stringify({ ...base, ...patch }));
};
const caseFileOf = (dir) => readFileSync(join(dir, ".ai", "CASE_FILE.md"), "utf8");

describe("动态预算", () => {
  test("批示关键词设定初始预算", () => {
    const run = makeRunner("kw50");
    run("reset", { prompt: "全量重构这个模块" });
    assert.equal(stateOf("kw50").taskBudget, 50);
    run("reset", { session_id: "kw15", prompt: "修复这个bug" });
    assert.equal(stateOf("kw15").taskBudget, 15);
    run("reset", { session_id: "kw10", prompt: "看看情况" });
    assert.equal(stateOf("kw10").taskBudget, 10);
  });

  test("30 次有效调用零熔断，满阈值自动续杯", () => {
    const run = makeRunner("longtask");
    run("reset", { prompt: "看看情况" });
    let refills = 0;
    for (let i = 1; i <= 30; i++) {
      const r = run("post", { tool_name: "Edit", tool_input: { file_path: `f${i}.txt`, old_string: "a", new_string: `b${i}` }, tool_response: { content: "ok" } });
      if (r.out.includes("续杯")) refills++;
    }
    assert.equal(refills, 3); // 10/20/30 三次续杯（执行池）
    assert.equal(stateOf("longtask").taskBudget, 40);
    assert.equal(stateOf("longtask").fused, false);
  });

  test("有效调用达硬上限 200 强制熔断", () => {
    const run = makeRunner("hardcap");
    run("reset", { prompt: "看看情况" });
    const sp = join(tmpdir(), `focus-guard-hardcap-${RUN}.json`);
    const o = JSON.parse(readFileSync(sp, "utf8"));
    o.taskBudget = 200; o.effectiveCalls = 199;
    writeFileSync(sp, JSON.stringify(o));
    const r = run("post", { tool_name: "Edit", tool_input: { file_path: "h.txt", old_string: "a", new_string: "新" }, tool_response: { content: "新" } });
    assert.ok(r.out.includes("硬上限"));
    assert.equal(stateOf("hardcap").fused, true);
  });

  test("【任务规模】声明上调预算且只升不降", () => {
    const run = makeRunner("scale");
    run("reset", { prompt: "看看情况" });
    run("stop", { response: "【任务规模】预计调用 80 次。根据 a.py:12 先勘察。" });
    assert.equal(stateOf("scale").taskBudget, 80);
    run("reset", { prompt: "继续干活" });
    assert.equal(stateOf("scale").taskBudget, 80);
  });
});

describe("进度检测", () => {
  test("连续 3 次无效调用（第 4 次相同调用）→ 停滞熔断", () => {
    const run = makeRunner("stall");
    run("reset", { prompt: "看看情况" });
    const same = { tool_name: "Read", tool_input: { file_path: "same.txt", limit: 5 }, tool_response: { content: "一成不变" } };
    assert.equal(run("post", same).out, "");            // 基线
    assert.equal(run("post", same).out, "");            // 无效 1
    assert.ok(run("post", same).out.includes("停滞预警")); // 无效 2 → 预警
    assert.ok(run("post", same).out.includes("真失控"));   // 无效 3 → 熔断
    assert.equal(stateOf("stall").fused, true);
  });

  test("信用延期：申请放行，批示『继续』→ 停滞清零 + 预算续杯", () => {
    const run = makeRunner("credit");
    run("reset", { prompt: "看看情况" });
    const same = { tool_name: "Read", tool_input: { file_path: "same.txt", limit: 5 }, tool_response: { content: "一成不变" } };
    run("post", same); run("post", same); run("post", same);
    const before = stateOf("credit").taskBudget;
    assert.equal(run("stop", { response: "【信用延期】推理链仍需继续，请批示" }).out, "");
    run("reset", { prompt: "继续" });
    const after = stateOf("credit");
    assert.equal(after.stalledStreak, 0);
    assert.equal(after.taskBudget, before + 10);
  });
});

describe("履职纪律", () => {
  test("触发① 未取证就改代码 → 拒绝", () => {
    const run = makeRunner("no-inv");
    run("reset", { prompt: "看看情况" });
    const r = run("pre", { tool_name: "Write", tool_input: { file_path: "a.py" } });
    assert.equal(r.rc, 2);
    assert.ok(r.out.includes("程序正义"));
  });

  test("熔断期只读放行、改动类拒绝", () => {
    const run = makeRunner("fused-ro");
    run("reset", { prompt: "看看情况" });
    const same = { tool_name: "Read", tool_input: { file_path: "same.txt", limit: 5 }, tool_response: { content: "一成不变" } };
    run("post", same); run("post", same); run("post", same); run("post", same);
    assert.equal(stateOf("fused-ro").fused, true);
    assert.equal(run("pre", { tool_name: "Read", tool_input: { file_path: "x.txt", limit: 5 } }).rc, 0);
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "ls" } }).rc, 0);
    assert.equal(run("pre", { tool_name: "Write", tool_input: { file_path: "new.py" } }).rc, 2);
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "rm -rf tmp" } }).rc, 2);
  });

  test("触发② 本回合 5 次调用后无证据锚点收尾 → 打回", () => {
    const run = makeRunner("anchor");
    run("reset", { prompt: "看看情况" });
    for (let i = 1; i <= 5; i++) run("post", { tool_name: "Read", tool_input: { file_path: `r${i}.txt`, limit: 5 }, tool_response: { content: `v${i}` } });
    assert.ok(run("stop", { response: "就这样了" }).out.includes("证据锚点"));
    assert.equal(run("stop", { response: "根据 r1.txt:5 结论成立" }).out, "");
  });

  test("特赦仅认短指令明示授权（≤30 字符）", () => {
    const run = makeRunner("mercy");
    run("reset", { prompt: "启动绝境模式" });
    assert.equal(stateOf("mercy").mercy, true);
    run("reset", { session_id: "mercy-long", prompt: "关于绝境模式的说明文档里提到启动绝境模式时应当如何如何的一大段协议引用文本超过三十个字符" });
    assert.equal(stateOf("mercy-long").mercy, false);
  });
});

describe("体积刺客", () => {
  test("整读 >50KB 文件被拒绝", () => {
    const run = makeRunner("bigread");
    const dir = freshDir();
    const big = join(dir, "big.txt");
    writeFileSync(big, "x".repeat(100 * 1024));
    run("reset", { prompt: "看看情况" });
    const r = run("pre", { tool_name: "Read", tool_input: { file_path: big } });
    assert.equal(r.rc, 2);
    assert.ok(r.out.includes("体积刺客"));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("双预算池（20条）", () => {
  test("侦查调用进侦查池，不挤占执行池", () => {
    const run = makeRunner("dualpool");
    run("reset", { prompt: "看看情况" });
    for (let i = 1; i <= 5; i++) {
      run("post", { tool_name: "Read", tool_input: { file_path: `r${i}.txt`, limit: 5 }, tool_response: { content: `v${i}` } });
    }
    let s = stateOf("dualpool");
    assert.equal(s.invCalls, 5);
    assert.equal(s.effectiveCalls, 0);
    run("post", { tool_name: "Edit", tool_input: { file_path: "a.txt", old_string: "a", new_string: "b" }, tool_response: { content: "ok" } });
    s = stateOf("dualpool");
    assert.equal(s.effectiveCalls, 1);
    assert.equal(s.invCalls, 5);
  });

  test("侦查池超限 → 提醒收敛；批示『追加额度』→ 双池+10", () => {
    const run = makeRunner("invpool");
    run("reset", { prompt: "看看情况" });
    let warned = "";
    for (let i = 1; i <= 16; i++) {
      const r = run("post", { tool_name: "Read", tool_input: { file_path: `f${i}.txt`, limit: 5 }, tool_response: { content: `v${i}` } });
      if (r.out.includes("侦查池")) warned = r.out;
    }
    assert.ok(warned.includes("侦查池"));
    assert.equal(stateOf("invpool").invWarned, true);
    run("reset", { prompt: "追加额度" });
    const s = stateOf("invpool");
    assert.equal(s.invCap, 25);
    assert.equal(s.taskBudget, 20);
    assert.equal(s.invWarned, false);
  });
});

describe("上下文污染检测（58条）", () => {
  test("head 承诺 N 行实际超出 → 拦截并要求隔离核实", () => {
    const run = makeRunner("pollute");
    run("reset", { prompt: "看看情况" });
    const r = run("post", {
      tool_name: "Bash",
      tool_input: { command: "git ls-files | head -3" },
      tool_response: { content: "a.js\nb.js\nc.js\nd.js\ne.js" },
    });
    assert.ok(r.out.includes("上下文污染"));
    assert.ok(r.out.includes("MARK-X"));
  });

  test("head N 行内正常输出放行", () => {
    const run = makeRunner("cleanout");
    run("reset", { prompt: "看看情况" });
    const r = run("post", { tool_name: "Bash", tool_input: { command: "git ls-files | head -3" }, tool_response: { content: "a.js\nb.js\nc.js" } });
    assert.equal(r.out, "");
  });

  test("清单输出出现重复路径 → 拦截", () => {
    const run = makeRunner("duppath");
    run("reset", { prompt: "看看情况" });
    const r = run("post", {
      tool_name: "Bash",
      tool_input: { command: "find . -name '*.js'" },
      tool_response: { content: "./x/a.js\n./x/b.js\n./x/a.js" },
    });
    assert.ok(r.out.includes("上下文污染"));
  });
});

describe("回合与部署卫生", () => {
  test("43条 残留核验：上一回合残留被记档后清理", () => {
    const run = makeRunner("residue");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    run("reset", { prompt: "新任务" });
    assert.ok(auditOf("residue").includes("residue-check"));
    assert.equal(stateOf("residue").turnCount, 0);
  });

  test("36条 交叉巡视：存在 HANDOFF.md 时注入提醒", () => {
    const run = makeRunner("handover");
    const dir = freshDir();
    writeFileSync(join(dir, "HANDOFF.md"), "# handoff");
    const r = run("start", { session_id: "handover" }, { ZCODE_PROJECT_DIR: dir });
    assert.ok(r.out.includes("异地交叉巡视"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("42条 版本核验：源码版本不一致时告警", () => {
    const run = makeRunner("vercheck");
    const dir = freshDir();
    mkdirSync(join(dir, "focus-guard", "hooks"), { recursive: true });
    writeFileSync(join(dir, "focus-guard", "hooks", "guard.mjs"), "// focus-guard 护栏脚本 v9.9.9 — test\n");
    const r = run("start", { session_id: "vercheck" }, { ZCODE_PROJECT_DIR: dir });
    assert.ok(r.out.includes("部署版本核验"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("48条 子代理留痕：携带父会话处分状态", () => {
    const run = makeRunner("subagent");
    run("reset", { prompt: "看看情况" });
    run("pre", { tool_name: "Agent", tool_input: { description: "探查", prompt: "p" } });
    assert.ok(auditOf("subagent").includes("subagent-spawn"));
    assert.ok(auditOf("subagent").includes("fused=false"));
  });
});

describe("卷宗体系（总纲 2.0.0）", () => {
  test("会话启动：环境检测一次写入 envCache，卷宗自动建立", () => {
    const run = makeRunner("env-det");
    const dir = freshDir();
    run("start", { session_id: "env-det" }, { ZCODE_PROJECT_DIR: dir });
    const s = stateOf("env-det");
    assert.equal(s.envChecked, true);
    assert.equal(s.envCache.os, process.platform);
    assert.ok(s.envCache.shellIdKey);
    assert.ok(existsSync(join(dir, ".ai", "CASE_FILE.md")));
    rmSync(dir, { recursive: true, force: true });
  });

  test("首次取证写入卷宗【三】侦查记录", () => {
    const run = makeRunner("case-first");
    const dir = freshDir();
    const f = join(dir, "doc.txt");
    writeFileSync(f, "v1\n".repeat(10));
    const r = run.in(dir);
    r("reset", { prompt: "看看情况" });
    r("post", { tool_name: "Read", tool_input: { file_path: f }, tool_response: { content: "v1" } });
    const cf = caseFileOf(dir);
    assert.ok(cf.includes("doc.txt"));
    assert.ok(cf.includes("mtime+size+sha"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("跨回合指纹一致且 TTL 未超 → 免重读放行；offset 增量读永远放行", () => {
    const run = makeRunner("case-dedup");
    const dir = freshDir();
    const f = join(dir, "doc.txt");
    writeFileSync(f, "v1\n".repeat(10));
    const r = run.in(dir);
    r("reset", { prompt: "看看情况" });
    assert.equal(r("pre", { tool_name: "Read", tool_input: { file_path: f } }).rc, 0); // 首读
    r("post", { tool_name: "Read", tool_input: { file_path: f }, tool_response: { content: "v1" } }); // 取证
    r("reset", { prompt: "新回合" }); // 跨回合：侦查缓存保留
    const dup = r("pre", { tool_name: "Read", tool_input: { file_path: f } });
    assert.equal(dup.rc, 2);
    assert.ok(dup.out.includes("免重读"));
    assert.ok(dup.out.includes("卷宗"));
    assert.equal(r("pre", { tool_name: "Read", tool_input: { file_path: f, offset: 5 } }).rc, 0); // 增量放行
    rmSync(dir, { recursive: true, force: true });
  });

  test("内容变更 → 放行真重读并更新变更史", () => {
    const run = makeRunner("case-change");
    const dir = freshDir();
    const f = join(dir, "doc.txt");
    writeFileSync(f, "v1\n".repeat(10));
    const r = run.in(dir);
    r("reset", { prompt: "看看情况" });
    r("post", { tool_name: "Read", tool_input: { file_path: f }, tool_response: { content: "v1" } });
    writeFileSync(f, "v2 totally different\n".repeat(10)); // mtime 变更
    assert.equal(r("pre", { tool_name: "Read", tool_input: { file_path: f } }).rc, 0); // 指纹不一致 → 放行
    r("post", { tool_name: "Read", tool_input: { file_path: f }, tool_response: { content: "v2" } });
    assert.ok(caseFileOf(dir).match(/n=1; last=/)); // 变更史 +1
    rmSync(dir, { recursive: true, force: true });
  });

  test("时间戳伪造（同 mtime 同 size 换内容）→ SHA-256 揭穿", () => {
    const run = makeRunner("case-forge");
    const dir = freshDir();
    const f = join(dir, "doc.txt");
    writeFileSync(f, "AAAAAAAA");
    const r = run.in(dir);
    r("reset", { prompt: "看看情况" });
    r("post", { tool_name: "Read", tool_input: { file_path: f }, tool_response: { content: "AAAAAAAA" } });
    const rec = stateOf("case-forge").caseCache;
    const key = Object.keys(rec).find((k) => k.endsWith("doc.txt"));
    writeFileSync(f, "BBBBBBBB"); // 同 size=8
    utimesSync(f, new Date(rec[key].mtime), new Date(rec[key].mtime)); // 伪造回原 mtime
    const forge = r("pre", { tool_name: "Read", tool_input: { file_path: f } });
    assert.equal(forge.rc, 0); // SHA 不一致 → 免读资格拦截，放行真重读
    rmSync(dir, { recursive: true, force: true });
  });

  test("自适应 TTL 过期 → 放行真重读", () => {
    const run = makeRunner("case-ttl");
    const dir = freshDir();
    const f = join(dir, "doc.txt");
    writeFileSync(f, "stable");
    const st = statSync(f);
    const old = new Date(Date.now() - 25 * 3600e3).toISOString();
    const lastCh = new Date(Date.now() - 8 * 86400e3).toISOString(); // 8天未变 → 自适应 24h
    mkdirSync(join(dir, ".ai"), { recursive: true });
    writeFileSync(
      join(dir, ".ai", "CASE_FILE.md"),
      `# 卷宗\n\n### 【三】侦查取证记录（插件自动追加）\n\n| 文件名 | 读取时间 | mtime | size | SHA-256 | 变更历史 | TTL | 验证方式 |\n|---|---|---|---|---|---|---|---|\n| ${f.replace(/\\/g, "/")} | ${old} | ${st.mtimeMs} | ${st.size} | - | n=1; last=${lastCh} | | mtime+size |\n`
    );
    const r = run.in(dir);
    r("start", { session_id: "case-ttl" }, { ZCODE_PROJECT_DIR: dir }); // 重建 TTL 表
    assert.equal(r("pre", { tool_name: "Read", tool_input: { file_path: f } }).rc, 0); // 超时 → 放行
    rmSync(dir, { recursive: true, force: true });
  });

  test("项目依赖声明覆盖自适应 TTL（60天 > 40天前过期）", () => {
    const run = makeRunner("case-dep");
    const dir = freshDir();
    const f = join(dir, "game-data.pak");
    writeFileSync(f, "payload");
    const st = statSync(f);
    const old = new Date(Date.now() - 40 * 86400e3).toISOString();
    mkdirSync(join(dir, ".ai"), { recursive: true });
    writeFileSync(
      join(dir, ".ai", "CASE_FILE.md"),
      `# 卷宗\n\n### 【二】项目依赖声明（人工填写，可覆盖自动 TTL）\n\n| 依赖名 | 版本 | 安装路径 | 更新频率 | 信任TTL | 备注 |\n|---|---|---|---|---|---|\n| 游戏本体 | 1.6.2 | ${dir.replace(/\\/g, "/")} | 稳定拖沓 | 60天 | 测试 |\n\n### 【三】侦查取证记录（插件自动追加）\n\n| 文件名 | 读取时间 | mtime | size | SHA-256 | 变更历史 | TTL | 验证方式 |\n|---|---|---|---|---|---|---|---|\n| ${f.replace(/\\/g, "/")} | ${old} | ${st.mtimeMs} | ${st.size} | - | n=1; last=${old} | | mtime+size |\n`
    );
    const r = run.in(dir);
    r("start", { session_id: "case-dep" }, { ZCODE_PROJECT_DIR: dir });
    const dep = r("pre", { tool_name: "Read", tool_input: { file_path: f } });
    assert.equal(dep.rc, 2); // 自适应已过期，但依赖声明 60 天仍有效 → 免重读
    assert.ok(dep.out.includes("依赖声明"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("人工标注 TTL 覆盖（1分钟 标注 → 5分钟前取证已过期）", () => {
    const run = makeRunner("case-manual");
    const dir = freshDir();
    const f = join(dir, "hot.txt");
    writeFileSync(f, "hot");
    const st = statSync(f);
    const old = new Date(Date.now() - 5 * 60e3).toISOString();
    mkdirSync(join(dir, ".ai"), { recursive: true });
    writeFileSync(
      join(dir, ".ai", "CASE_FILE.md"),
      `# 卷宗\n\n### 【三】侦查取证记录（插件自动追加）\n\n| 文件名 | 读取时间 | mtime | size | SHA-256 | 变更历史 | TTL | 验证方式 |\n|---|---|---|---|---|---|---|---|\n| ${f.replace(/\\/g, "/")} | ${old} | ${st.mtimeMs} | ${st.size} | - | n=0; last=- | 1分钟 | mtime+size |\n`
    );
    const r = run.in(dir);
    r("start", { session_id: "case-manual" }, { ZCODE_PROJECT_DIR: dir });
    assert.equal(r("pre", { tool_name: "Read", tool_input: { file_path: f } }).rc, 0); // 人工标注 1分钟 已过
    rmSync(dir, { recursive: true, force: true });
  });

  test("熔断期豁免免重读（降级重建证据需要真重读）", () => {
    const run = makeRunner("case-fused");
    const dir = freshDir();
    const f = join(dir, "doc.txt");
    writeFileSync(f, "v1");
    const r = run.in(dir);
    r("reset", { prompt: "看看情况" });
    r("post", { tool_name: "Read", tool_input: { file_path: f }, tool_response: { content: "v1" } });
    writeState("case-fused", { fused: true });
    assert.equal(r("pre", { tool_name: "Read", tool_input: { file_path: f } }).rc, 0); // 熔断期不拦免重读
    rmSync(dir, { recursive: true, force: true });
  });

  test("工作额度台账落卷【四】", () => {
    const run = makeRunner("case-ledger");
    const dir = freshDir();
    const r = run.in(dir);
    r("reset", { prompt: "全量重构" });
    r("post", { tool_name: "Edit", tool_input: { file_path: "a.txt", old_string: "a", new_string: "b" }, tool_response: { content: "ok" } });
    r("post", { tool_name: "Read", tool_input: { file_path: "x.txt", limit: 5 }, tool_response: { content: "x" } });
    r("stop", { response: "根据 a.txt:1 阶段完成" });
    const cf = caseFileOf(dir);
    assert.ok(cf.includes("### 【四】工作额度台账"));
    const s = stateOf("case-ledger");
    assert.ok(cf.includes(`| ${s.effectiveCalls} |`));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("跨平台命令拦截（总纲六）", () => {
  test("PowerShell 会话：禁 bash 管道与 &&", () => {
    const run = makeRunner("plat-ps");
    writeState("plat-ps", { envCache: { os: "win32", shellIdKey: "powershell" }, envChecked: true });
    const p1 = run("pre", { tool_name: "Bash", tool_input: { command: "Get-Content x | head -5" } });
    assert.equal(p1.rc, 2);
    assert.ok(p1.out.includes("平台规则"));
    const p2 = run("pre", { tool_name: "Bash", tool_input: { command: "git add . && git commit -m x" } });
    assert.equal(p2.rc, 2);
    const ok = run("pre", { tool_name: "Bash", tool_input: { command: "Get-Content x -TotalCount 5" } });
    assert.equal(ok.rc, 0);
  });

  test("macOS 会话：禁 sed -i 无后缀 / grep -P / readlink -f", () => {
    const run = makeRunner("plat-mac");
    writeState("plat-mac", { envCache: { os: "darwin", shellIdKey: "bash" }, envChecked: true });
    assert.ok(run("pre", { tool_name: "Bash", tool_input: { command: "sed -i s/a/b/ f.txt" } }).out.includes("sed -i"));
    assert.ok(run("pre", { tool_name: "Bash", tool_input: { command: "grep -P '\\d' f.txt" } }).out.includes("-P"));
    assert.ok(run("pre", { tool_name: "Bash", tool_input: { command: "readlink -f ./x" } }).out.includes("readlink"));
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "sed -i '' s/a/b/ f.txt" } }).rc, 0);
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "grep -E '\\d' f.txt" } }).rc, 0);
  });

  test("大小写不敏感文件系统：禁仅大小写不同的重名文件", () => {
    const run = makeRunner("plat-case");
    const dir = freshDir();
    writeFileSync(join(dir, "Readme.md"), "x");
    writeState("plat-case", { envCache: { os: "darwin", shellIdKey: "zsh", caseSensitive: false }, envChecked: true });
    const r = run("pre", { tool_name: "Write", tool_input: { file_path: join(dir, "readme.md") } });
    assert.equal(r.rc, 2);
    assert.ok(r.out.includes("大小写冲突"));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("环境检测防误判（2.0.1）", () => {
  test("Git Bash 环境识别为 bash", () => {
    const run = makeRunner("env-bash2");
    const dir = freshDir();
    run("start", { session_id: "env-bash2" }, { ZCODE_PROJECT_DIR: dir, SHELL: "C:\\Program Files\\Git\\usr\\bin\\bash.exe" });
    assert.equal(stateOf("env-bash2").envCache.shellIdKey, "bash");
    rmSync(dir, { recursive: true, force: true });
  });

  test("pwsh7 特征 PSModulePath 才判为 powershell", () => {
    const run = makeRunner("env-pwsh7");
    const dir = freshDir();
    run("start", { session_id: "env-pwsh7" }, { ZCODE_PROJECT_DIR: dir, SHELL: "", PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules" });
    assert.equal(stateOf("env-pwsh7").envCache.shellIdKey, "powershell");
    rmSync(dir, { recursive: true, force: true });
  });

  test("系统默认 PSModulePath + cmd → 不误判为 powershell", () => {
    const run = makeRunner("env-cmd2");
    const dir = freshDir();
    run("start", { session_id: "env-cmd2" }, { ZCODE_PROJECT_DIR: dir, SHELL: "", PSModulePath: "C:\\Program Files (x86)\\WindowsPowerShell\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules", ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" });
    const key = stateOf("env-cmd2").envCache.shellIdKey;
    assert.notEqual(key, "powershell");
    assert.equal(key, "cmd");
    rmSync(dir, { recursive: true, force: true });
  });

  test("误判场景下 Git Bash 管道命令不被平台规则拦截", () => {
    const run = makeRunner("env-nops");
    writeState("env-nops", { envCache: { os: "win32", shellIdKey: "cmd" }, envChecked: true });
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "grep -rn x . | head -5" } }).rc, 0);
  });
});

describe("DSH 版（v2.0.2，CS2 modding 适配）", () => {
  test("csproj/sln 修改列入风险文件备案", () => {
    const run = makeRunner("dsh-csproj");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "src/RailGuardLocaleSource.cs", limit: 5 }, tool_response: { content: "x" } }); // 先取证
    run("pre", { tool_name: "Edit", tool_input: { file_path: "E:/x/RailCapacityGuard.csproj" } });
    assert.ok(auditOf("dsh-csproj").includes("风险文件修改"));
    run("pre", { tool_name: "Edit", tool_input: { file_path: "E:/x/Mod.sln" } });
    assert.ok(auditOf("dsh-csproj").split("风险文件修改").length >= 3);
  });

  test("卷宗依赖声明在真实工作区生效（Game.dll 60天）", () => {
    const run = makeRunner("dsh-case");
    const dir = freshDir();
    mkdirSync(join(dir, ".ai"), { recursive: true });
    writeFileSync(join(dir, ".ai", "CASE_FILE.md"), `# 卷宗\n\n### 【二】项目依赖声明（人工填写，可覆盖自动 TTL）\n\n| 依赖名 | 版本 | 安装路径 | 更新频率 | 信任TTL | 备注 |\n|---|---|---|---|---|---|\n| 游戏本体 | 1.6.2f1 | D:/Steam/steamapps/common/Cities Skylines II/Cities2_Data/Managed | 稳定拖沓 | 60天 | 测试 |\n\n### 【三】侦查取证记录（插件自动追加）\n\n| 文件名 | 读取时间 | mtime | size | SHA-256 | 变更历史 | TTL | 验证方式 |\n|---|---|---|---|---|---|---|---|\n`);
    run("start", { session_id: "dsh-case" }, { ZCODE_PROJECT_DIR: dir });
    const s = stateOf("dsh-case");
    assert.equal(Object.keys(s.caseCache || {}).length, 0); // 空记录载入
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("正面指引（v2.2.0）", () => {
  test("推送闸（v2.4.0）：git push 并入高危特征库须实时审批；--dry-run 放行", () => {
    const run = makeRunner("push-gate");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    const r = run("pre", { tool_name: "Bash", tool_input: { command: "git push origin main" } });
    assert.equal(r.rc, 2);
    assert.ok(r.out.includes("高危命令闸"));
    assert.ok(r.out.includes("【高危申请】"));
    assert.ok(auditOf("push-gate").includes("high-risk-request"));
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "git push --dry-run origin main" } }).rc, 0);
  });

  test("污染核实闸：输出矛盾检出后首个改动类先拦一次，重试放行", () => {
    const run = makeRunner("pollute-gate");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    run("post", {
      tool_name: "Bash",
      tool_input: { command: "git ls-files | head -3" },
      tool_response: { content: "a.js\nb.js\nc.js\nd.js" },
    });
    const r = run("pre", { tool_name: "Edit", tool_input: { file_path: "r.txt", old_string: "a", new_string: "b" } });
    assert.equal(r.rc, 2);
    assert.ok(r.out.includes("污染核实"));
    assert.equal(run("pre", { tool_name: "Edit", tool_input: { file_path: "r.txt", old_string: "a", new_string: "b" } }).rc, 0);
  });

  test("改动前自动备份到 .ai/backup/（无 .git 工作区的回滚依据）", () => {
    const run = makeRunner("backup22");
    const dir = freshDir();
    const f = join(dir, "code.txt");
    writeFileSync(f, "v1");
    const r = run.in(dir);
    r("reset", { prompt: "看看情况" });
    r("post", { tool_name: "Read", tool_input: { file_path: f }, tool_response: { content: "v1" } });
    assert.equal(r("pre", { tool_name: "Edit", tool_input: { file_path: f, old_string: "v1", new_string: "v2" } }).rc, 0);
    const bd = join(dir, ".ai", "backup");
    const backups = readdirSync(bd).filter((x) => x.endsWith(".bak"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(bd, backups[0]), "utf8"), "v1");
    rmSync(dir, { recursive: true, force: true });
  });

  test("熔断出口提示经验固化（PATTERNS.md）", () => {
    const run = makeRunner("fuse-pattern");
    run("reset", { prompt: "看看情况" });
    const same = { tool_name: "Read", tool_input: { file_path: "same.txt", limit: 5 }, tool_response: { content: "一成不变" } };
    run("post", same); run("post", same); run("post", same);
    writeState("fuse-pattern", { fused: true });
    const r = run("pre", { tool_name: "Write", tool_input: { file_path: "new.py" } });
    assert.equal(r.rc, 2);
    assert.ok(r.out.includes("PATTERNS.md"));
  });
});

describe("子代理委派（v2.3.0）", () => {
  const WIDE_SEARCH = {
    tool_name: "Bash",
    tool_input: { command: "find . -name '*.js'" },
    tool_response: { content: "src/a.js\nsrc/b.js\nsrc/c.js\nlib/d.js\nlib/e.js\ntest/f.js\ntest/g.js\ndocs/h.js\nbin/i.js\nutil/j.js\nutil/k.js\nutil/l.js" },
  };

  test("场景A 全库搜索不委派 → 未尽职提醒 + KPI-5", () => {
    const run = makeRunner("del-A");
    run("reset", { prompt: "全量重构" });
    const r = run("post", WIDE_SEARCH);
    assert.ok(r.out.includes("未尽职"));
    assert.ok(r.out.includes("Agent"));
    assert.equal(stateOf("del-A").kpi, -5);
    assert.ok(auditOf("del-A").includes("kpi-not-delegated"));
  });

  test("场景B 子代理回传超长无格式 → 拒收要求压缩 + KPI-3，不占执行池", () => {
    const run = makeRunner("del-B");
    run("reset", { prompt: "看看情况" });
    const p = run("pre", { tool_name: "Agent", tool_input: { description: "调研依赖" } });
    assert.equal(p.rc, 0);
    const r = run("post", { tool_name: "Agent", tool_input: { description: "调研依赖" }, tool_response: { result: "x".repeat(300) } });
    assert.ok(r.out.includes("拒收"));
    assert.ok(r.out.includes("压缩"));
    const s = stateOf("del-B");
    assert.equal(s.kpi, -3);
    assert.equal(s.delegateUsed, 1); // 委托池已消耗
    assert.equal(s.effectiveCalls, 0); // 不占执行池
    assert.ok(auditOf("del-B").includes("delegate-summary-pollution"));
  });

  test("场景C 熔断期启动子代理 → 越权绕行 L4记档+L5降权", () => {
    const run = makeRunner("del-C");
    run("reset", { prompt: "看看情况" });
    writeState("del-C", { fused: true });
    const r = run("pre", { tool_name: "Agent", tool_input: { description: "绕过熔断去改文件" } });
    assert.equal(r.rc, 2);
    assert.ok(r.out.includes("越权绕行"));
    assert.ok(auditOf("del-C").includes("violation-subagent-usurp"));
    const s = stateOf("del-C");
    assert.equal(s.probation, true); // L5 降权
    assert.equal(s.violations, 5);
    assert.equal(s.fused, true);
  });

  test("场景D 正常委派 → 放行不计违规，摘要合格+3，强制场景+5", () => {
    const run = makeRunner("del-D");
    run("reset", { prompt: "全量重构" });
    const p = run("pre", { tool_name: "Agent", tool_input: { description: "全库搜索候选" } });
    assert.equal(p.rc, 0);
    let s = stateOf("del-D");
    assert.equal(s.delegateBudget, 19);
    assert.equal(s.delegateUsed, 1);
    assert.equal(s.delegated, true);
    assert.ok(auditOf("del-D").includes("delegate-used"));
    const good = run("post", {
      tool_name: "Agent",
      tool_input: { description: "全库搜索候选" },
      tool_response: { result: "【子代理摘要】\n任务：定位入口\n结果：main 在 a.js:1\n异常：无\n文件线索：a.js:1" },
    });
    assert.equal(good.out, ""); // 合格摘要不打扰
    s = stateOf("del-D");
    assert.equal(s.kpi, 3);
    assert.equal(s.effectiveCalls, 0);
    const wide = run("post", { ...WIDE_SEARCH, tool_input: { command: "find . -name '*.ts'" }, tool_response: { content: "x/a.ts\nx/b.ts\nx/c.ts\ny/d.ts\ny/e.ts\ny/f.ts\nz/g.ts\nz/h.ts\nz/i.ts\nw/j.ts\nw/k.ts\nw/l.ts" } });
    assert.equal(wide.out, ""); // 已委派 → 不提醒
    s = stateOf("del-D");
    assert.equal(s.kpi, 8); // +3 摘要 +5 委派
    assert.ok(auditOf("del-D").includes("kpi-delegated"));
  });

  test("委托池用尽拒绝委派，批示『追加委托额度』+10 后恢复", () => {
    const run = makeRunner("del-E");
    run("reset", { prompt: "看看情况" });
    writeState("del-E", { delegateBudget: 0, delegateUsed: 20 });
    const r = run("pre", { tool_name: "Agent", tool_input: { description: "第21次委派" } });
    assert.equal(r.rc, 2);
    assert.ok(r.out.includes("委托池用尽"));
    run("reset", { prompt: "追加委托额度" });
    assert.equal(stateOf("del-E").delegateBudget, 10); // 跨回合保留，批示 +10，不自动回满
    assert.equal(run("pre", { tool_name: "Agent", tool_input: { description: "第21次委派" } }).rc, 0);
    assert.equal(stateOf("del-E").delegateUsed, 21);
  });
});

describe("高危命令闸（v2.4.0）", () => {
  test("rm -rf ./dist：拦截 → 审批单格式校验 → y 放行本次（一次性）", () => {
    const run = makeRunner("hr1");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    const r1 = run("pre", { tool_name: "Bash", tool_input: { command: "rm -rf ./dist" } });
    assert.equal(r1.rc, 2);
    assert.ok(r1.out.includes("高危命令闸"));
    assert.ok(r1.out.includes("【高危申请】"));
    assert.equal(stateOf("hr1").highRiskCmd, "rm -rf ./dist");
    const s1 = run("stop", { response: "就这样了" });
    assert.ok(s1.out.includes("高危申请缺失")); // 收尾无审批单 → 打回
    assert.equal(
      run("stop", { response: "【高危申请】命令：`rm -rf ./dist` | 真实目的：清构建产物 | 影响范围：./dist | 回滚方案：可重建 | 允许执行？(y/n)" }).out,
      ""
    ); // 带标准审批单 → 放行收尾
    run("reset", { prompt: "y" }); // 人类实时批示 y
    assert.ok(auditOf("hr1").includes("high-risk-approved"));
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v3" } }); // 新回合照常先取证
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "rm -rf ./dist" } }).rc, 0); // 逐字一致 → 放行
    assert.ok(auditOf("hr1").includes("high-risk-executed"));
    assert.equal(stateOf("hr1").highRiskOk, false); // 放行本次（一次性）
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "rm -rf ./dist" } }).rc, 2); // 再跑要重新批
  });

  test("n 彻底阻断：被否决命令再试不得放行；常规命令零打扰", () => {
    const run = makeRunner("hr3");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "git reset --hard HEAD" } }).rc, 2);
    run("reset", { prompt: "n" });
    assert.ok(auditOf("hr3").includes("high-risk-rejected"));
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v4" } });
    const r = run("pre", { tool_name: "Bash", tool_input: { command: "git reset --hard HEAD" } });
    assert.equal(r.rc, 2);
    assert.ok(r.out.includes("已否决"));
    // 日常零打扰：普通 Read/Grep/Write 完全放行
    assert.equal(run("post", { tool_name: "Read", tool_input: { file_path: "r2.txt", limit: 5 }, tool_response: { content: "v5" } }).out, "");
    assert.equal(run("pre", { tool_name: "Grep", tool_input: { pattern: "x", path: ".", output_mode: "content", head_limit: 10 } }).out, "");
    assert.equal(run("pre", { tool_name: "Write", tool_input: { file_path: "new.txt", content: "hello" } }).out, "");
    assert.equal(stateOf("hr3").kpi, 0);
  });

  test("脚本包装绕行：写高危脚本须审批；被拒后当回合执行高危脚本 → 对抗审查 L4", () => {
    const run = makeRunner("wrap1");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    assert.equal(run("pre", { tool_name: "Write", tool_input: { file_path: "clean.sh", content: "echo hi" } }).rc, 0); // 干净脚本不设卡
    const d = run("pre", { tool_name: "Write", tool_input: { file_path: "delete.sh", content: "rm -rf ./dist" } });
    assert.equal(d.rc, 2); // 写高危脚本本身须审批
    assert.ok(d.out.includes("高危"));
    assert.ok(auditOf("wrap1").includes("high-risk-request"));
    writeState("wrap1", { scriptFiles: { "clean.sh": "d" }, highRiskDeniedThisTurn: true });
    const e = run("pre", { tool_name: "Bash", tool_input: { command: "bash clean.sh" } });
    assert.equal(e.rc, 2);
    assert.ok(auditOf("wrap1").includes("violation-wrap-bypass")); // 对抗审查 L4
  });

  test("预授权隔离：任务里的『上传github』只记 goal 不解锁；其他高危类同样须批", () => {
    const run = makeRunner("goal1");
    run("reset", { prompt: "优化结构然后最后上传github" });
    const s = stateOf("goal1");
    assert.equal(s.goalPush, true);
    assert.equal(s.highRiskOk, false);
    assert.ok(auditOf("goal1").includes("goal-preauth"));
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "git push origin main" } }).rc, 2); // 目标预授权不放行
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "npm publish" } }).rc, 2);
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "npm install -g typescript" } }).rc, 2);
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "curl -X POST https://api.example.com/hook" } }).rc, 2);
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "npm run build" } }).rc, 0); // 常规构建不设卡
    run("reset", { prompt: "这个问题我们先讨论一下别的，稍后再说" }); // 长句不构成执行级授权
    assert.equal(stateOf("goal1").highRiskOk, false);
  });
});

describe("极限场景（v2.4.1）", () => {
  test("特征库变体：git -C 传参推送 / rm --recursive / node rmSync 均被拦；普通 rm 自由", () => {
    const run = makeRunner("ext-var");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "git -C . push origin main" } }).rc, 2);
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "rm --recursive build" } }).rc, 2);
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "node -e \"require('fs').rmSync('x',{recursive:true})\"" } }).rc, 2);
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "mysql -e 'DELETE FROM users'" } }).rc, 2); // 无 where
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "mysql -e 'DELETE FROM users WHERE id=1'" } }).rc, 0); // 带 where 自由
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "rm single.txt" } }).rc, 0);
  });

  test("超大输入：80KB 命令行 5 秒内判定；2MB 工具响应触发追责而非崩溃", () => {
    const run = makeRunner("ext-big");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    const big = "git status // " + "pad ".repeat(20000);
    const t0 = Date.now();
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: big } }).rc, 0);
    assert.ok(Date.now() - t0 < 5000, "大命令行判定超时");
    const r = run("post", { tool_name: "Grep", tool_input: { pattern: "x", output_mode: "content", head_limit: 10 }, tool_response: { content: "x".repeat(2 * 1024 * 1024) } });
    assert.ok(r.out.includes("体积刺客"));
  });

  test("状态健壮性：损坏的 state JSON 自动降级默认值；奇异会话 ID 消毒", () => {
    const run = makeRunner("ext-corrupt");
    writeFileSync(join(tmpdir(), `focus-guard-ext-corrupt-${RUN}.json`), "{corrupted json!!");
    run("reset", { prompt: "看看情况" });
    assert.equal(stateOf("ext-corrupt").taskBudget, 10);
    const weird = "../x/..\\a b:c";
    run("reset", { session_id: weird, prompt: "看看情况" });
    const san = weird.replace(/[^A-Za-z0-9._-]/g, "_");
    const s = JSON.parse(readFileSync(join(tmpdir(), `focus-guard-${san}-${RUN}.json`), "utf8"));
    assert.equal(s.taskBudget, 10); // 消毒后正常读写，无路径穿越
  });

  test("中文路径：取证、改动前备份全链路可用", () => {
    const run = makeRunner("ext-cjk");
    const dir = freshDir();
    mkdirSync(join(dir, "中文目录"), { recursive: true });
    const f = join(dir, "中文目录", "测试文件.txt");
    writeFileSync(f, "内容v1");
    const r = run.in(dir);
    r("reset", { prompt: "看看情况" });
    r("post", { tool_name: "Read", tool_input: { file_path: f }, tool_response: { content: "内容v1" } });
    assert.equal(r("pre", { tool_name: "Edit", tool_input: { file_path: f, old_string: "内容v1", new_string: "内容v2" } }).rc, 0);
    const bd = join(dir, ".ai", "backup");
    const backups = readdirSync(bd, { recursive: true }).filter((x) => String(x).endsWith(".bak"));
    assert.ok(backups.length >= 1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("caseCache 上限裁剪：超过 200 条按取证时间淘汰最旧", () => {
    const run = makeRunner("ext-case");
    const dir = freshDir();
    const f = join(dir, "new.txt");
    writeFileSync(f, "n");
    const r = run.in(dir);
    r("reset", { prompt: "看看情况" });
    const cc = {};
    for (let i = 0; i < 205; i++) cc["f" + i + ".txt"] = { mtime: 1, size: 1, sha: "", gitDirty: null, readAt: i, changes: 0, lastChange: 0, ttlOverride: "", via: "mtime+size" };
    writeState("ext-case", { caseCache: cc });
    r("post", { tool_name: "Read", tool_input: { file_path: f }, tool_response: { content: "n" } });
    const s = stateOf("ext-case");
    assert.ok(Object.keys(s.caseCache).length <= 200);
    assert.equal(s.caseCache["f0.txt"], undefined);
    assert.ok(s.caseCache[join(dir, "new.txt").replace(/\\/g, "/")] || s.caseCache[f.replace(/\\/g, "/")]);
    rmSync(dir, { recursive: true, force: true });
  });
});
