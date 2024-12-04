export interface EnvironmentVariables {
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD?: string;
  QUEUE_CONCURRENT_JOBS: number;
  QUEUE_MAX_ATTEMPTS: number;
  QUEUE_TIMEOUT: number;
}

export const configuration = () => {
  const redisUrl = process.env.REDIS_URL;
  console.log('Redis URL:', redisUrl);

  if (!redisUrl) {
    throw new Error('REDIS_URL environment variable is required');
  }

  try {
    // Parse the URL using URL class
    const url = new URL(redisUrl);

    // Extract credentials and connection details
    const username = url.username || 'default';
    const password = url.password;
    const host = url.hostname;
    const port = parseInt(url.port, 10);

    console.log('Parsed Redis config:', {
      // Debug log
      host,
      port,
      username,
      passwordLength: password?.length,
    });

    const redisConfig = {
      host,
      port,
      password,
      username,
    };

    return {
      supabase: {
        url: process.env.SUPABASE_URL,
        key: process.env.SUPABASE_KEY,
      },
      redis: redisConfig,
      queue: {
        concurrentJobs: parseInt(process.env.QUEUE_CONCURRENT_JOBS || '4', 10),
        maxAttempts: parseInt(process.env.QUEUE_MAX_ATTEMPTS || '3', 10),
        timeout: parseInt(process.env.QUEUE_TIMEOUT || '300000', 10),
      },
    };
  } catch (error) {
    console.error('Error parsing Redis URL:', error); // Debug log
    throw new Error(`Failed to parse Redis URL: ${error.message}`);
  }
};
