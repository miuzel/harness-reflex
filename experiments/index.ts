import { createDecisionBackend } from '../dist/index.js';
import { runMicroProjectBenchmarks } from './runner.ts';

async function run() {
  console.log('===============================================================');
  console.log('  Harness Reflex: 实验性小项目基准评测 (有插件 vs 无插件)');
  console.log('===============================================================\n');

  const backend = createDecisionBackend();
  console.log(`Using Backend: [${backend.name}] (Model: ${backend.model})\n`);

  const results = await runMicroProjectBenchmarks(backend);

  console.log('\n======================== 评测对比结果汇总 ========================\n');

  for (const r of results) {
    console.log(`### ${r.taskName}`);
    console.log(`- 核心指标: ${r.metric}`);
    console.log(`  * 无插件 (Baseline):       Tokens: ${r.withoutPlugin.tokens} | 耗时: ${r.withoutPlugin.latencyMs}ms | 轮数: ${r.withoutPlugin.turns} | 效果: ${r.withoutPlugin.successRate}`);
    console.log(`  * 有插件 (Harness Reflex): Tokens: ${r.withReflexPlugin.tokens} | 耗时: ${r.withReflexPlugin.latencyMs}ms | 轮数: ${r.withReflexPlugin.turns} | 效果: ${r.withReflexPlugin.successRate}`);
    console.log(`  * 差异收益 (Delta):        Token变化: ${r.delta.tokenSavingsPercent} | 速度提升: ${r.delta.speedup} | 质量提升: ${r.delta.accuracyDelta}`);
    console.log('');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
