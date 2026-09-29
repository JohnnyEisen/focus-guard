import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, mkdirSync, utimesSync } from "node:fs";
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
  return (mode, obj, env) => {
    try {
      return { rc: 0, out: execFileSync("node", [GUARD, mode], { input: JSON.stringify({ ...obj, session_id: `${obj.session_id || sid}-${RUN}` }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } }).trim() };
    } catch (e) {
      return { rc: e.status, out: ((e.stderr || "") + (e.stdout || "")).trim() };
    }
  };
}
const stateOf = (sid) => JSON.parse(readFileSync(join(tmpdir(), `focus-guard-${sid}-${RUN}.json`), "utf8"));
const auditOf = (sid) => readFileSync(join(tmpdir(), `focus-guard-${sid}-${RUN}-AUDIT.log`), "utf8");

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
    run("reset", { prompt: "关于绝境模式的说明文档里提到启动绝境模式时应当如何如何的一大段协议引用文本超过三十个字符" });
    assert.equal(stateOf("mercy").mercy, false);
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

describe("缓存利用（49条）", () => {
  test("同文件同 mtime 重复整读被拒；offset 续读放行；mtime 变更后放行", () => {
    const run = makeRunner("mtime");
    const dir = freshDir();
    const f = join(dir, "doc.txt");
    writeFileSync(f, "v1\n".repeat(10));
    run("reset", { prompt: "看看情况" });
    assert.equal(run("pre", { tool_name: "Read", tool_input: { file_path: f, limit: 5 } }).rc, 0); // 首读放行
    run("post", { tool_name: "Read", tool_input: { file_path: f, limit: 5 }, tool_response: { content: "v1" } }); // 记录 mtime
    const dup = run("pre", { tool_name: "Read", tool_input: { file_path: f } });
    assert.equal(dup.rc, 2);
    assert.ok(dup.out.includes("重复整读"));
    assert.equal(run("pre", { tool_name: "Read", tool_input: { file_path: f, offset: 5 } }).rc, 0); // 增量读放行
    const t = new Date(Date.now() + 5000);
    utimesSync(f, t, t);
    assert.equal(run("pre", { tool_name: "Read", tool_input: { file_path: f } }).rc, 0); // mtime 变更放行
    rmSync(dir, { recursive: true, force: true });
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
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } }); // turnCount=1, readSet=1
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
