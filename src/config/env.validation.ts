import * as Joi from 'joi';

export const validationSchema = Joi.object({
  SUPABASE_URL: Joi.string().required(),
  SUPABASE_KEY: Joi.string().required(),
});
