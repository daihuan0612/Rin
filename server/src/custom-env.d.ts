import type { QueueTask } from "./queue";

declare global {
  interface Env {
    TASK_QUEUE?: Queue<QueueTask>;
    R2_BUCKET?: R2Bucket;
    CLOUDFLARE_PURGE_TOKEN?: string;
    CLOUDFLARE_ZONE_ID?: string;
  }
}

export {};
