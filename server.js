import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 项目规定的五道制片工序，必须依次推进；五序完成后进入“待观察”
const STAGES = ["取样", "切割", "研磨", "染色", "封片"];
const STAGE_COUNT = STAGES.length;

// 数据与静态资源
const dbPath = process.env.DB_FILE
  ? (process.env.DB_FILE.startsWith("/") ? process.env.DB_FILE : join(__dirname, process.env.DB_FILE))
  : join(__dirname, "data", "core-slices.json");
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 3025);

/* ---------------- 领域工具 ---------------- */

function newSlice(code, operator, basis = "登记时建立任务") {
  return {
    code,
    operator,                 // 当前负责人（下一序的默认操作人）
    stageIndex: 0,            // 下一道待执行工序下标；STAGE_COUNT 表示五序已完成
    phase: "producing",       // producing | observing | rejected | qualified
    observations: [],         // 观察记录：{conclusion, defect, reason, operator, basis, at}
    // 五道工序占位记录，按工序下标排列；推进时补齐操作人/依据/时间
    records: STAGES.map(stage => ({ stage, operator: null, basis: null, at: null })),
    idempotencyKeys: {},      // 本切片已成功消费的幂等键（重放时只成功一次的那次）
    replacementFor: null,     // 若是替代切片：被替代切片编码
    replacedBy: null,         // 若已作废：替代切片编码
    voided: false,
    voidReason: null,
    voidedAt: null
  };
}

function seedDb() {
  const now = new Date().toISOString();
  const mk = (code, op, idx, overrides = {}) => {
    const s = newSlice(code, op);
    s.stageIndex = idx;
    for (let i = 0; i < idx; i++) s.records[i] = { stage: STAGES[i], operator: op, basis: `示范：${STAGES[i]}工序依据`, at: now };
    return Object.assign(s, overrides);
  };
  const a = mk("SL-DEMO-A1", "陆川", STAGE_COUNT);
  a.phase = "qualified";
  a.observations.push({ conclusion: "合格", defect: "", reason: "", operator: "周岩", basis: "镜下观察：矿物结构完整，无明显裂隙", at: now });
  const b = mk("SL-DEMO-A2", "陆川", 3); // 染色中
  const c = mk("SL-DEMO-A3", "周岩", STAGE_COUNT, {
    phase: "rejected",
    voided: true,
    voidReason: "染色不均且边缘破碎，无法判读",
    voidedAt: now,
    observations: [{ conclusion: "不合格", defect: "染色不均/边缘破碎", reason: "研磨粒度超标导致盖片不密合", operator: "周岩", basis: "镜下观察记录 OBS-0091", at: now }]
  });
  const r = mk("SL-DEMO-A3-R1", "韩冰", 1, { replacementFor: "SL-DEMO-A3" });
  c.replacedBy = "SL-DEMO-A3-R1";
  return {
    version: 2,
    seq: 2,
    batches: [{
      id: "B20260912-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      createdAt: now,
      deliveredAt: null,
      slices: [a, b, c, r]
    }]
  };
}

function nextBatchId(db, now = new Date()) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = (db.seq = (db.seq || 0) + 1);
  return `B${day}-${String(seq).padStart(3, "0")}`;
}

function sliceNextAction(slice) {
  if (slice.voided) return { kind: "void", label: "已作废" };
  if (slice.phase === "qualified") return { kind: "done", label: "已判合格" };
  if (slice.phase === "rejected") return { kind: "await-replacement", label: "待补替代切片" };
  if (slice.stageIndex >= STAGE_COUNT) return { kind: "observe", label: "待观察" };
  return { kind: "advance", label: `待${STAGES[slice.stageIndex]}`, stage: STAGES[slice.stageIndex], stageIndex: slice.stageIndex };
}

function sliceView(slice) {
  const action = sliceNextAction(slice);
  return {
    code: slice.code,
    operator: slice.operator,
    stageIndex: slice.stageIndex,
    stageName: slice.stageIndex >= STAGE_COUNT ? "待观察" : STAGES[slice.stageIndex],
    phase: slice.phase,
    voided: slice.voided,
    voidReason: slice.voidReason,
    voidedAt: slice.voidedAt,
    replacementFor: slice.replacementFor,
    replacedBy: slice.replacedBy,
    records: slice.records,
    observations: slice.observations,
    nextAction: action
  };
}

// 批次能否交付：不存在未观察、不合格未闭环（未补替代）的切片；
// 已作废切片必须有替代链且替代切片合格。
function readiness(batch) {
  const blockers = [];
  const active = batch.slices.filter(s => !s.voided);
  const producing = active.filter(s => s.phase === "producing");
  const unobserved = active.filter(s => s.phase === "observing");
  const rejected = active.filter(s => s.phase === "rejected");

  if (producing.length) blockers.push({ code: "in_production", message: `${producing.length} 张切片仍在五道工序中（未观察）`, slices: producing.map(s => s.code) });
  if (unobserved.length) blockers.push({ code: "unobserved", message: `${unobserved.length} 张切片已完成制片尚未观察`, slices: unobserved.map(s => s.code) });
  if (rejected.length) blockers.push({ code: "missing_replacement", message: `${rejected.length} 张不合格切片尚未登记替代切片`, slices: rejected.map(s => s.code) });

  for (const s of batch.slices.filter(x => x.voided)) {
    if (!s.replacedBy) blockers.push({ code: "missing_replacement", message: `作废切片 ${s.code} 未补替代切片`, slices: [s.code] });
    else {
      const rep = batch.slices.find(x => x.code === s.replacedBy);
      if (!rep || rep.voided || rep.phase !== "qualified") {
        blockers.push({ code: "replacement_open", message: `作废切片 ${s.code} 的替代切片 ${s.replacedBy} 尚未合格`, slices: [s.replacedBy] });
      }
    }
  }
  return { canDeliver: blockers.length === 0, blockers };
}

function batchView(batch) {
  const slices = batch.slices.map(sliceView);
  const r = readiness(batch);
  // 缺陷是否闭环：已登记替代片且替代片已判合格
  const isClosedDefect = s => {
    if (!s.voided) return false;
    const rep = s.replacedBy && batch.slices.find(x => x.code === s.replacedBy);
    return Boolean(rep && !rep.voided && rep.phase === "qualified");
  };
  const openDefects = batch.slices.filter(s => s.voided && !isClosedDefect(s));
  const counts = {
    total: batch.slices.length,
    producing: batch.slices.filter(s => !s.voided && s.phase === "producing").length,
    observing: batch.slices.filter(s => !s.voided && s.phase === "observing").length,
    rejected: openDefects.length,
    voided: batch.slices.filter(s => s.voided).length,
    qualified: batch.slices.filter(s => !s.voided && s.phase === "qualified").length
  };
  // 下一负责人：按当前待处理动作聚合
  const nextOwners = {};
  for (const s of slices) {
    if (["advance", "observe", "await-replacement"].includes(s.nextAction.kind)) {
      const key = `${s.operator}|${s.nextAction.label}`;
      (nextOwners[key] ||= { operator: s.operator, action: s.nextAction.label, slices: [] }).slices.push(s.code);
    }
  }
  const pendingDefects = openDefects.map(s => {
      const obs = s.observations.filter(o => o.conclusion === "不合格").at(-1);
      return {
        sliceCode: s.code, defect: obs?.defect || "", reason: s.voidReason || obs?.reason || "",
        replacedBy: s.replacedBy,
        replacementStatus: s.replacedBy ? sliceView(batch.slices.find(x => x.code === s.replacedBy)).nextAction.label : "未登记"
      };
    });
  const doneSteps = batch.slices.reduce((n, s) => n + s.records.filter(rec => rec.at).length, 0);
  const totalSteps = batch.slices.length * STAGE_COUNT;
  return {
    id: batch.id, project: batch.project, borehole: batch.borehole, coreBox: batch.coreBox,
    depth: batch.depth, owner: batch.owner, createdAt: batch.createdAt,
    delivered: Boolean(batch.deliveredAt), deliveredAt: batch.deliveredAt,
    counts, progress: { doneSteps, totalSteps, percent: totalSteps ? Math.round(doneSteps / totalSteps * 100) : 0 },
    slices, nextOwners: Object.values(nextOwners), pendingDefects, readiness: r
  };
}

/* ---------------- 持久化（读-改-写全程串行，原子落盘，重启保留） ---------------- */

let db = null;
let chain = Promise.resolve();

async function initDb() {
  if (existsSync(dbPath)) {
    const raw = JSON.parse(await readFile(dbPath, "utf8"));
    if (raw.version === 2) { db = raw; return; }
    // v1 脚手架数据：备份后重建，避免语义不一致
    await rename(dbPath, dbPath.replace(/\.json$/, `.v1-${Date.now()}.bak.json`));
  }
  db = seedDb();
  await persist();
}

async function persist() {
  await mkdir(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}

// 所有写操作经同一互斥链串行化；重复/过期并发请求只有一个能看到可推进状态
function withLock(fn) {
  const run = chain.then(() => fn(db));
  chain = run.then(() => {}, () => {});
  return run;
}

/* ---------------- HTTP 辅助 ---------------- */

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function fail(res, status, code, message, extra = {}) {
  return sendJson(res, status, { error: code, message, ...extra });
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("请求体不是合法 JSON"), { http: 400, code: "bad_json" }); }
}
function requireStr(input, key, code) {
  const v = (input[key] ?? "").toString().trim();
  if (!v) throw Object.assign(new Error(`${key} 不能为空`), { http: 400, code: code || "invalid_input" });
  return v;
}

/* ---------------- 路由处理（均在锁内执行检查与落盘） ---------------- */

function createBatch(input) {
  const project = requireStr(input, "project");
  const borehole = requireStr(input, "borehole");
  const coreBox = requireStr(input, "coreBox");
  const depth = requireStr(input, "depth");
  const owner = requireStr(input, "owner");
  const list = Array.isArray(input.slices) ? input.slices : [];
  if (!list.length) throw Object.assign(new Error("一次登记至少需要一张切片"), { http: 400, code: "no_slices" });

  const slices = [];
  const codes = new Set();
  for (const item of list) {
    const code = requireStr(item, "code", "slice_code_required");
    if (codes.has(code)) throw Object.assign(new Error(`同批次切片编号重复：${code}`), { http: 400, code: "duplicate_slice_code" });
    codes.add(code);
    const op = (item.operator || "").toString().trim() || owner;
    slices.push(newSlice(code, op, (item.basis || "").toString().trim() || "登记时建立任务"));
  }
  const batch = {
    id: nextBatchId(db), project, borehole, coreBox, depth, owner,
    createdAt: new Date().toISOString(), deliveredAt: null, slices
  };
  db.batches.unshift(batch);
  return persist().then(() => batchView(batch));
}

function advanceSlice(batchId, sliceCode, input) {
  const batch = db.batches.find(b => b.id === batchId);
  if (!batch) throw Object.assign(new Error("批次不存在"), { http: 404, code: "batch_not_found" });
  const slice = batch.slices.find(s => s.code === sliceCode);
  if (!slice) throw Object.assign(new Error("切片不存在"), { http: 404, code: "slice_not_found" });

  if (slice.voided) throw Object.assign(new Error("切片已作废，不能推进"), { http: 409, code: "slice_voided" });
  if (slice.phase === "rejected") throw Object.assign(new Error("切片已判不合格并作废，等待替代切片"), { http: 409, code: "slice_rejected" });
  if (slice.phase === "qualified") throw Object.assign(new Error("切片已判合格，无需再推进"), { http: 409, code: "already_qualified" });

  // 幂等键优先：同一推进请求（即使带的是旧 expectedStage）重放，算重复而非过期；
  // 此前已成功一次，本次失败且状态/记录不变
  const reqId = (input.reqId || "").toString().trim();
  if (reqId && Object.prototype.hasOwnProperty.call(slice.idempotencyKeys, reqId)) {
    throw Object.assign(
      new Error(`重复推进请求（${reqId}）此前已成功一次，本次失败且状态与记录不变`),
      { http: 409, code: "duplicate_request", duplicateOf: slice.idempotencyKeys[reqId] }
    );
  }

  // 过期请求：携带的期望工序与当前工序不一致（含重复提交同一工序、五序完成后的迟到推进）
  const expectedRaw = input.expectedStage;
  if (expectedRaw !== undefined && expectedRaw !== null && expectedRaw !== "") {
    const expected = Number(expectedRaw);
    if (Number.isInteger(expected) && expected !== slice.stageIndex) {
      const curName = slice.stageIndex >= STAGE_COUNT ? "待观察" : STAGES[slice.stageIndex];
      throw Object.assign(
        new Error(`过期/重复推进：请求针对「${STAGES[expected] ?? `#${expected}`}」，当前已是「${curName}」，状态与记录不变`),
        { http: 409, code: "stale_advance", currentStageIndex: slice.stageIndex, currentStage: curName }
      );
    }
  }

  if (slice.stageIndex >= STAGE_COUNT) throw Object.assign(new Error("五道工序已完成，该切片待观察而非继续推进"), { http: 409, code: "awaiting_observation" });

  const operator = requireStr(input, "operator");
  const basis = requireStr(input, "basis");
  const idx = slice.stageIndex;
  const at = new Date().toISOString();
  slice.records[idx] = { stage: STAGES[idx], operator, basis, at };
  slice.stageIndex = idx + 1;
  if (slice.stageIndex >= STAGE_COUNT) slice.phase = "observing";
  slice.operator = (input.nextOperator || "").toString().trim() || operator;
  if (reqId) slice.idempotencyKeys[reqId] = { stageIndex: idx, at };

  return persist().then(() => batchView(batch));
}

function observeSlice(batchId, sliceCode, input) {
  const batch = db.batches.find(b => b.id === batchId);
  if (!batch) throw Object.assign(new Error("批次不存在"), { http: 404, code: "batch_not_found" });
  const slice = batch.slices.find(s => s.code === sliceCode);
  if (!slice) throw Object.assign(new Error("切片不存在"), { http: 404, code: "slice_not_found" });
  if (slice.voided) throw Object.assign(new Error("切片已作废"), { http: 409, code: "slice_voided" });
  if (slice.phase === "qualified") throw Object.assign(new Error("切片已判合格"), { http: 409, code: "already_qualified" });
  if (slice.phase === "rejected") throw Object.assign(new Error("切片已判不合格并作废"), { http: 409, code: "already_rejected" });
  if (slice.stageIndex < STAGE_COUNT) {
    throw Object.assign(new Error(`五道工序尚未完成（当前 ${STAGES[slice.stageIndex]}），不能观察下结论`), {
      http: 409, code: "stages_incomplete", currentStageIndex: slice.stageIndex
    });
  }
  const conclusion = requireStr(input, "conclusion");
  if (!["合格", "不合格"].includes(conclusion)) throw Object.assign(new Error("结论只能是 合格 或 不合格"), { http: 400, code: "bad_conclusion" });
  const operator = requireStr(input, "operator");
  const basis = requireStr(input, "basis");

  const rec = { conclusion, defect: "", reason: "", operator, basis, at: new Date().toISOString() };
  if (conclusion === "不合格") {
    rec.defect = requireStr(input, "defect");
    rec.reason = requireStr(input, "reason"); // 作废原因
    slice.phase = "rejected";
    slice.voided = true;
    slice.voidReason = rec.reason;
    slice.voidedAt = rec.at;
    const replacementCode = (input.replacementCode || "").toString().trim();
    if (replacementCode) registerReplacement(batch, slice, replacementCode, (input.replacementOperator || "").toString().trim() || batch.owner);
  } else {
    slice.phase = "qualified";
  }
  slice.observations.push(rec);
  return persist().then(() => batchView(batch));
}

// 在批次内为不合格切片登记替代切片；替代切片从第一道工序重新开始
function registerReplacement(batch, rejected, code, operator) {
  if (batch.slices.some(s => s.code === code)) throw Object.assign(new Error(`切片编号已存在：${code}`), { http: 409, code: "duplicate_slice_code" });
  const rep = newSlice(code, operator, `替代作废切片 ${rejected.code}，从第一道工序重做`);
  rep.replacementFor = rejected.code;
  batch.slices.push(rep);
  rejected.replacedBy = code;
  rejected.phase = "rejected"; // 保持不合格闭环状态
  return rep;
}

function addReplacement(batchId, sliceCode, input) {
  const batch = db.batches.find(b => b.id === batchId);
  if (!batch) throw Object.assign(new Error("批次不存在"), { http: 404, code: "batch_not_found" });
  const slice = batch.slices.find(s => s.code === sliceCode);
  if (!slice) throw Object.assign(new Error("切片不存在"), { http: 404, code: "slice_not_found" });
  if (!slice.voided || slice.phase !== "rejected") throw Object.assign(new Error("只有不合格且已作废的切片需要补替代切片"), { http: 409, code: "not_rejected" });
  if (slice.replacedBy) throw Object.assign(new Error(`该切片已登记替代切片 ${slice.replacedBy}`), { http: 409, code: "replacement_exists" });
  const code = requireStr(input, "replacementCode");
  const operator = (input.operator || "").toString().trim() || batch.owner;
  registerReplacement(batch, slice, code, operator);
  return persist().then(() => batchView(batch));
}

function deliverBatch(batchId) {
  const batch = db.batches.find(b => b.id === batchId);
  if (!batch) throw Object.assign(new Error("批次不存在"), { http: 404, code: "batch_not_found" });
  if (batch.deliveredAt) throw Object.assign(new Error("批次已交付，不能重复交付"), { http: 409, code: "already_delivered" });
  const r = readiness(batch);
  if (!r.canDeliver) {
    throw Object.assign(new Error("批次尚不满足交付条件"), { http: 409, code: "not_deliverable", blockers: r.blockers });
  }
  batch.deliveredAt = new Date().toISOString();
  return persist().then(() => batchView(batch));
}

/* ---------------- 静态页面 ---------------- */

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = join(publicDir, rel);
  if (!file.startsWith(publicDir) || !existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" });
  res.end(await readFile(file));
}

/* ---------------- 服务 ---------------- */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === "GET" && p === "/") return await serveStatic(res, p);
    if (req.method === "GET" && p === "/api/config") return sendJson(res, 200, { stages: STAGES, stageCount: STAGE_COUNT });

    if (req.method === "GET" && p === "/api/batches") {
      const view = db.batches.map(batchView);
      const summary = {
        batches: view.length,
        slices: view.reduce((n, b) => n + b.counts.total, 0),
        producing: view.reduce((n, b) => n + b.counts.producing, 0),
        observing: view.reduce((n, b) => n + b.counts.observing, 0),
        pendingDefects: view.reduce((n, b) => n + b.pendingDefects.length, 0),
        deliverable: view.filter(b => b.readiness.canDeliver && !b.delivered).length,
        delivered: view.filter(b => b.delivered).length
      };
      return sendJson(res, 200, { stages: STAGES, summary, batches: view });
    }

    if (req.method === "POST" && p === "/api/batches") {
      const input = await readBody(req);
      const view = await withLock(() => createBatch(input));
      return sendJson(res, 201, view);
    }

    const advance = p.match(/^\/api\/batches\/([^/]+)\/slices\/([^/]+)\/advance$/);
    if (advance && req.method === "POST") {
      const input = await readBody(req);
      const view = await withLock(() => advanceSlice(decodeURIComponent(advance[1]), decodeURIComponent(advance[2]), input));
      return sendJson(res, 200, view);
    }
    const observe = p.match(/^\/api\/batches\/([^/]+)\/slices\/([^/]+)\/observe$/);
    if (observe && req.method === "POST") {
      const input = await readBody(req);
      const view = await withLock(() => observeSlice(decodeURIComponent(observe[1]), decodeURIComponent(observe[2]), input));
      return sendJson(res, 200, view);
    }
    const replacement = p.match(/^\/api\/batches\/([^/]+)\/slices\/([^/]+)\/replacement$/);
    if (replacement && req.method === "POST") {
      const input = await readBody(req);
      const view = await withLock(() => addReplacement(decodeURIComponent(replacement[1]), decodeURIComponent(replacement[2]), input));
      return sendJson(res, 201, view);
    }
    const deliver = p.match(/^\/api\/batches\/([^/]+)\/deliver$/);
    if (deliver && req.method === "POST") {
      await readBody(req);
      const view = await withLock(() => deliverBatch(decodeURIComponent(deliver[1])));
      return sendJson(res, 200, view);
    }

    sendJson(res, 404, { error: "not_found", message: "接口或页面不存在" });
  } catch (error) {
    const status = error.http || 500;
    sendJson(res, status, { error: error.code || "server_error", message: error.message, ...(error.currentStageIndex !== undefined ? { currentStageIndex: error.currentStageIndex, currentStage: error.currentStage } : {}), ...(error.blockers ? { blockers: error.blockers } : {}), ...(error.duplicateOf ? { duplicateOf: error.duplicateOf } : {}) });
  }
});

initDb().then(() => {
  server.listen(port, () => console.log(`岩芯切片任务台已启动：http://localhost:${port}（数据文件 ${dbPath}）`));
});
