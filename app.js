'use strict';
/* UI 胶水：文件读取 → 瘦身 → 校验 → 下载 */

const $ = (s) => document.querySelector(s);
const fmt = (n) => n.toLocaleString('zh-CN');
const fmtMB = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';

const OPTS = [
  { key: 'recipe', t: '删除 recipe 生成记录', d: '逐楼生成的提示词组装记录，通常占档案 70% 以上体积。删后不影响正文、思考、继续游戏和重摇当前楼层；丢失旧楼层的提示词复现/审计能力。', on: true },
  { key: 'genFields', t: '删除生成时字段', d: 'inputs / preScript / runtimeWI / seed / sentHash / usage / cost——生成复现、随机种子与用量统计。', on: true },
  { key: 'career', t: '删除职业推演检查点', d: '节点 ext.career（职业小世界状态）。主线的属性与职业经验在状态快照里，不受影响；仅丢失中途恢复推演的能力。', on: false },
  { key: 'snapshots', t: '快照只保留每链最新', d: '每条分支链保留最近一个状态快照。各卷头的当前状态不受影响；回溯到早于快照的楼层时状态重建会退化。', on: false },
  { key: 'orphans', t: '删除孤儿节点（旧 swipe / 换版残留）', d: '从任何卷都不可达的节点，连同悬挂的 rev/sent 日志、world.retired 键与 purse 条目。卷上仍可达的多版本节点不动。', on: true },
];

const state = { data: null, name: 'slimmed.json', inBytes: 0, before: null };

// 选项渲染
const optBox = $('#opts');
for (const o of OPTS) {
  const label = document.createElement('label');
  label.className = 'opt';
  label.innerHTML = `<input type="checkbox" data-k="${o.key}" ${o.on ? 'checked' : ''}><span><span class="t">${o.t}</span><div class="d">${o.d}</div></span>`;
  optBox.appendChild(label);
}

// 文件选择 / 拖放
const drop = $('#drop'), fileInput = $('#file');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('on'); });
drop.addEventListener('dragleave', () => drop.classList.remove('on'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('on');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });

function setStatus(msg) { $('#status').textContent = msg || ''; }

async function loadFile(file) {
  state.name = file.name.replace(/\.json$/i, '') + '.瘦身.json';
  state.inBytes = file.size;
  state.data = null;
  $('#runcard').style.display = 'none';
  $('#result').style.display = 'none';
  setStatus(`读取并解析中：${file.name}（${fmtMB(file.size)}，大档需要一两分钟，期间页面可能卡顿）…`);
  try {
    // 走字节流解析，避免超大档案触发 JS 字符串长度上限
    const data = await new Response(file.stream()).json();
    if (data.format !== 'sifang-save' || data.version !== 2) {
      setStatus('这不是 sifang-save v2 存档，已停止。'); return;
    }
    state.data = data;
    state.before = summarize(data);
    setStatus(`已加载：${(data.volumes || []).length} 个卷 · ${fmt(state.before.nodeCount)} 个节点 · ${fmt(state.before.blobCount)} 个 blob · ${fmt(state.before.memCount)} 条记忆日志 · ${fmtMB(file.size)}`);
    $('#runcard').style.display = '';
  } catch (err) {
    setStatus('解析失败：' + err.message);
  }
}

// 瘦身执行
$('#go').addEventListener('click', () => {
  if (!state.data) return;
  const opts = {};
  for (const o of OPTS) opts[o.key] = optBox.querySelector(`input[data-k="${o.key}"]`).checked;
  setStatus('瘦身处理中…');
  $('#go').disabled = true;
  setTimeout(() => {
    try {
      const t0 = performance.now();
      const report = slimSave(state.data, opts);
      const checks = verifySave(state.before, state.data);
      const out = JSON.stringify(state.data);
      const outBytes = new Blob([out]).size;
      const ms = Math.round(performance.now() - t0);
      render(report, checks, outBytes, ms, out);
      setStatus(`完成，用时 ${ms} ms。`);
    } catch (err) {
      setStatus('处理失败：' + err.message);
    } finally {
      $('#go').disabled = false;
    }
  }, 30);
});

function render(report, checks, outBytes, ms, out) {
  const saved = state.inBytes - outBytes;
  const pct = state.inBytes ? (saved / state.inBytes * 100).toFixed(1) : 0;
  $('#sizes').innerHTML =
    `<span>${fmtMB(state.inBytes)} → <span class="hl">${fmtMB(outBytes)}</span></span>` +
    `<span>节省 <span class="hl">${fmtMB(Math.max(saved, 0))}</span>（${pct}%）</span><span class="muted">${ms} ms</span>`;
  const rows = [
    ['节点', `${fmt(report.steps.orphans.found)} 个孤儿，删除 ${fmt(report.steps.orphans.removed)} 个`],
    ['记忆日志', report.steps.orphans.memRemoved ? `清理孤儿悬挂条目 ${fmt(report.steps.orphans.memRemoved)} 条（seq 保留原值不重排）` : '未改动'],
    ['职业推演检查点', `删除 ${fmt(report.steps.career.removed)} 个 ext.career`],
    ['生成时字段', `删除 ${fmt(report.steps.genFields.removed)} 处（${report.steps.genFields.fields.join('/')}）`],
    ['recipe 引用', `删除 ${fmt(report.steps.recipe.removed)} 处`],
    ['状态快照', `保留 ${fmt(report.steps.snapshots.kept)} / ${fmt(report.steps.snapshots.total)}（每链最新）`],
    ['blob', `${fmt(report.steps.blobs.total)} → ${fmt(report.steps.blobs.kept)}（清理无引用 ${fmt(report.steps.blobs.dropped)} 个）`],
  ];
  $('#statstable').innerHTML = '<tr class="hd"><td>项目</td><td>结果</td></tr>' +
    rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('');
  $('#checks').innerHTML = checks.map(c =>
    `<div class="check ${c.ok ? 'ok' : 'bad'}"><span class="mark">${c.ok ? '✓' : '✗'}</span>${c.name}${c.ok ? '' : ' —— 校验未通过，请勿导入此文件'}</div>`).join('');
  $('#result').style.display = '';

  const dl = $('#dl');
  dl.disabled = !checks.every(c => c.ok);
  dl.onclick = () => {
    const url = URL.createObjectURL(new Blob([out], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = state.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
}
