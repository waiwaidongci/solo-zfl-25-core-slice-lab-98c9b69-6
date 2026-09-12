#!/usr/bin/env node
// 岩芯切片任务台 —— 启动后自动走通：
// 多切片推进 / 不合格作废 / 替代重做 / 并发重复只成功一次 / 过期请求失败 / 交付门禁 / 重启恢复
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 4321;
const DB_FILE = "data/demo-run.json";
const BASE = `http://127.0.0.1:${PORT}`;
const ABS_DB = join(__dirname, DB_FILE);

let passed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  \x1b[32m✔\x1b[0m ${label}`); }
  else { console.error(`  \x1b[31m✘ ${label}\x1b[0m${detail ? `\n    ${detail}` : ""}`); process.exitCode = 1; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startServer() {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), DB_FILE: DB_FILE },
    stdio: ["ignore", "pipe", "inherit"]
  });
  return new Promise((resolve, reject) => {
    child.stdout.on("data", d => { if (String(d).includes("已启动")) resolve(child); });
    child.on("exit", code => reject(new Error("server exited early: " + code)));
  });
}
function stopServer(child) { return new Promise(resolve => { child.on("exit", resolve); child.kill("SIGTERM"); }); }

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
async function untilReady() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + "/api/config"); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error("server not ready");
}

// 找到视图里的某张切片
function sliceOf(batch, code) { return batch.slices.find(s => s.code === code); }
function batchOf(list, id) { return list.find(b => b.id === id); }

const STAGES = ["取样", "切割", "研磨", "染色", "封片"];

async function main() {
  if (existsSync(ABS_DB)) await rm(ABS_DB);
  let server = await startServer();
  await untilReady();
  console.log("\n① 登记：一次录入多张切片和负责人");
  const reg = await req("POST", "/api/batches", {
    project: "北岭金矿薄片", borehole: "ZK-08", coreBox: "BX-03", depth: "210.1-210.6m", owner: "陆川",
    slices: [
      { code: "A1", operator: "陆川" },
      { code: "A2", operator: "韩冰" },
      { code: "A3" } // 负责人留空 -> 默认批次负责人
    ]
  });
  ok(reg.status === 201, "批次登记成功，返回批次视图", reg.status + " " + JSON.stringify(reg.json));
  const batchId = reg.json.id;
  ok(sliceOf(reg.json, "A3").operator === "陆川", "未指定负责人的切片继承批次负责人 陆川");
  ok(sliceOf(reg.json, "A1").nextAction.kind === "advance" && sliceOf(reg.json, "A1").stageIndex === 0, "切片从第一道工序「取样」开始");
  ok(reg.json.readiness.canDeliver === false, "新批次不可交付（存在未观察切片）");

  const dupCode = await req("POST", "/api/batches", {
    project: "x", borehole: "x", coreBox: "x", depth: "x", owner: "x",
    slices: [{ code: "S1" }, { code: "S1" }]
  });
  ok(dupCode.status === 400 && dupCode.json.error === "duplicate_slice_code", "同批次重复切片编号被拒绝");

  console.log("\n② 多切片依次推进五道工序，记录操作人、时间、依据");
  for (const code of ["A1", "A2", "A3"]) {
    for (let i = 0; i < 5; i++) {
      const r = await req("POST", `/api/batches/${batchId}/slices/${code}/advance`, {
        operator: ["陆川", "韩冰", "周岩"][i % 3],
        basis: `${STAGES[i]}依据：作业指导书 QB-${20 + i}`,
        nextOperator: i === 4 ? "周岩" : undefined,
        expectedStage: i,
        reqId: `${code}-stage-${i}`
      });
      ok(r.status === 200 && sliceOf(r.json, code).stageIndex === i + 1,
        `${code} 第${i + 1}道「${STAGES[i]}」推进成功 -> 工序下标 ${i + 1}`);
      const rec = sliceOf(r.json, code).records[i];
      ok(rec.operator && rec.at && rec.basis, `${code}「${STAGES[i]}」记录了操作人/时间/依据 (${rec.operator} @ ${rec.at})`);
    }
  }
  let list = (await req("GET", "/api/batches")).json;
  let batch = batchOf(list.batches, batchId);
  ok(["A1", "A2", "A3"].every(c => sliceOf(batch, c).phase === "observing"), "三张切片五序完成，全部进入待观察");
  ok(batch.progress.doneSteps === 15 && batch.progress.percent === 100, `批次工序进度 15/15 = 100%（实际 ${batch.progress.doneSteps}/${batch.progress.totalSteps}）`);

  console.log("\n③ 过期推进请求：工序已越过，返回 409，状态和记录不变");
  const before = sliceOf(batch, "A2").records.length;
  const stale = await req("POST", `/api/batches/${batchId}/slices/A2/advance`, {
    operator: "韩冰", basis: "迟到的旧请求", expectedStage: 1, reqId: "stale-1"
  });
  ok(stale.status === 409 && stale.json.error === "stale_advance", "过期请求（期望研磨，实际已待观察）失败");
  list = (await req("GET", "/api/batches")).json; batch = batchOf(list.batches, batchId);
  ok(sliceOf(batch, "A2").phase === "observing" && sliceOf(batch, "A2").records.length === before, "过期请求后状态与记录不变");

  console.log("\n④ 并发重复推进：同一片同一工序 6 个同时请求，只成功一次");
  // 先登记一片只走 1 道的切片，再对「切割」并发
  const b2 = await req("POST", "/api/batches", {
    project: "南岭铀矿", borehole: "ZK-03", coreBox: "BX-11", depth: "55.0-55.4m", owner: "韩冰",
    slices: [{ code: "B1" }]
  });
  const b2Id = b2.json.id;
  const r0 = await req("POST", `/api/batches/${b2Id}/slices/B1/advance`, {
    operator: "韩冰", basis: "取样完成", expectedStage: 0, reqId: "B1-0"
  });
  ok(r0.status === 200 && sliceOf(r0.json, "B1").stageIndex === 1, "B1 完成「取样」，停在「切割」前");

  const sameReqId = "B1-cut-same";
  const concurrent = await Promise.all(Array.from({ length: 6 }, () =>
    req("POST", `/api/batches/${b2Id}/slices/B1/advance`, {
      operator: "韩冰", basis: "切割工艺卡", expectedStage: 1, reqId: sameReqId
    })
  ));
  const wins = concurrent.filter(r => r.status === 200).length;
  const lost = concurrent.filter(r => r.status === 409).length;
  ok(wins === 1 && lost === 5, `6 个并发重复请求：成功 ${wins}、失败 ${lost}（期望 1/5）`);
  ok(concurrent.every(r => r.status === 200 || r.json.error === "duplicate_request"), "其余 5 个均为 duplicate_request");
  list = (await req("GET", "/api/batches")).json; batch = batchOf(list.batches, b2Id);
  ok(sliceOf(batch, "B1").stageIndex === 2, "B1 只前进一道工序（切割），没有被重复推进");

  console.log("\n⑤ 过期并发：同一工序不同请求号，晚到者按 expectedStage 判为过期");
  const raced = await Promise.all([
    req("POST", `/api/batches/${b2Id}/slices/B1/advance`, { operator: "韩冰", basis: "研磨-甲", expectedStage: 2, reqId: "B1-grind-a" }),
    req("POST", `/api/batches/${b2Id}/slices/B1/advance`, { operator: "韩冰", basis: "研磨-乙", expectedStage: 2, reqId: "B1-grind-b" })
  ]);
  ok(raced.filter(r => r.status === 200).length === 1 && raced.filter(r => r.status === 409).length === 1,
    "同工序两个并发请求：一个成功，另一个 stale_advance 失败");
  list = (await req("GET", "/api/batches")).json; batch = batchOf(list.batches, b2Id);
  ok(sliceOf(batch, "B1").stageIndex === 3 && sliceOf(batch, "B1").records[2].basis === "研磨-甲",
    "只执行一次，记录仅一条（依据为先到的 研磨-甲）");

  console.log("\n⑥ 观察结论：A1/A3 合格，A2 不合格，登记缺陷+作废原因+替代切片");
  const o1 = await req("POST", `/api/batches/${batchId}/slices/A1/observe`, {
    conclusion: "合格", operator: "周岩", basis: "镜下观察 OBS-101：结构完整无裂隙"
  });
  ok(o1.status === 200 && sliceOf(o1.json, "A1").phase === "qualified", "A1 判定合格");
  const earlyObs = await req("POST", `/api/batches/${b2Id}/slices/B1/observe`, {
    conclusion: "合格", operator: "周岩", basis: "x"
  });
  ok(earlyObs.status === 409 && earlyObs.json.error === "stages_incomplete", "五序未完不能观察（B1 还在制片中）");

  const badNoDefect = await req("POST", `/api/batches/${batchId}/slices/A2/observe`, {
    conclusion: "不合格", operator: "周岩", basis: "OBS-102"
  });
  ok(badNoDefect.status === 400, "不合格结论必须登记缺陷和作废原因");

  const o2 = await req("POST", `/api/batches/${batchId}/slices/A2/observe`, {
    conclusion: "不合格", operator: "周岩", basis: "镜下观察 OBS-102",
    defect: "染色不均、边缘破碎", reason: "研磨粒度超标，盖片不密合，判读不可靠",
    replacementCode: "A2-R1", replacementOperator: "韩冰"
  });
  ok(o2.status === 200, "A2 登记缺陷/作废原因/替代切片成功");
  const a2 = sliceOf(o2.json, "A2"), rep = sliceOf(o2.json, "A2-R1");
  ok(a2.voided && a2.replacedBy === "A2-R1" && rep.replacementFor === "A2", "A2 已作废并关联替代片 A2-R1");
  ok(rep.phase === "producing" && rep.stageIndex === 0 && rep.records.length === 5,
    "替代切片从第一道「取样」重新开始（五道记录重新建立）");
  const o3 = await req("POST", `/api/batches/${batchId}/slices/A3/observe`, {
    conclusion: "合格", operator: "周岩", basis: "镜下观察 OBS-103"
  });
  ok(o3.status === 200 && sliceOf(o3.json, "A3").phase === "qualified", "A3 判定合格");

  list = (await req("GET", "/api/batches")).json; batch = batchOf(list.batches, batchId);
  const pd = batch.pendingDefects.find(d => d.sliceCode === "A2");
  ok(Boolean(pd) && pd.replacedBy === "A2-R1" && pd.replacementStatus.includes("取样"),
    `看板待处理缺陷列出 A2：替代片 A2-R1 状态「${pd?.replacementStatus}」（未合格前缺陷不闭环）`);
  const ownerTodo = batch.nextOwners.find(o => o.operator === "韩冰" && o.slices.includes("A2-R1"));
  ok(Boolean(ownerTodo), `下一负责人看板：韩冰 → 待取样（A2-R1），实际 ${JSON.stringify(batch.nextOwners)}`);

  console.log("\n⑦ 交付门禁：替代片未走完前批次不能交付");
  const d1 = await req("POST", `/api/batches/${batchId}/deliver`, {});
  ok(d1.status === 409 && d1.json.blockers.some(x => x.code === "in_production"), "批次交付被阻止（替代片仍在制片）");

  console.log("\n⑧ 替代切片重做五道工序并观察合格");
  for (let i = 0; i < 5; i++) {
    const r = await req("POST", `/api/batches/${batchId}/slices/A2-R1/advance`, {
      operator: "韩冰", basis: `${STAGES[i]}重做依据 QB-R-${i}`, expectedStage: i, reqId: `A2R-stage-${i}`
    });
    ok(r.status === 200, `替代片 A2-R1「${STAGES[i]}」重做推进成功`);
  }
  const o4 = await req("POST", `/api/batches/${batchId}/slices/A2-R1/observe`, {
    conclusion: "合格", operator: "周岩", basis: "复检 OBS-104：染色均匀，判读清晰"
  });
  ok(o4.status === 200 && sliceOf(o4.json, "A2-R1").phase === "qualified", "替代片复检合格");

  list = (await req("GET", "/api/batches")).json; batch = batchOf(list.batches, batchId);
  ok(batch.readiness.canDeliver && batch.pendingDefects.length === 0, "缺陷闭环：无未观察/不合格/未补替代切片");
  const d2 = await req("POST", `/api/batches/${batchId}/deliver`, {});
  ok(d2.status === 200 && d2.json.delivered, `批次 ${batchId} 交付成功`);
  const d3 = await req("POST", `/api/batches/${batchId}/deliver`, {});
  ok(d3.status === 409 && d3.json.error === "already_delivered", "重复交付被拒绝");

  console.log("\n⑨ 单切片批次 B1 门禁：未完成时交付被拒");
  const db1 = await req("POST", `/api/batches/${b2Id}/deliver`, {});
  ok(db1.status === 409, "B1 批次（制片中）不能交付");

  console.log("\n⑩ 不合格后稍后再补替代切片的路径");
  const b3 = await req("POST", "/api/batches", {
    project: "西岭铁矿", borehole: "ZK-21", coreBox: "BX-07", depth: "88.2-88.6m", owner: "周岩",
    slices: [{ code: "C1" }]
  });
  const b3Id = b3.json.id;
  for (let i = 0; i < 5; i++) await req("POST", `/api/batches/${b3Id}/slices/C1/advance`, {
    operator: "周岩", basis: STAGES[i], expectedStage: i, reqId: `C1-${i}`
  });
  const rej = await req("POST", `/api/batches/${b3Id}/slices/C1/observe`, {
    conclusion: "不合格", operator: "周岩", basis: "OBS-201", defect: "厚度超标", reason: "封片气泡导致废片"
  });
  ok(rej.status === 200 && sliceOf(rej.json, "C1").replacedBy === null, "C1 不合格作废，暂不登记替代片");
  let b3view = batchOf((await req("GET", "/api/batches")).json.batches, b3Id);
  ok(b3view.pendingDefects.some(d => d.sliceCode === "C1" && !d.replacedBy), "待处理缺陷列出 C1（替代：未登记）");
  const blocked = await req("POST", `/api/batches/${b3Id}/deliver`, {});
  ok(blocked.status === 409 && blocked.json.blockers.some(x => x.code === "missing_replacement"), "未补替代片不能交付");
  const rep2 = await req("POST", `/api/batches/${b3Id}/slices/C1/replacement`, {
    replacementCode: "C1-R1", operator: "韩冰"
  });
  ok(rep2.status === 201 && sliceOf(rep2.json, "C1-R1").stageIndex === 0, "事后补登记替代片 C1-R1，从第一道工序开始");
  const rep2again = await req("POST", `/api/batches/${b3Id}/slices/C1/replacement`, { replacementCode: "C1-R2" });
  ok(rep2again.status === 409 && rep2again.json.error === "replacement_exists", "一片只能有一个替代片，重复补登记被拒");

  console.log("\n⑪ 重启恢复：停服后重启，数据与状态完整保留");
  await stopServer(server);
  await sleep(300);
  server = await startServer();
  await untilReady();
  const after = (await req("GET", "/api/batches")).json;
  const restored = batchOf(after.batches, batchId);
  const c1 = batchOf(after.batches, b3Id);
  ok(restored.delivered, "重启后批次一仍为已交付");
  ok(sliceOf(restored, "A2").voided && sliceOf(restored, "A2").replacedBy === "A2-R1", "重启后 A2 作废与替代关联保留");
  ok(sliceOf(restored, "A2-R1").phase === "qualified" && sliceOf(restored, "A2-R1").records.every(r => r.at), "重启后替代片五道记录与合格结论保留");
  ok(sliceOf(c1, "C1-R1") && sliceOf(c1, "C1-R1").replacementFor === "C1", "重启后事后补登记的替代片保留");
  const replayAfterRestart = await req("POST", `/api/batches/${b2Id}/slices/B1/advance`, {
    operator: "韩冰", basis: "切割工艺卡", expectedStage: 1, reqId: "B1-cut-same"
  });
  ok(replayAfterRestart.status === 409 && replayAfterRestart.json.error === "duplicate_request",
    "重启后重放旧的成功请求号仍被拒绝（幂等键持久化），状态不变");
  const staleAfterRestart = await req("POST", `/api/batches/${b2Id}/slices/B1/advance`, {
    operator: "韩冰", basis: "过期重放", expectedStage: 0
  });
  ok(staleAfterRestart.status === 409 && staleAfterRestart.json.error === "stale_advance", "重启后过期请求同样失败");

  await stopServer(server);
  await rm(ABS_DB).catch(() => {});
  console.log(`\n\x1b[32m走通完成：${passed} 项断言全部通过。\x1b[0m`);
}
main().catch(async err => { console.error(err); process.exitCode = 1; });
