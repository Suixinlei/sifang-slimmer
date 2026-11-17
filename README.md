# 四方世界存档瘦身器

给 [四方世界](https://play.four-cornered.world/)（sifang-save v2）存档瘦身的纯前端小工具。
解析、瘦身、校验全部在你的浏览器里完成，**存档不会上传到任何服务器**。

在线使用：**https://suixinlei.github.io/sifang-slimmer/**

## 怎么用

1. （重要）先备份你的原存档 `.json`
2. 打开网页，把存档拖进去（或点击选择）
3. 勾选要执行的项（默认全开，即推荐配置）
4. 点「开始瘦身」，等报告出来，确认校验全部 ✓
5. 「下载瘦身档」，在游戏内「设置 → 存档 → 导入存档」导入

工具是幂等的：对已瘦身过的档再跑一遍不会有副作用。

## 每个选项删的是什么、有什么代价

| 选项 | 内容 | 代价 / 风险 |
|---|---|---|
| recipe 生成记录 | 每楼生成的提示词组装记录（`node.recipe` 引用的 blob），通常占档案 **70%+** | 丢失旧楼层的提示词复现 / 调试 / 审计能力；正文、思考、继续游戏、重摇当前楼层都不受影响（重摇按当前状态重组提示词） |
| 生成时字段 | `inputs / preScript / runtimeWI / seed / sentHash / usage / cost` | 丢失随机种子、逐楼玩家操作快照与 token 用量统计 |
| 职业推演检查点 | 节点 `ext.career`（职业小世界状态） | 仅当你在意「回到中途楼层恢复职业推演」；主线的属性与职业经验在状态快照里，不受影响 |
| 快照只保留每链最新 | 每条分支链保留最近一个状态快照 | 回溯到早于快照的楼层时，状态重建会退化；各卷头的当前状态不受影响 |
| 孤儿节点 | 从任何卷都不可达的节点（旧 swipe / 换版残留），连带清理悬挂的 rev/sent 日志、`world.retired` 键、`purse` 条目 | 这些节点本来就切不回去；卷上仍可达的多版本节点不会被删 |

另外会自动做一件事：**blob 按引用重建**——遍历全档收集仍被引用的 blob，未引用的一律删除，保证输出零悬挂、零冗余。

## 内置校验

瘦身完成后会自动比对前后状态，全部通过才允许下载：

- 全部卷链完整可达（head 沿 parent 能走到根）
- 每条卷链都有状态快照锚点
- blob 引用零悬挂且无冗余
- 线索（thread 开/变/结 + 手势）回放结果与瘦身前一致
- memory 日志 seq 单调、不重排

## 不变的东西

正文（raw）、思考（reasoning）、记忆日志主数据（events / scribe / cab）、人物关系与世界状态、 purse / page / revisions 等其余区块，一概不动。

## 已知限制

- 全量在内存中解析，原始大档（数百 MB）需要桌面浏览器与足够内存；手机可能吃紧
- 最大化安全起见，请始终保留一份未瘦身的原档

## 开发

纯静态三件套（`index.html` / `app.js` / `slim.js`），零依赖。`slim.js` 也可在 Node 里当模块用：

```js
const { slimSave, verifySave, summarize } = require('./slim.js');
const data = JSON.parse(fs.readFileSync('save.json', 'utf8'));
const before = summarize(data);
const report = slimSave(data, { recipe: true, genFields: true, career: true, snapshots: true, orphans: true });
console.log(report, verifySave(before, data));
```

## License

MIT
