/**
 * 翻译链路自测脚本
 *
 * 用法：
 *   1. 在项目根目录建 .env.local，写入 ZHIPU_API_KEY（可选再加 DEEPSEEK_API_KEY）
 *   2. pnpm tsx scripts/test-translate.ts
 *
 * 它会拿一段英文新闻走一遍真实的 translateNews 流程，打印每个通道的尝试过程，
 * 成功打印翻译结果并退出码 0；全部通道失败则退出码 1。
 *
 * 注意：这里不碰数据库、不碰微信接口，只验证「模型能不能调通 + 返回的中文能不能解析」。
 */
import { config as loadEnv } from 'dotenv';
import { translateNews } from '../src/lib/translate';

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
  const configured = [
    process.env.ZHIPU_API_KEY ? `zhipu（模型 ${process.env.ZHIPU_MODEL || 'glm-4.7-flash'}）` : null,
    process.env.DEEPSEEK_API_KEY ? `deepseek（模型 ${process.env.DEEPSEEK_MODEL || 'deepseek-chat'}）` : null,
  ].filter(Boolean);

  if (configured.length === 0) {
    console.error('✗ 没有检测到任何翻译通道的 API Key。');
    console.error('  请在项目根目录的 .env.local 里至少配置一个：');
    console.error('    ZHIPU_API_KEY=...      （智谱，glm-4.7-flash 当前免费）');
    console.error('    DEEPSEEK_API_KEY=...   （DeepSeek，按量付费）');
    process.exit(1);
  }

  console.log(`已配置的翻译通道：${configured.join('、')}`);
  console.log('开始翻译测试样本...\n');

  const startedAt = Date.now();
  const result = await translateNews(SAMPLE_TITLE, SAMPLE_CONTENT, 'en');
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\n──────── 结果（耗时 ${elapsed}s）────────`);
  console.log(`translated : ${result.translated}`);
  console.log(`provider   : ${result.provider}`);
  console.log(`投资相关   : ${result.isInvestmentRelated}`);
  console.log(`标题       : ${result.titleZh}`);
  console.log(`摘要       : ${result.summaryZh}`);
  console.log(`正文       : ${result.contentZh}`);

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
