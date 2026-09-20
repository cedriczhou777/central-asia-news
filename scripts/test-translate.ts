/**
 * 翻译链路自测脚本
 *
 * 用法：
 *   1. 在项目根目录建 .env.local，写入 ZHIPU_API_KEY（可选再加 DEEPSEEK_API_KEY；
 *      型号默认值取 src/lib/translate.ts 的 PROVIDERS，可分别用
 *      ZHIPU_MODEL / DEEPSEEK_MODEL 覆盖）
 *   2. pnpm tsx scripts/test-translate.ts
 *
 * 它会拿一段英文新闻走一遍真实的 translateNews 流程，打印每个通道的尝试过程，
 * 成功打印翻译结果并退出码 0；全部通道失败则退出码 1。
 *
 * 注意：这里不碰数据库、不碰微信接口，只验证「模型能不能调通 + 返回的中文能不能解析」。
 */
import { config as loadEnv } from 'dotenv';
import { translateNews, PROVIDERS } from '../src/lib/translate';

// 先读 .env.local（本地私密配置，优先），再兜底读 .env。
// 必须在调用 translateNews 之前执行——translate.ts 是在函数内部读 process.env 的。
loadEnv({ path: '.env.local', override: true });
loadEnv({ path: '.env' });

const SAMPLE_TITLE =
  'Uzbekistan and Serbia sign $500 million energy cooperation agreement';

const SAMPLE_CONTENT = `
Uzbekistan and Serbia signed an energy cooperation agreement worth 500 million US dollars
on Monday in Tashkent, the Uzbek Ministry of Energy said in a statement.

Under the deal, Serbian companies will modernize two thermal power plants in the
Navoi region and build a new 300-megawatt solar facility near Samarkand.

The ministry said the project is expected to create around 1,200 jobs and to raise
Uzbekistan's installed generating capacity by roughly 4 percent by 2029.
`;

async function main() {
  // 通道与型号全部从 translate.ts 的 PROVIDERS 推导，不在脚本里重复写死。
  // 之前这里各写了一份默认型号，translate.ts 换型号后脚本还打着旧名字。
  const configured = PROVIDERS.filter((p) => process.env[p.keyEnv]).map(
    // 标出免费/付费：本地跑一次就能看出「降级链里谁是花钱的」，不用去翻 translate.ts
    (p) => `${p.name}（模型 ${process.env[p.modelEnv] || p.defaultModel}，${p.free ? '免费' : '付费'}）`
  );
  const unconfigured = PROVIDERS.filter((p) => !process.env[p.keyEnv]);

  if (configured.length === 0) {
    console.error('✗ 没有检测到任何翻译通道的 API Key。');
    console.error('  请在项目根目录的 .env.local 里至少配置一个：');
    for (const p of unconfigured) {
      console.error(`    ${p.keyEnv}=...      （${p.name}，默认型号 ${p.defaultModel}）`);
    }
    process.exit(1);
  }

  console.log(`已配置的翻译通道：${configured.join('、')}`);
  if (unconfigured.length > 0) {
    console.log(
      `未配置（会被跳过）：${unconfigured.map((p) => `${p.name}（缺 ${p.keyEnv}）`).join('、')}`
    );
  }
  console.log('开始翻译测试样本...\n');

  const startedAt = Date.now();
  const result = await translateNews(SAMPLE_TITLE, SAMPLE_CONTENT, 'en');
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\n──────── 结果（耗时 ${elapsed}s）────────`);
  console.log(`translated   : ${result.translated}`);
  console.log(`provider     : ${result.provider}`);
  console.log(`分类         : ${result.category ?? '（LLM 未给出合法枚举值）'}`);
  console.log(`投资者相关   : ${result.investorRelevant}`);
  console.log(`标题         : ${result.titleZh}`);
  console.log(`摘要         : ${result.summaryZh}`);
  console.log(`正文         : ${result.contentZh}`);

  if (!result.translated) {
    console.error('\n✗ 翻译失败：所有通道都没能返回合格的中文。请看上面的错误日志定位原因。');
    process.exit(1);
  }

  console.log('\n✓ 翻译链路正常。可以放心部署了。');
}

main().catch((err) => {
  console.error('脚本异常退出:', err);
  process.exit(1);
});
