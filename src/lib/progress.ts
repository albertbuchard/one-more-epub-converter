export type ProgressUnitLabel = "pages" | "scrolls" | "steps";

export type ProgressUnit = {
  label: ProgressUnitLabel;
  current: number;
  total: number;
};

export type ProgressPhase =
  | "idle"
  | "prepare"
  | "measure"
  | "capture"
  | "assemble"
  | "finalize"
  | "done"
  | "error";

export type ProgressEvent = {
  seq: number;
  running: boolean;
  phase: ProgressPhase;
  percent: number;
  stage: string;
  detail?: string;
  unit?: ProgressUnit;
  timestampMs: number;
};

export type ProgressPublishInput = Omit<ProgressEvent, "seq" | "timestampMs"> & {
  detail?: string;
  unit?: ProgressUnit;
};

export type ProgressStore = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ProgressEvent;
  publish: (next: ProgressPublishInput) => void;
};

const clampPercent = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export const createProgressStore = (initial?: ProgressEvent): ProgressStore => {
  let current: ProgressEvent =
    initial ??
    ({
      seq: 0,
      running: false,
      phase: "idle",
      percent: 0,
      stage: "Ready.",
      timestampMs: Date.now(),
    } satisfies ProgressEvent);

  const listeners = new Set<() => void>();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const getSnapshot = () => current;

  const publish = (next: ProgressPublishInput) => {
    const seq = current.seq + 1;
    current = {
      ...next,
      seq,
      percent: clampPercent(next.percent),
      timestampMs: Date.now(),
    };
    listeners.forEach((listener) => listener());
  };

  return { subscribe, getSnapshot, publish };
};

export const createRafThrottledPublisher = (store: ProgressStore) => {
  let frame = 0;
  let queued: ProgressPublishInput | null = null;

  return (next: ProgressPublishInput) => {
    queued = next;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!queued) return;
      const payload = queued;
      queued = null;
      store.publish(payload);
    });
  };
};

type PhaseWeight = {
  phase: ProgressPhase;
  weight: number;
};

export class WeightedProgress {
  private readonly weightMap = new Map<ProgressPhase, number>();
  private readonly baseMap = new Map<ProgressPhase, number>();
  private lastPercent = 0;

  constructor(phases: PhaseWeight[]) {
    const total = phases.reduce((sum, phase) => sum + phase.weight, 0) || 1;
    let base = 0;
    for (const { phase, weight } of phases) {
      const normalized = weight / total;
      this.weightMap.set(phase, normalized);
      this.baseMap.set(phase, base);
      base += normalized;
    }
  }

  percentFor(phase: ProgressPhase, fraction: number) {
    const weight = this.weightMap.get(phase);
    const base = this.baseMap.get(phase);
    if (weight === undefined || base === undefined) {
      return this.lastPercent;
    }

    const clampedFraction = Math.max(0, Math.min(1, fraction));
    const raw = 100 * (base + weight * clampedFraction);
    const next = clampPercent(raw);
    if (next < this.lastPercent) {
      return this.lastPercent;
    }
    this.lastPercent = next;
    return next;
  }
}
