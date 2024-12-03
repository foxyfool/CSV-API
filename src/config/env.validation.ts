import * as Joi from 'joi';

export const validationSchema = Joi.object({
  // Supabase config
  SUPABASE_URL: Joi.string().required(),
  SUPABASE_KEY: Joi.string().required(),

  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().optional().allow(''),

  // Queue config
  QUEUE_CONCURRENT_JOBS: Joi.number().optional(),
  QUEUE_MAX_ATTEMPTS: Joi.number().optional(),
  QUEUE_TIMEOUT: Joi.number().optional(),
});
