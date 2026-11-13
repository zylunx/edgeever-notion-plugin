import { sleep } from "../util";

/**
 * 串行请求队列（规范 §11）。
 * - 所有 Notion 请求都经过这里，避免一次同步打满并发预算。
 * - 请求之间保留最小间隔，降低 429 概率（真实限流仍以 Retry-After 为准）。
 */
export class RequestQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private nextAt = 0;

  constructor(private readonly minIntervalMs = 340) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const scheduled = this.chain.then(async () => {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextAt = Date.now() + this.minIntervalMs;
      return task();
    });
    // 单个任务失败不能阻塞后续任务
    this.chain = scheduled.catch(() => undefined);
    return scheduled as Promise<T>;
  }

  /** 同步任务内部等待（例如 429 退避）不应占着队列，由调用方在 run 外自行处理。 */
  get size(): number {
    return 0;
  }
}
