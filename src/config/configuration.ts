export interface EnvironmentVariables {
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD?: string;
  QUEUE_CONCURRENT_JOBS: number;
  QUEUE_MAX_ATTEMPTS: number;
  QUEUE_TIMEOUT: number;
  REDIS_URL?: string;
}

export const configuration = () => ({
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },
  redis: {
    // If REDIS_URL exists (Render), use it; otherwise use individual configs
    url: process.env.REDIS_URL,
    host: !process.env.REDIS_URL
      ? process.env.REDIS_HOST || 'localhost'
      : undefined,
    port: !process.env.REDIS_URL
      ? parseInt(process.env.REDIS_PORT || '6379', 10)
      : undefined,
    password: !process.env.REDIS_URL ? process.env.REDIS_PASSWORD : undefined,
  },
  queue: {
    concurrentJobs: parseInt(process.env.QUEUE_CONCURRENT_JOBS || '4', 10),
    maxAttempts: parseInt(process.env.QUEUE_MAX_ATTEMPTS || '3', 10),
    timeout: parseInt(process.env.QUEUE_TIMEOUT || '300000', 10),
  },
});
