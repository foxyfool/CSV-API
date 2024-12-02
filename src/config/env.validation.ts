import * as Joi from 'joi';

export const validationSchema = Joi.object({
  // Supabase config
  SUPABASE_URL: Joi.string().required(),
  SUPABASE_KEY: Joi.string().required(),

  // Redis config
  REDIS_URL: Joi.string().optional(),
  REDIS_HOST: Joi.string().optional(),
  REDIS_PORT: Joi.number().optional(),
  REDIS_PASSWORD: Joi.string().optional().allow(''),

  // Queue config
  QUEUE_CONCURRENT_JOBS: Joi.number().optional(),
  QUEUE_MAX_ATTEMPTS: Joi.number().optional(),
  QUEUE_TIMEOUT: Joi.number().optional(),
});
