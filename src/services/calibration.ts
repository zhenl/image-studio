/**
 * 生成耗时自校准：elapsed ≈ k·步数·百万像素 + 固定开销。
 * 从 images 表近期记录取中位数（鲁棒抗离群点），带 TTL 缓存。
 * 本机耗时自校准：按近期出图记录线性拟合步数/MG 像素耗时。
 */
import type { Store } from "../db/store.js";

export const FALLBACK_K = 260.0; // RTX 2060 6GB + lowvram 参考值（保守）
export const FALLBACK_OVERHEAD_S = 180.0;
const CACHE_TTL_MS = 30_000;

export interface Calibration {
  k: number;
  overheadS: number;
  samples: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

interface CacheState { ts: number; value: Calibration }

export class Calibrator {
  private cache: CacheState | null = null;

  constructor(private readonly store: Store, private readonly maxSamples = 30) {}

  /** 强制失效缓存（测试或手动刷新用）。 */
  invalidate(): void {
    this.cache = null;
  }

  calibrate(now = Date.now()): Calibration {
    if (this.cache && now - this.cache.ts < CACHE_TTL_MS) return this.cache.value;

    const ks: number[] = [];
    let value: Calibration;
    for (const r of this.store.recentImagesForCalibration(this.maxSamples)) {
      const mp = (r.width * r.height) / 1_000_000;
      if (mp <= 0) continue;
      ks.push(r.elapsed_ms / 1000 / (r.steps * mp));
    }
    // 哪怕 1 条本机实测也比跨显卡参考值准得多
    value = ks.length
      ? { k: median(ks), overheadS: 0, samples: ks.length }
      : { k: FALLBACK_K, overheadS: FALLBACK_OVERHEAD_S, samples: 0 };

    this.cache = { ts: now, value };
    return value;
  }

  /** 按参数估算耗时（秒）。 */
  estimate(width: number, height: number, steps: number, batch: number, now = Date.now()): {
    seconds: number; calibrated: boolean; samples: number;
  } {
    const cal = this.calibrate(now);
    const mp = (width * height) / 1_000_000;
    const seconds = steps * mp * cal.k * batch + cal.overheadS;
    return { seconds: Math.round(seconds * 100) / 100, calibrated: cal.samples > 0, samples: cal.samples };
  }
}
