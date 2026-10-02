import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  // 无 ZCODE_PROJECT_DIR → 审计日志退回系统临时目录，测试间相互隔离。
  // 2.5.2：改用 spawnSync 同时捕获 stdout + stderr。此前用 execFileSync，rc=0 时只拿得到 stdout，
  // 于是"零打扰"断言（assert.equal(out, "")）看不见被放行的调用偷偷写 stderr 的干扰——
  // 而 token-bench 恰恰把 stdout+stderr 都算作模型可见开销，两把尺子不一致。
  const run = (mode, obj, env) => {
    const p = spawnSync("node", [GUARD, mode], {
      input: JSON.stringify({ ...obj, session_id: `${obj.session_id || sid}-${RUN}` }),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { rc: p.status, out: ((p.stdout || "") + (p.stderr || "")).trim() };
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

// 2.5.2：跑完清理本次运行在系统临时目录留下的状态/审计文件。
// 此前一次全量验收会在 %TEMP% 留 ~190 个文件，长年累积无上限。
after(() => {
  for (const f of readdirSync(tmpdir())) {
    if (f.startsWith("focus-guard-") && f.includes(RUN)) {
      try {
        rmSync(join(tmpdir(), f), { force: true });
      } catch {}
    }
  }
});

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

  test("postfail：失败调用计入无效调用并触发停滞熔断", () => {
    const run = makeRunner("postfail-x");
    run("reset", { prompt: "看看情况" });
    const fail = { tool_name: "Bash", tool_input: { command: "node missing-file.js" } };
    run("postfail", fail);
    assert.equal(stateOf("postfail-x").stalledStreak, 1);
    assert.equal(stateOf("postfail-x").ineffCalls, 1);
    run("postfail", fail);
    assert.equal(stateOf("postfail-x").stalledStreak, 2);
    run("postfail", fail);
    const s = stateOf("postfail-x");
    assert.equal(s.stalledStreak, 3);
    assert.equal(s.fused, true, "连续 3 次失败应判真失控熔断");
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

  test("熔断声明缺降级方案：只打回一次（防宿主强制续跑死循环）", () => {
    const run = makeRunner("fuse-oneshot");
    run("reset", { prompt: "看看情况" });
    writeState("fuse-oneshot", { fused: true });
    const first = run("stop", { response: "【熔断】无法通过现有资料定位核心问题" });
    assert.ok(first.out.includes("decision"), "首次应打回并要求三行降级方案");
    assert.equal(stateOf("fuse-oneshot").stopBlocked, true);
    const second = run("stop", { response: "【熔断】无法通过现有资料定位核心问题" });
    assert.equal(second.out, "", "同一回合不得反复打回（桥接无连败上限会死循环）");
  });

  test("熔断期不放行高危命令（L3 只读白名单不得成为免检通道）", () => {
    const run = makeRunner("fuse-highrisk");
    run("reset", { prompt: "看看情况" });
    writeState("fuse-highrisk", { fused: true });
    for (const c of ["npm publish", 'python -c "import shutil;shutil.rmtree(1)"', "reg add HKLM\\X /v y /d z", "diskpart"]) {
      const r = run("pre", { tool_name: "Bash", tool_input: { command: c } });
      assert.equal(r.rc, 2, `${c} 在熔断期必须被拒`);
      assert.ok(r.out.includes("熔断期·高危命令"), `${c} 应给出熔断期高危拒绝理由`);
    }
    assert.equal(run("pre", { tool_name: "Read", tool_input: { file_path: "x.txt", limit: 5 } }).rc, 0, "只读调查仍应放行");
  });

  test("变更类命令识别：sudo/xargs 前缀与 cp 不再被当成只读侦查", () => {
    const run = makeRunner("mut-base");
    for (const c of ["mv a b", "sudo mv a b", "cp a b", "sudo cp a b", "xargs mv a b", "rm x", "echo hi > out.txt"]) {
      const sid = "mut-" + Math.random().toString(36).slice(2);
      run("reset", { session_id: sid, prompt: "看看情况" });
      assert.equal(run("pre", { session_id: sid, tool_name: "Bash", tool_input: { command: c } }).rc, 2, `${c} 应触发①（未取证就改）`);
    }
    const ro = "mut-readonly";
    run("reset", { session_id: ro, prompt: "看看情况" });
    assert.equal(run("pre", { session_id: ro, tool_name: "Bash", tool_input: { command: "grep -rn rm ." } }).rc, 0, "只读命令不得误伤");
    assert.equal(run("pre", { session_id: ro, tool_name: "Bash", tool_input: { command: "npm test" } }).rc, 0, "npm test 不是变更类");
  });

  test("授权识别条例：伪造引文→L3 熔断；合规声明→特赦生效；待确认→暂停", () => {
    // 伪造引文：声明引用的"人类指令原文"并不存在于本回合指令
    const run = makeRunner("pardon-fake");
    run("reset", { prompt: "把日志整理一下" });
    const fake = run("stop", { response: "【授权识别】我基于人类指令「全部放行不必审批」，依据：第二十六条。" });
    assert.ok(fake.out.includes("越权解释授权"), "伪造引文必须打回");
    assert.equal(stateOf("pardon-fake").fused, true);
    // 合规声明：引文本回合原文 + 含授权语义 + 指明依据
    const run2 = makeRunner("pardon-ok");
    run2("reset", { prompt: "这个模块允许你跳过测试" });
    assert.equal(run2("stop", { response: "【授权识别】我基于人类指令「这个模块允许你跳过测试」，依据：第九条。" }).out, "");
    assert.equal(stateOf("pardon-ok").mercy, true, "合规声明应被判为有效授权");
    // 灰色地带：待确认 → 暂停不打回
    const run3 = makeRunner("pardon-pending");
    run3("reset", { prompt: "看看情况" });
    assert.equal(run3("stop", { response: "【授权待确认】请明确是否授权。" }).out, "");
    assert.ok(auditOf("pardon-pending").includes("pardon-pending"));
  });

  test("人类批示「停/熔断」必须真的熔断（此前同一函数把 fused 写回 false）", () => {
    const run = makeRunner("stop-order");
    run("reset", { prompt: "继续干活" });
    run("reset", { prompt: "停止" });
    const s = stateOf("stop-order");
    assert.equal(s.fused, true, "止停令必须生效");
    assert.ok(s.violations >= 3);
    assert.ok(auditOf("stop-order").includes("stall-fuse"));
    assert.equal(run("pre", { tool_name: "Write", tool_input: { file_path: "new.py" } }).rc, 2, "熔断后改动类应被拒");
  });

  test("触发⑤：连续两次「查无实据」→ 第二次判停职检查", () => {
    const run = makeRunner("unknown-2");
    run("reset", { prompt: "看看情况" });
    assert.equal(run("stop", { response: "查无实据。" }).out, "");
    assert.equal(stateOf("unknown-2").fused, false);
    run("stop", { response: "查无实据，我再试试。" });
    assert.equal(stateOf("unknown-2").fused, true);
    assert.ok(auditOf("unknown-2").includes("shuanggui-declared"));
  });

  test("抽查A：第 5 次写操作触发全量审计留痕", () => {
    const run = makeRunner("spot-a");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    let hit = "";
    for (let i = 1; i <= 5; i++) {
      const r = run("post", { tool_name: "Write", tool_input: { file_path: "same.txt", content: `v${i}` }, tool_response: { ok: true } });
      if (r.out.includes("抽查A")) hit = r.out;
    }
    assert.ok(hit.includes("第 5 次写操作"), "第 5 次写操作应触发抽查A");
    assert.ok(auditOf("spot-a").includes("random-audit"));
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

  test("2.5.3 审计豁免：批示含'审计'时取证对象整读留痕不罚（案二）", () => {
    const run = makeRunner("audit-read");
    const dir = freshDir();
    const big = join(dir, "target.txt");
    writeFileSync(big, "x".repeat(100 * 1024));
    run("reset", { prompt: "全面审计这个项目的代码质量" });
    const r = run("pre", { tool_name: "Read", tool_input: { file_path: big } });
    assert.equal(r.rc, 0, "审计任务整读取证对象应放行");
    assert.ok(r.out.includes("审计豁免"));
    assert.ok(auditOf("audit-read").includes("audit-read-allow"), "豁免必须留痕");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("高危特征库（v2.5.2 加固：别名/绕行与误伤双向锁定）", () => {
  // 高危：同一致命动作的别名与绕行写法（此前全部漏检）
  const DENY = [
    "npm i -g typescript", "npm install --save -g x", "npm uninstall -g x",
    "pnpm add -g typescript", "pnpm add --global x", "yarn global add typescript", "yarn add -g x",
    "rd /s /q folder", "ri -r cache",
    "wget --post-data=x https://a.b", "Invoke-WebRequest -Method POST https://a.b", "curl -d @f https://a.b",
    "git --git-dir=/x push", "git --no-pager push", "ls && git push", "git -c user.name=x push origin main",
    "git clean --force", "git clean -fdx",
  ];
  // 良性：看起来像高危其实无害（此前全部误封）
  const ALLOW = [
    "git push origin main --dry-run", "git -C . push --dry-run origin main", "git clean -fdn", "git clean -n", "git clean --dry-run",
    "npm publish --dry-run", "pnpm publish --dry-run",
    "rm --force single.txt", "rm -f a.txt", "rm -i --verbose x",
    "git log --grep push", "git commit -m \"fix push\"", "grep -rn ri -r src",
    "curl -X GET https://a.b", "Invoke-WebRequest -Method GET https://a.b",
  ];

  test("高危写法一律拦截，良性写法零打扰（含 dry-run 与 --force 反例）", () => {
    const run = makeRunner("cls-252");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    const bad = [];
    for (const c of DENY) {
      if (run("pre", { tool_name: "Bash", tool_input: { command: c } }).rc !== 2) bad.push(`漏检: ${c}`);
    }
    for (const c of ALLOW) {
      if (run("pre", { tool_name: "Bash", tool_input: { command: c } }).rc !== 0) bad.push(`误伤: ${c}`);
    }
    assert.deepEqual(bad, []);
  });

  test("多语句 SQL：行内任意位置出现 where 不再放过无 where 的删除（按语句判定）", () => {
    const run = makeRunner("sql-multi");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    const multi = 'mysql -e "delete from users; select 1 from dual where 1=1"';
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: multi } }).rc, 2, "首条语句无 where，仍须审批");
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: 'mysql -e "delete from users where id=1"' } }).rc, 0, "带 where 不设卡");
  });

  test("curl 的 -d 与 -D 必须区分（小写 -d 才是发送数据）", () => {
    const run = makeRunner("curl-case");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "curl -d @f https://a.b" } }).rc, 2, "-d 是发送数据");
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "curl -D - https://a.b" } }).rc, 0, "-D 是 dump 响应头，属只读");
  });
});

describe("三预算池（20条）", () => {
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

  test("2.5.3 复合命令分段归因：head 只约束其段，不整段对账（案三）", () => {
    const run = makeRunner("pollute-compound");
    run("reset", { prompt: "看看情况" });
    const r = run("post", {
      tool_name: "Bash",
      tool_input: { command: "echo header && git ls-files | head -3 && echo footer" },
      tool_response: { content: "header\na.js\nb.js\nc.js\nd.js\nfooter" },
    });
    assert.equal(r.out, "", "复合命令输出无法按段归因，不得整段对账误报");
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

  test("路径查重判定（2.5.1）：git ls-files 裸相对路径重复仍检出；git 警告散文行不误报", () => {
    const run = makeRunner("duppath-bare");
    run("reset", { prompt: "看看情况" });
    const bare = run("post", {
      tool_name: "Bash",
      tool_input: { command: "git ls-files" },
      tool_response: { content: "hooks/guard.mjs\ndocs/RULES.md\nhooks/guard.mjs" }, // 无 ./ 前缀
    });
    assert.ok(bare.out.includes("上下文污染"), "裸相对路径重复必须检出（旧判定只认以路径开头的行，会漏检）");
    run("reset", { prompt: "看看情况" });
    const prose = run("post", {
      tool_name: "Bash",
      tool_input: { command: "git ls-files" },
      tool_response: {
        content:
          "warning: in the working copy of 'a/b.txt', LF will be replaced by CRLF\n" +
          "warning: in the working copy of 'a/b.txt', LF will be replaced by CRLF",
      },
    });
    assert.equal(prose.out, "", "git 警告散文行首 token 不是路径，不得误报重复路径");
  });
});

describe("回合与部署卫生", () => {
  test("2.5.3 61条 陈旧清理：30 天未动的临时状态文件在会话启动时被清扫", () => {
    const stalePath = join(tmpdir(), `focus-guard-staletest-${RUN}.json`);
    writeFileSync(stalePath, "{}");
    const old = new Date(Date.now() - 40 * 86400e3);
    utimesSync(stalePath, old, old); // 伪造为 40 天前未动
    const run = makeRunner("stale-clean");
    run("start", { session_id: "stale-clean" });
    assert.equal(existsSync(stalePath), false, "30 天未动的残留应被清扫");
    assert.ok(existsSync(join(tmpdir(), `focus-guard-stale-clean-${RUN}.json`)), "当前会话状态不受影响");
  });
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
    assert.ok(s.envCache, "envCache 非空即视为已检测（2.5.1 起取消冗余 envChecked 布尔）");
    assert.equal(s.envCache.os, process.platform);
    assert.ok(s.envCache.shellIdKey);
    assert.ok(caseFileOf(dir).includes("Shell=")); // 2.5.1 卷宗【一】环境声明落卷
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

  test("2.5.3 卷宗继承指纹只提示不拦：跨会话首读放行，会话内重读仍拦", () => {
    const run = makeRunner("case-inherit");
    const dir = freshDir();
    const f = join(dir, "doc.txt");
    writeFileSync(f, "v1\n".repeat(10));
    const st = statSync(f);
    const recent = new Date(Date.now() - 60e3).toISOString(); // 1 分钟前"别的会话"取证，TTL 4h 未超
    mkdirSync(join(dir, ".ai"), { recursive: true });
    writeFileSync(
      join(dir, ".ai", "CASE_FILE.md"),
      `# 卷宗\n\n### 【三】侦查取证记录（插件自动追加）\n\n| 文件名 | 读取时间 | mtime | size | SHA-256 | 变更历史 | TTL | 验证方式 |\n|---|---|---|---|---|---|---|---|\n| ${f.replace(/\\/g, "/")} | ${recent} | ${st.mtimeMs} | ${st.size} | - | n=0; last=- | | mtime+size |\n`
    );
    const r = run.in(dir);
    r("start", { session_id: "case-inherit" }, { ZCODE_PROJECT_DIR: dir }); // 继承卷宗指纹
    const first = r("pre", { tool_name: "Read", tool_input: { file_path: f } });
    assert.equal(first.rc, 0, "跨会话首读必须放行（案一：内容不在本会话上下文，拦截=阻断取证）");
    assert.ok(first.out.includes("本会话"), "应有继承提示");
    r("post", { tool_name: "Read", tool_input: { file_path: f }, tool_response: { content: "v1" } }); // 本会话真读
    const dup = r("pre", { tool_name: "Read", tool_input: { file_path: f } });
    assert.equal(dup.rc, 2, "会话内重读仍应免重读拦截");
    assert.ok(dup.out.includes("免重读"));
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
    assert.equal(dep.rc, 0); // 2.5.3：卷宗继承指纹只提示不拦（案一），跨会话首读放行
    assert.ok(dep.out.includes("依赖声明"), "提示应注明 TTL 来源为依赖声明（60天 覆盖自适应，覆盖关系仍生效）");
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
    writeState("plat-mac", { envCache: { os: "darwin", shellIdKey: "bash" } });
    // sed -i 属变更类（2.5.2 纳入触发①判定），故先取证隔离触发①，只验证平台规则本身
    run("post", { tool_name: "Read", tool_input: { file_path: "f.txt", limit: 5 }, tool_response: { content: "v" } });
    for (const [cmd, hint] of [["sed -i s/a/b/ f.txt", "sed -i"], ["grep -P '\\d' f.txt", "-P"], ["readlink -f ./x", "readlink"]]) {
      const r = run("pre", { tool_name: "Bash", tool_input: { command: cmd } });
      assert.equal(r.rc, 2, `${cmd} 应被平台规则拒绝（不能只检查提示文案）`);
      assert.ok(r.out.includes(hint));
    }
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

  test("机器级 PowerShell 模块路径（不带版本号）不再误判为 PowerShell 会话", () => {
    const run = makeRunner("env-machine-ps");
    const dir = freshDir();
    run("start", { session_id: "env-machine-ps" }, {
      ZCODE_PROJECT_DIR: dir,
      SHELL: "",
      PSModulePath: "C:\\Program Files\\PowerShell\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules",
    });
    assert.notEqual(stateOf("env-machine-ps").envCache.shellIdKey, "powershell", "仅凭机器级模块路径不得判定为 PowerShell 会话");
    rmSync(dir, { recursive: true, force: true });
  });

  test("reset 探测到 shell 变化 → 重检环境并留痕（此前该分支无覆盖）", () => {
    const run = makeRunner("env-switch");
    const dir = freshDir();
    run("start", { session_id: "env-switch" }, { ZCODE_PROJECT_DIR: dir, SHELL: "/bin/bash" });
    const before = stateOf("env-switch").envCache.shellIdKey;
    assert.equal(before, "bash");
    run("reset", { session_id: "env-switch", prompt: "看看情况" }, { ZCODE_PROJECT_DIR: dir, SHELL: "/bin/zsh" });
    assert.equal(stateOf("env-switch").envCache.shellIdKey, "zsh", "shell 变化必须触发重检");
    assert.ok(readFileSync(join(dir, ".focus-guard", "AUDIT.log"), "utf8").includes("env-redetect"));
    rmSync(dir, { recursive: true, force: true });
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

  test("敏感文件不落明文备份：.env / 私钥跳过并留痕，普通文件照常备份", () => {
    const run = makeRunner("backup-secret");
    const dir = freshDir();
    const secret = join(dir, ".env");
    const key = join(dir, "server.pem");
    const normal = join(dir, "app.js");
    writeFileSync(secret, "TOKEN=s3cret");
    writeFileSync(key, "-----BEGIN PRIVATE KEY-----");
    writeFileSync(normal, "console.log(1)");
    const r = run.in(dir);
    r("reset", { prompt: "看看情况" });
    for (const f of [secret, key, normal]) {
      r("post", { tool_name: "Read", tool_input: { file_path: f }, tool_response: { content: "x" } });
      r("pre", { tool_name: "Edit", tool_input: { file_path: f, old_string: "x", new_string: "y" } });
    }
    const names = readdirSync(join(dir, ".ai", "backup"), { recursive: true }).map(String);
    assert.ok(names.some((n) => n.includes("app.js")), "普通文件应照常备份");
    assert.ok(!names.some((n) => n.includes(".env")), "敏感文件不得落明文副本");
    assert.ok(!names.some((n) => n.includes("server.pem")), "私钥不得落明文副本");
    assert.ok(readFileSync(join(dir, ".focus-guard", "AUDIT.log"), "utf8").includes("backup-skip-secret"));
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

  test("委托池用尽拒绝委派；批示『追加额度』+10 恢复（旧称『追加委托额度』同样生效）", () => {
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

  test("KPI 跌破 -10 只提醒一次（kpi-low 不刷屏），回升后再跌破可重报", () => {
    const run = makeRunner("kpi-low");
    run("reset", { prompt: "看看情况" });
    writeState("kpi-low", { kpi: -15 });
    run("stop", { response: "根据 r1.txt:5 结论成立" });
    run("stop", { response: "根据 r1.txt:5 结论成立" });
    const lowHits = () => auditOf("kpi-low").split("\n").filter((l) => l.includes('"kpi-low"')).length;
    assert.equal(lowHits(), 1, "同一阈值区间内不得每次收尾重复告警");
    assert.equal(stateOf("kpi-low").kpiLowReported, true);
    writeState("kpi-low", { kpi: 0 }); // KPI 回升
    run("stop", { response: "根据 r1.txt:5 结论成立" });
    assert.equal(stateOf("kpi-low").kpiLowReported, false);
    writeState("kpi-low", { kpi: -12 }); // 再次跌破
    run("stop", { response: "根据 r1.txt:5 结论成立" });
    assert.equal(lowHits(), 2);
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

  test("超长命令（>300 字符）的 y/n 仍生效（比对用全量哈希，不受展示截断影响）", () => {
    const long = "rm -rf /tmp/" + "a".repeat(400);
    const run = makeRunner("hr-long");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: long } }).rc, 2);
    assert.ok(stateOf("hr-long").highRiskCmd.length <= 300, "展示文本应截断");
    assert.ok(stateOf("hr-long").highRiskKey.length > 0, "比对键必须存在");
    run("reset", { prompt: "y" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r2.txt", limit: 5 }, tool_response: { content: "v2" } }); // 新回合照常先取证
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: long } }).rc, 0, "y 必须能放行超长命令");

    const run2 = makeRunner("hr-long-n");
    run2("reset", { prompt: "看看情况" });
    run2("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    assert.equal(run2("pre", { tool_name: "Bash", tool_input: { command: long } }).rc, 2);
    run2("reset", { prompt: "n" });
    run2("post", { tool_name: "Read", tool_input: { file_path: "r2.txt", limit: 5 }, tool_response: { content: "v2" } });
    const blocked = run2("pre", { tool_name: "Bash", tool_input: { command: long } });
    assert.equal(blocked.rc, 2);
    assert.ok(blocked.out.includes("已否决"), "n 必须能彻底阻断超长命令");
  });

  test("中文批示词生效（同意/批准 放行；不/拒绝 彻底阻断）", () => {
    const cases = [["同意", true], ["批准", true], ["y", true], ["不", false], ["拒绝", false], ["n", false]];
    let i = 0;
    for (const [reply, expectOk] of cases) {
      const sid = `cn-${expectOk ? "y" : "n"}-${i++}`;
      const run = makeRunner(sid);
      run("reset", { prompt: "看看情况" });
      run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
      assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "git push" } }).rc, 2);
      run("reset", { prompt: reply });
      const s = stateOf(sid);
      if (expectOk) assert.equal(s.highRiskOk, true, `「${reply}」应构成放行批示`);
      else assert.equal(Object.keys(s.rejectedCmds || {}).length, 1, `「${reply}」应构成彻底阻断`);
    }
  });

  test("高危拒绝后收尾缺审批单：只打回一次（防无限重复打回）", () => {
    const run = makeRunner("hr-form-once");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    run("pre", { tool_name: "Bash", tool_input: { command: "git push" } });
    const first = run("stop", { response: "已完成本地提交。" });
    assert.ok(first.out.includes("高危申请缺失"), "首次应打回补审批单");
    assert.equal(stateOf("hr-form-once").stopBlocked, true);
    const second = run("stop", { response: "已完成本地提交。" });
    assert.equal(second.out, "", "同一回合不得反复打回");
  });

  test("脚本包装防护端到端：post 真实登记危险脚本 → 执行被拦（不靠预置 state）", () => {
    const run = makeRunner("wrap-e2e");
    run("reset", { prompt: "看看情况" });
    run("post", { tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } });
    // 干净脚本：写入放行，post 登记为 c
    assert.equal(run("pre", { tool_name: "Write", tool_input: { file_path: "ok.sh", content: "echo hi" } }).rc, 0);
    run("post", { tool_name: "Write", tool_input: { file_path: "ok.sh", content: "echo hi" }, tool_response: { ok: true } });
    assert.equal(stateOf("wrap-e2e").scriptFiles["ok.sh"], "c");
    // 危险脚本：写入本身被拦；post 走真实路径登记为 d
    assert.equal(run("pre", { tool_name: "Write", tool_input: { file_path: "danger.sh", content: "rm -rf ./dist" } }).rc, 2);
    run("post", { tool_name: "Write", tool_input: { file_path: "danger.sh", content: "rm -rf ./dist" }, tool_response: { ok: true } });
    assert.equal(stateOf("wrap-e2e").scriptFiles["danger.sh"], "d", "危险脚本必须被登记为 d（此前该登记路径无任何测试）");
    // 执行：危险脚本被拦，干净脚本放行
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "bash danger.sh" } }).rc, 2);
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "bash ok.sh" } }).rc, 0);
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
    assert.equal(run("pre", { tool_name: "Bash", tool_input: { command: "mysql -e 'DROP DATABASE app'" } }).rc, 2);
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

  test("状态健壮性：损坏的 state JSON 自动降级默认值；奇异会话 ID 消毒且不撞名", () => {
    const run = makeRunner("ext-corrupt");
    writeFileSync(join(tmpdir(), `focus-guard-ext-corrupt-${RUN}.json`), "{corrupted json!!");
    run("reset", { prompt: "看看情况" });
    const d = stateOf("ext-corrupt");
    assert.equal(d.taskBudget, 10);
    // 只断言 taskBudget 是无效的：reset 会用 Math.max(10,0,10) 重算出来，默认表被掏空也能过。
    // 这里锁定只有默认表才提供的字段。
    assert.equal(d.delegateBudget, 20, "默认表必须完整（委托池默认额度）");
    assert.equal(d.invCap, 15, "默认表必须完整（侦查池额度）");
    assert.deepEqual(d.rejectedCmds, {}, "默认表必须完整（已否决命令表）");
    const weird = "../x/..\\a b:c";
    run("reset", { session_id: weird, prompt: "看看情况" });
    const san = weird.replace(/[^A-Za-z0-9._-]/g, "_");
    const found = readdirSync(tmpdir()).filter((f) => f.startsWith(`focus-guard-${san}`) && f.includes(RUN) && f.endsWith(".json"));
    assert.equal(found.length, 1, "消毒后的状态文件应恰好一个");
    assert.equal(JSON.parse(readFileSync(join(tmpdir(), found[0]), "utf8")).taskBudget, 10); // 无路径穿越，正常读写
    // 2.5.2：消毒撞名——proj/a 与 proj_a 曾是同一个状态文件，熔断/审批/预算会跨会话串味
    run("reset", { session_id: "proj/a", prompt: "看看情况" });
    run("reset", { session_id: "proj_a", prompt: "看看情况" });
    const a = readdirSync(tmpdir()).filter((f) => f.startsWith("focus-guard-proj_a") && f.includes(RUN) && f.endsWith(".json"));
    assert.equal(a.length, 2, "两个不同会话 ID 必须落成两个状态文件");
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

  test("DSH 桥接签名：Stop 无收尾文本时锚点/审批单打回降级审计（防桥接强制续跑死循环），ZCode 载荷不受影响", () => {
    const run = makeRunner("dsh-stop");
    run("reset", { prompt: "看看情况" });
    for (let i = 1; i <= 6; i++) run("post", { tool_name: "Read", tool_input: { file_path: `f${i}.txt`, limit: 5 }, tool_response: { content: `v${i}` } });
    const r = run("stop", { transcript_path: "", stop_hook_active: false }); // DSH 桥接签名
    assert.equal(r.out, "");
    writeState("dsh-stop", { highRiskDeniedThisTurn: true });
    assert.equal(run("stop", { transcript_path: "", stop_hook_active: false }).out, "");
    assert.ok(auditOf("dsh-stop").includes("dsh-stop-observe"));
    run("reset", { prompt: "看看情况" });
    for (let i = 1; i <= 6; i++) run("post", { tool_name: "Read", tool_input: { file_path: `g${i}.txt`, limit: 5 }, tool_response: { content: `w${i}` } });
    assert.ok(run("stop", { response: "就这样了" }).out.includes("证据锚点")); // ZCode 载荷照常打回
  });

  test(">200KB 文件：指纹退回 mtime+size+git（SHA 不参与，git 不可用时仅 mtime+size）", () => {
    const run = makeRunner("big-fp");
    const dir = freshDir();
    const big = join(dir, "big.dat");
    writeFileSync(big, "A".repeat(300 * 1024));
    const r = run.in(dir);
    r("reset", { prompt: "看看情况" });
    r("post", { tool_name: "Read", tool_input: { file_path: big }, tool_response: { content: "A" } });
    const rec = Object.values(stateOf("big-fp").caseCache)[0];
    assert.equal(rec.sha, "", ">200KB 不计算 SHA");
    assert.equal(rec.via, "mtime+size+git");
    assert.ok([null, 0, 1].includes(rec.gitDirty)); // git 不可用时为 null（降级为 mtime+size）
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("工程自检（防版本与文档漂移）", () => {
  const ROOT = (p) => fileURLToPath(new URL(p, import.meta.url));

  test("版本一致性：五处清单 + ENGINE_VERSION + 引擎头注释完全相同", () => {
    const guard = readFileSync(GUARD, "utf8");
    const engine = (guard.match(/ENGINE_VERSION = "([^"]+)"/) || [])[1];
    const header = (guard.match(/focus-guard 护栏脚本 v(\d+\.\d+\.\d+)/) || [])[1];
    assert.ok(engine, "未找到 ENGINE_VERSION");
    assert.equal(header, engine, "引擎头注释版本与 ENGINE_VERSION 漂移");
    const manifests = [
      "../package.json",
      "../marketplace.json",
      "../.zcode-plugin/plugin.json",
      "../.claude-plugin/plugin.json",
      "../.claude-plugin/marketplace.json",
    ];
    for (const rel of manifests) {
      const j = JSON.parse(readFileSync(ROOT(rel), "utf8"));
      const v = j.version || (j.plugins && j.plugins[0] && j.plugins[0].version);
      assert.equal(v, engine, `${rel} 版本与引擎 ${engine} 不一致`);
    }
  });

  test("清单说明互不重复：五处 description 各自独立（防镜像漂移）", () => {
    const files = [
      "../package.json",
      "../marketplace.json",
      "../.zcode-plugin/plugin.json",
      "../.claude-plugin/plugin.json",
      "../.claude-plugin/marketplace.json",
    ];
    const descs = files.map((rel) => {
      const j = JSON.parse(readFileSync(ROOT(rel), "utf8"));
      return String(j.description || (j.plugins && j.plugins[0] && j.plugins[0].description) || "").trim();
    });
    for (let i = 0; i < files.length; i++) assert.ok(descs[i].length > 0, `${files[i]} description 不得为空`);
    assert.equal(new Set(descs).size, descs.length, "五处清单 description 必须互不相同（检测到镜像复制）");
  });

  test("文档-实现口径对齐：术语 / 43条处置 / 58条阶段 / 未机械化清单 / 安装判据", () => {
    const rules = readFileSync(ROOT("../docs/RULES.md"), "utf8");
    const skill = readFileSync(ROOT("../skills/focus-thinking/SKILL.md"), "utf8");
    const guard = readFileSync(GUARD, "utf8");
    // 术语统一：映射表不再要求【请示报告】，引擎只认【授权识别】
    assert.ok(!rules.includes("须输出【请示报告】"), "法条映射表仍残留旧术语【请示报告】");
    assert.ok(rules.includes("【授权识别】") && guard.includes("PARDON_DECL_RE = /【授权识别】/"));
    // 43条：法条处置与引擎一致（记档后清理，而非"停止执行并报告"）
    assert.ok(rules.includes("残留则记录在案并清理"));
    assert.ok(guard.includes('"residue-check"'));
    // 58条：映射表落在 PostToolUse，Stop 表不再重复
    const post = rules.slice(rules.indexOf("### PostToolUse 阶段"), rules.indexOf("### Stop 阶段"));
    const stop = rules.slice(rules.indexOf("### Stop 阶段"), rules.indexOf("### Reset 阶段"));
    assert.ok(post.includes("第五十八条"), "58条映射应位于 PostToolUse 阶段");
    assert.ok(!stop.includes("第五十八条"), "Stop 阶段不应再列 58条");
    // 追加额度口径三处统一（引擎/技能/README 同为三池各+10）
    assert.ok(skill.includes("执行/侦查/委托三池各+10"));
    // 推送语义统一：法条不再是"由领导执行"，而是"y 放行本次"
    assert.ok(!rules.includes("推送远端属对外发布行为，由领导执行"), "第七十五条仍保留 2.2.0 旧推送口径");
    assert.ok(rules.includes("经领导回复 y 放行后方可执行"));
    // 空头条款透明化：未机械化清单必须存在，且已列入"日志/缓存无清理"这条实情
    assert.ok(rules.includes("未机械化条款清单"));
    assert.ok(rules.includes("第六十一条"), "未机械化清单须包含第六十一条（会话状态无自动清理）");
    // 注入体量不得残留旧实测值（411 字；393 字是拼接 FUSE_PHRASE 前的错误统计）
    assert.ok(!rules.includes("393 字"), "RULES 常驻注入实测值未同步（应为 411 字）");
    // 跨文档判据：INSTALL 的"验证生效"字符串必须逐字取自引擎真实注入，
    // 否则用户照文档验证会得出"没装上"的错误结论（此前文案是"…v3.0 强制生效：…"，引擎里没有这段）
    const runs = makeRunner("doc-criterion");
    const dir = freshDir();
    const out = runs("start", { session_id: "doc-criterion" }, { ZCODE_PROJECT_DIR: dir }).out;
    const injected = JSON.parse(out).hookSpecificOutput.additionalContext.split("\n【")[0];
    const install = readFileSync(ROOT("../INSTALL.md"), "utf8");
    assert.ok(install.includes(injected.slice(0, 40)), "INSTALL 的验证判据必须逐字取自真实注入");
    assert.ok(!install.includes("强制生效"), "INSTALL 不得残留不存在的注入文案");
    rmSync(dir, { recursive: true, force: true });
  });

  test("hooks.json 六条钩子与引擎实现一一对应（防注册名漂移）", () => {
    const hooks = JSON.parse(readFileSync(ROOT("../hooks/hooks.json"), "utf8"));
    const guard = readFileSync(GUARD, "utf8");
    assert.deepEqual(Object.keys(hooks.hooks), [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
    ]);
    for (const [ev, groups] of Object.entries(hooks.hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          assert.equal(h.type, "command", `${ev} 钩子类型应为 command`);
          const m = String(h.command).match(/guard\.mjs"?\s+(\w+)/);
          assert.ok(m, `${ev} 的命令未指向 guard.mjs 子命令`);
          assert.ok(guard.includes(`mode === "${m[1]}"`), `${ev} -> mode "${m[1]}" 引擎无实现`);
        }
      }
    }
  });

  test("RULES 第四部分 = 引擎真实注入文本（逐字镜像，防文档失真）", () => {
    const run = makeRunner("inject-mirror");
    const dir = freshDir();
    const out = run("start", { session_id: "inject-mirror" }, { ZCODE_PROJECT_DIR: dir }).out;
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    const injected = ctx.split("\n【")[0]; // 引擎在常驻注入后可能追加巡视/版本告警段
    assert.ok(injected.length > 200, "注入文本提取失败");
    assert.ok(readFileSync(ROOT("../docs/RULES.md"), "utf8").includes(injected), "RULES 第四部分与真实注入文本不一致");
    rmSync(dir, { recursive: true, force: true });
  });

  test("会话状态原子落盘：不遗留 .tmp 残片，状态可解析", () => {
    const run = makeRunner("atomic-state");
    run("reset", { prompt: "看看情况" });
    for (let i = 0; i < 5; i++) {
      run("post", { tool_name: "Read", tool_input: { file_path: `f${i}.txt`, limit: 5 }, tool_response: { content: `v${i}` } });
    }
    const leftovers = readdirSync(tmpdir()).filter((f) => f.startsWith(`focus-guard-atomic-state-${RUN}`) && f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "原子落盘不应遗留 .tmp 残片");
    assert.equal(stateOf("atomic-state").turnCount, 5);
  });

  test("部署漂移核验：注册表/市场源与引擎不一致 → 注入警告并留痕（此前该分支无覆盖）", () => {
    const run = makeRunner("deploy-drift");
    const dir = freshDir();
    const home = freshDir();
    mkdirSync(join(home, ".zcode", "cli", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".zcode", "cli", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 1, plugins: [{ id: "focus-guard@x", installPath: join(home, "cache", "focus-guard", "1.0.0") }] })
    );
    mkdirSync(join(home, ".zcode", "workspace", "default", "plugins", "focus-guard"), { recursive: true });
    writeFileSync(
      join(home, ".zcode", "workspace", "default", "plugins", "focus-guard", "marketplace.json"),
      JSON.stringify({ version: "1.2.0" })
    );
    const r = run("start", { session_id: "deploy-drift" }, { ZCODE_PROJECT_DIR: dir, USERPROFILE: home, HOME: home });
    assert.ok(r.out.includes("部署版本核验"), "应注入部署漂移警告");
    assert.ok(readFileSync(join(dir, ".focus-guard", "AUDIT.log"), "utf8").includes("deploy-mismatch"));
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
});
