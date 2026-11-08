import { isMainThread } from 'node:worker_threads';

if (isMainThread && process.env.RECONCILE_BENCH_RSS_ROLE) {
  const timer = setInterval(() => {
    process.stderr.write(`__RECOVERY_RSS__ ${process.pid} ${process.memoryUsage().rss}\n`);
  }, 250);
  timer.unref();
}
