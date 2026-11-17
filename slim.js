'use strict';
/*
 * 四方世界存档瘦身核心逻辑（sifang-save v2）
 * 纯本地数据变换：不访问网络，只操作传入的存档对象（就地修改）。
 * 逻辑与经过实战验证的 Python 脚本一一对应，输出可通过 verifySave 自校验。
 */

// 生成时产物字段：重放/复现/统计才需要，显示与继续游戏不读
const GEN_FIELDS = ['inputs', 'preScript', 'runtimeWI', 'seed', 'sentHash', 'usage', 'cost'];

// 沿 volumes[].head -> nodes[id].parent 回溯，计算可达节点集合
function computeReach(nodes, volumes) {
  const reach = new Set();
  for (const v of volumes || []) {
    let cur = v.head;
    while (cur != null && !reach.has(cur)) {
      reach.add(cur);
      const n = nodes ? nodes[cur] : null;
      cur = n ? (n.parent ?? null) : null;
    }
  }
  return reach;
}

// 每条卷链只保留路径上楼层最高的那个快照（各卷头状态重建所需的锚点）
function snapshotKeepSet(nodes, volumes) {
  const keep = new Set();
  for (const v of volumes || []) {
    let best = null, bestF = -1, cur = v.head;
    while (cur != null) {
      const n = nodes ? nodes[cur] : null;
      if (n && n.snapshot != null) {
        const f = n.floor || 0;
        if (f > bestF) { bestF = f; best = cur; }
      }
      cur = n ? (n.parent ?? null) : null;
    }
    if (best != null) keep.add(best);
  }
  return keep;
}

// 汇总存档状态，供瘦身前后对比校验
function summarize(data) {
  const threadState = new Map();
  for (const m of data.memory || []) {
    if (m.t === 'events') {
      for (const e of m.events || []) {
        const th = e.thread;
        if (!th || !th.id) continue;
        if (th.op === '开') threadState.set(th.id, 'open');
        else if (th.op === '结') threadState.set(th.id, 'closed');
      }
    } else if (m.t === 'gesture' && m.op && m.op.op === '结') {
      threadState.set(m.op.target, 'closed');
    }
  }
  const seqs = (data.memory || []).map(m => m.seq);
  const mono = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
  return {
    threadState,
    nodeCount: Object.keys(data.nodes || {}).length,
    blobCount: Object.keys(data.blobs || {}).length,
    memCount: (data.memory || []).length,
    seqMonotonic: mono,
  };
}

// 递归收集对 blob 键的引用（字符串值或字典键完全等于 blob 键才算）
function collectBlobRefs(value, blobKeys, acc) {
  if (Array.isArray(value)) {
    for (const v of value) collectBlobRefs(v, blobKeys, acc);
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      if (blobKeys.has(k)) acc.add(k);
      collectBlobRefs(value[k], blobKeys, acc);
    }
  } else if (typeof value === 'string' && blobKeys.has(value)) {
    acc.add(value);
  }
}

/*
 * 主入口。opts：
 *   recipe     删 node.recipe 引用（提示词组装记录，通常占 70%+ 体积）
 *   genFields  删 inputs/preScript/runtimeWI/seed/sentHash/usage/cost
 *   career     删 ext.career 职业推演检查点（保留 @tavern 等其他键）
 *   snapshots  每链只保留最新状态快照
 *   orphans    删不可达节点（旧 swipe/换版残留）及其悬挂引用
 * blob 统一按「仍被引用」重建（零悬挂、零冗余），随上述选项自动生效。
 */
function slimSave(data, opts) {
  const report = { steps: {} };
  const nodes = data.nodes || {};
  const volumes = data.volumes || [];
  const mem = data.memory || [];

  const reach = computeReach(nodes, volumes);
  const orphans = new Set(Object.keys(nodes).filter(id => !reach.has(id)));
  report.steps.orphans = { found: orphans.size, removed: 0, memRemoved: 0, retiredRemoved: 0, purseRemoved: 0 };

  const keepSnap = snapshotKeepSet(nodes, volumes);
  let snapTotal = 0;
  for (const id of Object.keys(nodes)) if (nodes[id].snapshot != null) snapTotal++;
  let snapDrop = 0;

  if (opts.orphans) {
    // 删挂在孤儿节点上的 rev/sent 日志（否则引用悬空）
    let removedMem = 0;
    const filtered = [];
    for (const m of mem) {
      if ((m.t === 'rev' || m.t === 'sent') && orphans.has(m.node)) { removedMem++; continue; }
      filtered.push(m);
    }
    data.memory = filtered;
    for (const id of orphans) delete nodes[id];
    report.steps.orphans.removed = orphans.size;
    report.steps.orphans.memRemoved = removedMem;
    const w = data.world;
    if (w && w.retired && typeof w.retired === 'object' && !Array.isArray(w.retired)) {
      let n = 0;
      for (const k of Object.keys(w.retired)) if (orphans.has(k)) { delete w.retired[k]; n++; }
      report.steps.orphans.retiredRemoved = n;
    }
    if (Array.isArray(data.purse)) {
      const before = data.purse.length;
      data.purse = data.purse.filter(e => !(e && typeof e === 'object' && orphans.has(e.node)));
      report.steps.orphans.purseRemoved = before - data.purse.length;
    }
  }

  let careerCount = 0;
  if (opts.career) {
    for (const id of Object.keys(nodes)) {
      const ext = nodes[id].ext;
      if (ext && typeof ext === 'object' && 'career' in ext) {
        careerCount++;
        delete ext.career;
        if (Object.keys(ext).length === 0) delete nodes[id].ext;
      }
    }
    if (Array.isArray(data.purse)) {
      const before = data.purse.length;
      data.purse = data.purse.filter(e => !(e && typeof e === 'object' && typeof e.who === 'string' && e.who.includes('职业')));
      report.steps.careerPurseRemoved = before - data.purse.length;
    }
  }
  report.steps.career = { removed: careerCount };

  let genFieldCount = 0;
  if (opts.genFields) {
    for (const id of Object.keys(nodes)) {
      const n = nodes[id];
      for (const f of GEN_FIELDS) if (f in n) { delete n[f]; genFieldCount++; }
    }
  }
  report.steps.genFields = { fields: GEN_FIELDS.slice(), removed: genFieldCount };

  let recipeCount = 0;
  if (opts.recipe) {
    for (const id of Object.keys(nodes)) if ('recipe' in nodes[id]) { delete nodes[id].recipe; recipeCount++; }
  }
  report.steps.recipe = { removed: recipeCount };

  if (opts.snapshots) {
    for (const id of Object.keys(nodes)) {
      if (nodes[id].snapshot != null && !keepSnap.has(id)) { delete nodes[id].snapshot; snapDrop++; }
    }
  }
  let snapKept = 0;
  for (const id of Object.keys(nodes)) if (nodes[id].snapshot != null) snapKept++;
  report.steps.snapshots = { total: snapTotal, kept: snapKept, dropped: snapDrop };

  // blob 重建：只保留仍被引用的（recipe/孤儿的相关 blob 在这里自动消失）
  const blobKeys = new Set(Object.keys(data.blobs || {}));
  const refs = new Set();
  for (const sec of Object.keys(data)) {
    if (sec === 'blobs') continue;
    collectBlobRefs(data[sec], blobKeys, refs);
  }
  let droppedBlobs = 0;
  for (const k of Object.keys(data.blobs || {})) if (!refs.has(k)) { delete data.blobs[k]; droppedBlobs++; }
  report.steps.blobs = { total: blobKeys.size, kept: blobKeys.size - droppedBlobs, dropped: droppedBlobs };

  return report;
}

// 输出校验：链完整 / 快照锚点 / 引用闭合 / 线索回放一致 / seq 单调
function verifySave(before, data) {
  const checks = [];
  const nodes = data.nodes || {};
  let chainsOk = true, snapOk = true;
  for (const v of data.volumes || []) {
    let cur = v.head;
    const seen = new Set();
    let hasSnap = false;
    while (cur != null) {
      if (seen.has(cur) || !nodes[cur]) { chainsOk = false; break; }
      seen.add(cur);
      if (nodes[cur].snapshot != null) hasSnap = true;
      cur = nodes[cur].parent ?? null;
    }
    if (!hasSnap) snapOk = false;
  }
  checks.push({ name: '全部卷链完整可达', ok: chainsOk });
  checks.push({ name: '每条卷链都有状态快照锚点', ok: snapOk });

  const blobKeys = new Set(Object.keys(data.blobs || {}));
  const refs = new Set();
  for (const sec of Object.keys(data)) if (sec !== 'blobs') collectBlobRefs(data[sec], blobKeys, refs);
  let refsOk = refs.size === blobKeys.size;
  if (refsOk) for (const k of refs) if (!blobKeys.has(k)) { refsOk = false; break; }
  checks.push({ name: 'blob 引用零悬挂且无冗余', ok: refsOk });

  const after = summarize(data);
  let threadsOk = before.threadState.size === after.threadState.size;
  if (threadsOk) {
    for (const [k, v] of before.threadState) {
      if (after.threadState.get(k) !== v) { threadsOk = false; break; }
    }
  }
  checks.push({ name: `线索状态回放一致（${after.threadState.size} 条）`, ok: threadsOk });
  checks.push({ name: 'memory seq 单调不重排', ok: after.seqMonotonic });
  return checks;
}

if (typeof module !== 'undefined') {
  module.exports = { slimSave, verifySave, summarize, computeReach, snapshotKeepSet, GEN_FIELDS };
}
