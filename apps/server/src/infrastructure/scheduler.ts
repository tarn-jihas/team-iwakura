/** Coalesces triggers and prevents overlapping monitoring passes. */
export class MonitorScheduler {
  private timer:NodeJS.Timeout | null = null;
  private running:Promise<void> | null = null;
  private lastSourceAttempt = -Infinity;
  private sourceRequested = false;
  private localRequested = false;
  private stopped = false;

  constructor(private readonly run:(readSource:boolean) => Promise<void>, private readonly onError:() => void,
    private readonly clock:() => number = Date.now) {}

  private reportError():void { try { this.onError(); } catch { /* Error reporting must not stop the scheduler. */ } }

  start():void {
    if (this.timer || this.stopped) throw new Error('Scheduler cannot be started');
    this.timer = setInterval(() => { void this.pulse(); },30_000);
    this.timer.unref();
    void this.pulse();
  }

  async pulse():Promise<void> {
    if (this.stopped) return;
    if (this.running) return this.running;
    const now = this.clock();
    if (!Number.isFinite(now)) { this.reportError(); return; }
    const readSource = this.sourceRequested || now - this.lastSourceAttempt >= 60_000;
    this.sourceRequested = false;
    this.localRequested = false;
    if (readSource) this.lastSourceAttempt = now;
    this.running = Promise.resolve().then(() => this.run(readSource)).catch(() => { this.reportError(); });
    try { await this.running; }
    finally {
      this.running = null;
      if ((this.sourceRequested || this.localRequested) && !this.stopped) queueMicrotask(() => { void this.pulse(); });
    }
  }

  requestSource():void {
    if (this.stopped) return;
    this.sourceRequested = true;
    void this.pulse();
  }

  requestLocal():void {
    if (this.stopped) return;
    this.localRequested = true;
    void this.pulse();
  }

  async stop():Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
