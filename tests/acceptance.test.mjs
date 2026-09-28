import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
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
  return (mode, obj) => {
    try {
      return { rc: 0, out: execFileSync("node", [GUARD, mode], { input: JSON.stringify({ ...obj, session_id: `${obj.session_id || sid}-${RUN}` }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim() };
    } catch (e) {
      return { rc: e.status, out: ((e.stderr || "") + (e.stdout || "")).trim() };
    }
  };
}
const stateOf = (sid) => JSON.parse(readFileSync(join(tmpdir(), `focus-guard-${sid}-${RUN}.json`), "utf8"));

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
      const r = run("post", { tool_name: "Read", tool_input: { file_path: `f${i}.txt`, limit: 5 }, tool_response: { content: `v${i}` } });
      if (r.out.includes("续杯")) refills++;
    }
    assert.equal(refills, 3); // 10/20/30 三次续杯
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
    const r = run("post", { tool_name: "Read", tool_input: { file_path: "h.txt", limit: 5 }, tool_response: { content: "新" } });
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
