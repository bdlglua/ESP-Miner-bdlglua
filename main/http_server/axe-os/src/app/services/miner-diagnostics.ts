export interface Incident {
  sequence: number;
  reason: string;
  bootVersion: string;
  task?: string;
  panic?: string;
  elfSha256?: string;
  pc?: number;
  partialTrace?: boolean;
  backtrace?: number[];
}

export interface IncidentHistory {
  persisted: boolean;
  crashCaptureEnabled: boolean;
  entries: Incident[];
}

export interface PoolCounters {
  host: string;
  port: number;
  accepted: number;
  rejected: number;
  lastMs?: number;
  averageMs?: number;
  reasons: {message: string; count: number}[];
}

export interface PoolStatistics {
  selected?: 'primary' | 'fallback';
  primary: PoolCounters;
  fallback: PoolCounters;
  switches: {pool: 'primary' | 'fallback'; reason: string; uptimeSeconds: number}[];
}
