#!/usr/bin/env node
// token-bench：测量护栏事件流中"模型可见输出"的体量（stdout=block 注入 / stderr=拒绝注入）。
// AUDIT.log 与卷宗写盘不进模型上下文，不计入。字符数按 1 token≈1.5 中文字符（区间 1.2~2.0）折算。
// 用法：node tests/token-bench.mjs <引擎A.mjs> [引擎B.mjs]   （B 为对照基线时输出对比表）
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const engines = process.argv.slice(2);
if (!engines.length) {
  console.error("用法: node tests/token-bench.mjs <基线guard.mjs> [优化后guard.mjs]");
  process.exit(1);
}
const RUN = `${process.pid}-${Date.now()}`;

function call(engine, mode, obj, env = {}) {
  const input = JSON.stringify({ ...obj, session_id: `${obj.session_id}-${RUN}` });
  let out = "", err = "";
  try {
    out = execFileSync("node", [engine, mode], { input, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    out = e.stdout || "";
    err = e.stderr || "";
  }
  const text = out + err;
  return { text, chars: text.length, bytes: Buffer.byteLength(text) };
}

const stateOf = (sid) => join(tmpdir(), `focus-guard-${sid}-${RUN}.json`);
const clear = (sid) => rmSync(stateOf(sid), { force: true });
const seed = (sid, patch) => writeFileSync(stateOf(sid), JSON.stringify({ ...JSON.parse(readFileSync(stateOf(sid), "utf8")), ...patch }));

const fixtures = join(tmpdir(), `fg-bench-${RUN}`);
mkdirSync(fixtures, { recursive: true });
const bigFile = join(fixtures, "big.txt");
writeFileSync(bigFile, "x".repeat(100 * 1024));
const blindTarget = join(fixtures, "blind.txt");
writeFileSync(blindTarget, "old content");
const docFile = join(fixtures, "doc.txt");
writeFileSync(docFile, "v1\n".repeat(20));
const WIDE = "src/a.js\nsrc/b.js\nsrc/c.js\nlib/d.js\nlib/e.js\ntest/f.js\ntest/g.js\ndocs/h.js\nbin/i.js\nutil/j.js\nutil/k.js\nutil/l.js";

// 每场景：w=典型长会话出现次数；filter=只统计匹配该特征的输出（剔除同场景噪声）
const SCENARIOS = [
  { id: "start", w: 1, note: "SessionStart 常驻注入 ×1", run: (e) => {
    clear("b-start");
    return [call(e, "start", { session_id: "b-start", hook_event_name: "SessionStart" }, { ZCODE_PROJECT_DIR: fixtures })];
  } },
  { id: "dedup", w: 10, n: 10, note: "卷宗免重读放行 ×10", run: (e) => {
    clear("b-dedup");
    const o = [call(e, "reset", { session_id: "b-dedup", prompt: "看看情况" })];
    o.push(call(e, "post", { session_id: "b-dedup", tool_name: "Read", tool_input: { file_path: docFile }, tool_response: { content: "v1" } }));
    for (let i = 0; i < 10; i++) o.push(call(e, "pre", { session_id: "b-dedup", tool_name: "Read", tool_input: { file_path: docFile } }));
    return o;
  } },
  { id: "noinv", w: 2, n: 2, note: "触发①未取证就改 ×2", run: (e) => {
    const o = [];
    for (let i = 0; i < 2; i++) {
      clear("b-noinv");
      o.push(call(e, "reset", { session_id: "b-noinv", prompt: "看看情况" }));
      o.push(call(e, "pre", { session_id: "b-noinv", tool_name: "Write", tool_input: { file_path: "a.py" } }));
    }
    return o;
  } },
  { id: "size3", w: 1, note: "触发③体积三闸 ×3", run: (e) => {
    clear("b-size");
    const o = [call(e, "reset", { session_id: "b-size", prompt: "看看情况" })];
    o.push(call(e, "pre", { session_id: "b-size", tool_name: "Read", tool_input: { file_path: bigFile } }));
    o.push(call(e, "pre", { session_id: "b-size", tool_name: "Grep", tool_input: { pattern: "x", output_mode: "content", path: "." } }));
    o.push(call(e, "pre", { session_id: "b-size", tool_name: "Bash", tool_input: { command: "cat big.txt" } }));
    return o;
  } },
  { id: "blind", w: 1, note: "盲写拦截 ×1", run: (e) => {
    clear("b-blind");
    const o = [call(e, "reset", { session_id: "b-blind", prompt: "看看情况" })];
    o.push(call(e, "post", { session_id: "b-blind", tool_name: "Read", tool_input: { file_path: join(fixtures, "doc.txt") }, tool_response: { content: "v1" } }));
    o.push(call(e, "pre", { session_id: "b-blind", tool_name: "Edit", tool_input: { file_path: blindTarget, old_string: "old", new_string: "new" } }));
    return o;
  } },
  { id: "pollution", w: 1, note: "上下文污染检出 ×1", run: (e) => {
    clear("b-poll");
    const o = [call(e, "reset", { session_id: "b-poll", prompt: "看看情况" })];
    o.push(call(e, "post", { session_id: "b-poll", tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } }));
    o.push(call(e, "post", { session_id: "b-poll", tool_name: "Bash", tool_input: { command: "git ls-files | head -3" }, tool_response: { content: "a.js\nb.js\nc.js\nd.js\ne.js" } }));
    return o;
  } },
  { id: "pushgate", w: 1, note: "推送闸拦截 ×1", run: (e) => {
    clear("b-push");
    const o = [call(e, "reset", { session_id: "b-push", prompt: "看看情况" })];
    o.push(call(e, "post", { session_id: "b-push", tool_name: "Read", tool_input: { file_path: "r.txt", limit: 5 }, tool_response: { content: "v" } }));
    o.push(call(e, "pre", { session_id: "b-push", tool_name: "Bash", tool_input: { command: "git push origin main" } }));
    return o;
  } },
  { id: "summaryB", w: 1, note: "委派摘要超长拒收 ×1", run: (e) => {
    clear("b-sumb");
    const o = [call(e, "reset", { session_id: "b-sumb", prompt: "看看情况" })];
    o.push(call(e, "pre", { session_id: "b-sumb", tool_name: "Agent", tool_input: { description: "调研" } }));
    o.push(call(e, "post", { session_id: "b-sumb", tool_name: "Agent", tool_input: { description: "调研" }, tool_response: { result: "x".repeat(300) } }));
    return o;
  } },
  { id: "delegateA", w: 1, note: "强制场景未委派提醒 ×1", run: (e) => {
    clear("b-dela");
    const o = [call(e, "reset", { session_id: "b-dela", prompt: "看看情况" })];
    o.push(call(e, "post", { session_id: "b-dela", tool_name: "Bash", tool_input: { command: "find . -name '*.js'" }, tool_response: { content: WIDE } }));
    return o;
  } },
  { id: "fuse", w: 1, note: "熔断出口（拒绝+打回）×1", run: (e) => {
    clear("b-fuse");
    call(e, "reset", { session_id: "b-fuse", prompt: "看看情况" });
    seed("b-fuse", { fused: true });
    const o = [call(e, "pre", { session_id: "b-fuse", tool_name: "Write", tool_input: { file_path: "n.py" } })];
    o.push(call(e, "stop", { session_id: "b-fuse", response: "【熔断】无法通过现有资料定位核心问题" }));
    return o;
  } },
  { id: "refill", w: 3, n: 3, note: "动态预算续杯 ×3", filter: "续杯", run: (e) => {
    clear("b-refill");
    const o = [call(e, "reset", { session_id: "b-refill", prompt: "看看情况" })];
    for (let i = 1; i <= 30; i++) {
      o.push(call(e, "post", { session_id: "b-refill", tool_name: "Edit", tool_input: { file_path: `f${i}.txt`, old_string: "a", new_string: `b${i}` }, tool_response: { content: "ok" } }));
    }
    return o;
  } },
];

function measure(engine) {
  const per = {};
  for (const sc of SCENARIOS) {
    let calls = sc.run(engine);
    if (sc.filter) calls = calls.filter((c) => c.text.includes(sc.filter));
    const total = calls.reduce((a, c) => a + c.chars, 0);
    per[sc.id] = sc.n ? Math.round(total / sc.n) : total; // 折算为单次成本，权重 w 决定会话内次数
  }
  return per;
}

const results = engines.map(measure);
const A = results[0]; // 第一个参数 = 基线
const B = results[1] || results[0]; // 第二个参数 = 优化后（缺省时与基线相同）
const div = (x, y) => (y ? ((x - y) / y * 100).toFixed(1) + "%" : "n/a");
console.log("场景\t基线chars\t优化后chars\t节省");
let wa = 0, wb = 0;
for (const sc of SCENARIOS) {
  const a = A[sc.id];
  const b = B[sc.id];
  wa += a * sc.w; wb += b * sc.w;
  console.log(`${sc.note}\t${a}\t${b}\t${engines[1] ? div(b, a) : "-"}`);
}
console.log(`--- 典型会话加权合计（chars）: 基线=${wa} 优化后=${wb} 节省=${div(wb, wa)} ---`);
const tok = (c) => `≈${Math.round(c / 1.5)} tokens（按1≈1.5字，区间${Math.round(c / 2.0)}~${Math.round(c / 1.2)}）`;
console.log(`--- 典型会话 token 估算: 基线${tok(wa)} → 优化后${tok(wb)} ---`);

// 清理本次运行在系统临时目录留下的 fixture（此前每次运行漏一个目录）
rmSync(fixtures, { recursive: true, force: true });
