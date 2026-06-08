import fs from 'node:fs';
import path from 'node:path';

const [runDirArg] = process.argv.slice(2);

if (!runDirArg) {
  console.error('Usage: node scripts/generate_capacity_report.mjs <run-dir>');
  process.exit(1);
}

const runDir = path.resolve(runDirArg);
const files = fs.readdirSync(runDir).filter((name) => name.endsWith('_summary.json'));
const summaries = files
  .map((name) => readJson(path.join(runDir, name)))
  .filter(Boolean)
  .sort((a, b) => String(a.testRunId || '').localeCompare(String(b.testRunId || '')));

const byCase = groupBy(summaries, (summary) => summary.testCase);
const written = [];

for (const testCase of ['TC01', 'TC03', 'TC06', 'TC07']) {
  const rows = byCase.get(testCase) || [];

  if (rows.length === 0) {
    continue;
  }

  const report = buildReport(testCase, rows);
  const reportPath = path.join(runDir, `${testCase.toLowerCase()}_capacity_report.md`);
  fs.writeFileSync(reportPath, report);
  written.push(reportPath);
}

const indexPath = path.join(runDir, 'capacity_index.md');
fs.writeFileSync(indexPath, buildIndex(byCase, written));
written.push(indexPath);

for (const file of written) {
  console.log(file);
}

function buildReport(testCase, rows) {
  if (testCase === 'TC01') return buildTc01Report(rows);
  if (testCase === 'TC03') return buildTc03Report(rows);
  if (testCase === 'TC06') return buildTc06Report(rows);
  if (testCase === 'TC07') return buildTc07Report(rows);
  return '';
}

function buildTc01Report(rows) {
  const enriched = rows.map((row) => {
    const metrics = row.metrics || row.overall || {};
    const expected = Number(row.pollRps || 0) * durationSeconds(row.testDuration);
    const completed = count(metrics, 'tasks_completed');
    const dropped = rawDropped(row);
    return {
      row,
      targetRps: Number(row.pollRps || 0),
      expected,
      completed,
      achievedRps: ratio(completed, durationSeconds(row.testDuration)),
      pollP95: p95(metrics, 'poll_attempt_latency'),
      updateP95: p95(metrics, 'task_update_latency'),
      errors: count(metrics, 'errors') + count(metrics, 'poll_errors') + count(metrics, 'complete_errors'),
      dropped,
      stable: Boolean(row.derived?.isStable) && dropped === 0 && p95(metrics, 'poll_attempt_latency') <= 500 && p95(metrics, 'task_update_latency') <= 500,
    };
  }).sort((a, b) => a.targetRps - b.targetRps);

  const best = last(enriched.filter((item) => item.stable));
  return [
    '# TC01 Capacity Report - Preloaded Workflow Poll Task',
    '',
    '## Summary',
    '',
    best
      ? `本輪最大短跑 SLA candidate 是 **${best.targetRps} poll RPS**，實際 completed RPS 約 ${fmt(best.achievedRps)}。`
      : '本輪沒有找到符合 500ms latency guardrail 與零錯誤條件的短跑 SLA candidate。',
    '',
    '## Capacity Sweep',
    '',
    '| Target RPS | Completed / Expected | Achieved RPS | Dropped | Poll p95 ms | Complete p95 ms | Errors | SLA Pass |',
    '|---:|---:|---:|---:|---:|---:|---:|:---:|',
    ...enriched.map((item) => `| ${item.targetRps} | ${item.completed}/${fmt0(item.expected)} | ${fmt(item.achievedRps)} | ${item.dropped} | ${fmt(item.pollP95)} | ${fmt(item.updateP95)} | ${item.errors} | ${pass(item.stable)} |`),
    '',
    '## Interpretation',
    '',
    'TC01 只量測 preloaded backlog 下的單 queue `poll -> complete` 能力，不把 workflow create 算進 capacity scoring。短跑 SLA candidate 需同時滿足零錯誤、零 dropped iterations、poll/update p95 低於 500ms。',
    '',
    artifactLine(),
  ].join('\n');
}

function buildTc03Report(rows) {
  const enriched = rows.map((row) => {
    const metrics = row.overall || row.metrics || {};
    const expected = Number(row.expectedTotalPollRps || 0) * durationSeconds(row.testDuration);
    const completed = count(metrics, 'tasks_completed');
    const dropped = rawDropped(row);
    const stable = Boolean(row.derived?.isStable) && dropped === 0 && p95(metrics, 'poll_attempt_latency') <= 500 && p95(metrics, 'task_update_latency') <= 500;
    return {
      row,
      pairCount: Number(row.pairCount || 0),
      pairPollRps: Number(row.pairPollRps || 0),
      expectedTotalPollRps: Number(row.expectedTotalPollRps || 0),
      expected,
      completed,
      achievedRps: row.derived?.actualTaskCompletedRps ?? ratio(completed, durationSeconds(row.testDuration)),
      efficiency: row.derived?.scalingEfficiency ?? 0,
      pollP95: p95(metrics, 'poll_attempt_latency'),
      updateP95: p95(metrics, 'task_update_latency'),
      errors: count(metrics, 'errors') + count(metrics, 'poll_errors') + count(metrics, 'complete_errors'),
      dropped,
      stable,
    };
  }).sort((a, b) => (a.expectedTotalPollRps - b.expectedTotalPollRps) || (a.pairCount - b.pairCount));

  const best = last(enriched.filter((item) => item.stable));
  return [
    '# TC03 Capacity Report - Preloaded Independent Poll Scaling',
    '',
    '## Summary',
    '',
    best
      ? `本輪最大短跑 SLA candidate 是 **${best.pairCount} pairs x ${best.pairPollRps} RPS**，total target ${best.expectedTotalPollRps} RPS，scaling efficiency ${fmt(best.efficiency)}。`
      : '本輪沒有找到符合多 pair 500ms latency guardrail 的短跑 SLA candidate。',
    '',
    '## Capacity Sweep',
    '',
    '| Round | Target Total RPS | Completed / Expected | Achieved RPS | Efficiency | Dropped | Poll p95 ms | Complete p95 ms | Errors | SLA Pass |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|:---:|',
    ...enriched.map((item) => `| ${item.pairCount} pairs x ${item.pairPollRps} | ${item.expectedTotalPollRps} | ${item.completed}/${fmt0(item.expected)} | ${fmt(item.achievedRps)} | ${fmt(item.efficiency)} | ${item.dropped} | ${fmt(item.pollP95)} | ${fmt(item.updateP95)} | ${item.errors} | ${pass(item.stable)} |`),
    '',
    '## Interpretation',
    '',
    'TC03 觀察多 workflow/task pair 的 queue scaling。SLA candidate 不只看 total throughput，還必須確認每輪沒有 dropped iterations，且整體 poll/update latency 仍低於 guardrail。',
    '',
    artifactLine(),
  ].join('\n');
}

function buildTc06Report(rows) {
  const enriched = rows.map((row) => {
    const metrics = row.overall || row.metrics || {};
    const workflowRps = Number(row.workflowStartRps || 0);
    const expectedStarts = workflowRps * durationSeconds(row.testDuration);
    const started = count(metrics, 'workflows_started');
    const completed = count(metrics, 'tasks_completed');
    const failed = count(metrics, 'tasks_failed');
    const attempts = row.derived?.taskAttempts ?? completed + failed;
    const dropped = rawDropped(row);
    const stable = Boolean(row.derived?.isStable) && dropped === 0 && p95(metrics, 'workflow_start_latency') <= 500 && p95(metrics, 'task_update_latency') <= 500;
    return {
      row,
      workflowRps,
      pollRps: Number(row.pollRps || 0),
      failRatio: Number(row.failRatio || 0),
      expectedStarts,
      started,
      completed,
      failed,
      attempts,
      attemptRps: row.derived?.actualTaskAttemptRps ?? ratio(attempts, durationSeconds(row.testDuration)),
      observedAmp: row.derived?.observedRetryAmplification ?? ratio(attempts, started),
      theoreticalAmp: row.derived?.theoreticalRetryAmplification ?? 0,
      startP95: p95(metrics, 'workflow_start_latency'),
      updateP95: p95(metrics, 'task_update_latency'),
      errors: count(metrics, 'errors') + count(metrics, 'workflow_start_errors') + count(metrics, 'poll_errors') + count(metrics, 'complete_errors') + count(metrics, 'fail_update_errors'),
      dropped,
      stable,
    };
  }).sort((a, b) => a.workflowRps - b.workflowRps);

  const best = last(enriched.filter((item) => item.stable));
  const firstCliff = enriched.find((item) => !item.stable);
  return [
    '# TC06 Capacity Report - Retry Storm',
    '',
    '## Summary',
    '',
    best
      ? `本輪在 fail ratio ${fmt(best.failRatio)} 下，最大短跑 SLA candidate 是 **${best.workflowRps} workflow starts/s**，實際 task attempt RPS 約 ${fmt(best.attemptRps)}。`
      : '本輪沒有找到符合 retry storm guardrail 的短跑 SLA candidate。',
    firstCliff
      ? `第一個不穩定觀察點是 ${firstCliff.workflowRps} workflow starts/s。`
      : '本輪掃描範圍內尚未觀察到 cliff。',
    '',
    '## Capacity Sweep',
    '',
    '| Start RPS | Poll RPS | Started / Expected | Completed | Failed Attempts | Attempt RPS | Observed Amp | Theoretical Amp | Dropped | Start p95 ms | Update p95 ms | Errors | SLA Pass |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|',
    ...enriched.map((item) => `| ${item.workflowRps} | ${item.pollRps} | ${item.started}/${fmt0(item.expectedStarts)} | ${item.completed} | ${item.failed} | ${fmt(item.attemptRps)} | ${fmt(item.observedAmp)} | ${fmt(item.theoreticalAmp)} | ${item.dropped} | ${fmt(item.startP95)} | ${fmt(item.updateP95)} | ${item.errors} | ${pass(item.stable)} |`),
    '',
    '## Interpretation',
    '',
    'TC06 的 capacity 不是單純 workflow start RPS，而是 retry policy 放大後的 task attempt pressure。SLA candidate 需同時滿足 start/update latency、API error、dropped iterations、completion ratio 與 retry amplification 可解釋性。',
    '',
    artifactLine(),
  ].join('\n');
}

function buildTc07Report(rows) {
  const enriched = rows.map((row) => {
    const metrics = row.overall || row.metrics || {};
    const workflowRps = Number(row.workflowStartRps || 0);
    const expectedStarts = workflowRps * durationSeconds(row.testDuration);
    const started = count(metrics, 'workflows_started');
    const crashed = count(metrics, 'crashed_tasks');
    const recovered = count(metrics, 'recovered_tasks');
    const completed = row.derived?.totalCompletedTasks ?? count(metrics, 'crash_worker_tasks_completed') + count(metrics, 'recovery_worker_tasks_completed');
    const dropped = rawDropped(row);
    const recoveryP95 = p95(metrics, 'estimated_recovery_latency');
    const stable = Boolean(row.derived?.isStable) && dropped === 0 && recoveryP95 <= 60000;
    return {
      row,
      workflowRps,
      crashPollRps: Number(row.crashWorkerPollRps || 0),
      recoveryPollRps: Number(row.recoveryWorkerPollRps || 0),
      crashRatio: Number(row.crashRatio || 0),
      expectedStarts,
      started,
      crashed,
      recovered,
      completed,
      recoveredRatio: row.derived?.recoveredToCrashedRatio ?? ratio(recovered, crashed),
      completedRatio: row.derived?.totalCompletedToStartedRatio ?? ratio(completed, started),
      recoveryP95,
      updateP95: p95(metrics, 'task_update_latency'),
      errors: count(metrics, 'errors') + count(metrics, 'workflow_start_errors') + count(metrics, 'poll_errors') + count(metrics, 'complete_errors'),
      dropped,
      stable,
    };
  }).sort((a, b) => a.workflowRps - b.workflowRps);

  const best = last(enriched.filter((item) => item.stable));
  const firstCliff = enriched.find((item) => !item.stable);
  return [
    '# TC07 Capacity Report - Worker Crash Recovery',
    '',
    '## Summary',
    '',
    best
      ? `本輪在 crash ratio ${fmt(best.crashRatio)} 下，最大短跑 SLA candidate 是 **${best.workflowRps} workflow starts/s**，recovered-to-crashed ratio ${fmt(best.recoveredRatio)}。`
      : '本輪沒有找到符合 recovery guardrail 的短跑 SLA candidate。',
    firstCliff
      ? `第一個不穩定觀察點是 ${firstCliff.workflowRps} workflow starts/s。`
      : '本輪掃描範圍內尚未觀察到 cliff。',
    '',
    '## Capacity Sweep',
    '',
    '| Start RPS | Crash Poll RPS | Recovery Poll RPS | Started / Expected | Crashed | Recovered | Completed Ratio | Recovered Ratio | Recovery p95 ms | Dropped | Errors | SLA Pass |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|',
    ...enriched.map((item) => `| ${item.workflowRps} | ${item.crashPollRps} | ${item.recoveryPollRps} | ${item.started}/${fmt0(item.expectedStarts)} | ${item.crashed} | ${item.recovered} | ${fmt(item.completedRatio)} | ${fmt(item.recoveredRatio)} | ${fmt(item.recoveryP95)} | ${item.dropped} | ${item.errors} | ${pass(item.stable)} |`),
    '',
    '## Interpretation',
    '',
    'TC07 使用 `TASK_TIMEOUT_POLICY=RETRY` 量測 worker poll 後不回報時，task timeout retry 與 recovery worker 的恢復能力。第一版 recovery latency 是從 workflow createdAtMs 到 recovery complete 的近似值，不能解讀為精準 crash-to-repoll latency。',
    '',
    artifactLine(),
  ].join('\n');
}

function buildIndex(byCase, reports) {
  const lines = [
    '# Capacity Run Index',
    '',
    `Artifacts directory: \`${runDir}\``,
    '',
    '| Test Case | Rounds | Report |',
    '|---|---:|---|',
  ];

  for (const testCase of ['TC01', 'TC03', 'TC06', 'TC07']) {
    const rows = byCase.get(testCase) || [];
    if (rows.length === 0) continue;
    const report = `${testCase.toLowerCase()}_capacity_report.md`;
    lines.push(`| ${testCase} | ${rows.length} | [${report}](./${report}) |`);
  }

  lines.push('', 'Each round also archives its custom summary and raw k6 summary JSON.');
  return lines.join('\n');
}

function readJson(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    json.__file = file;
    json.__rawFile = file.replace(/_summary\.json$/, '_raw_summary.json');
    return json;
  } catch {
    return null;
  }
}

function rawDropped(summary) {
  if (!fs.existsSync(summary.__rawFile)) return 0;
  const raw = readJson(summary.__rawFile);
  return count(raw?.metrics || {}, 'dropped_iterations');
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function count(metrics, name) {
  return Number(metrics?.[name]?.values?.count || 0);
}

function p95(metrics, name) {
  return Number(metrics?.[name]?.values?.['p(95)'] || 0);
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function durationSeconds(value) {
  const match = String(value || '0s').match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2] || 's';
  if (unit === 'ms') return amount / 1000;
  if (unit === 'm') return amount * 60;
  if (unit === 'h') return amount * 3600;
  return amount;
}

function last(items) {
  return items.length ? items[items.length - 1] : null;
}

function fmt(value) {
  if (!Number.isFinite(Number(value))) return '0.0';
  return Number(value).toFixed(1);
}

function fmt0(value) {
  if (!Number.isFinite(Number(value))) return '0';
  return String(Math.round(Number(value)));
}

function pass(value) {
  return value ? 'PASS' : 'FAIL';
}

function artifactLine() {
  return '## Artifacts\n\nRaw and selected summaries are archived in the same capacity run directory.';
}
