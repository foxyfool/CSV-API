export interface EnvironmentVariables {
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
}

export const configuration = () => ({
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },
});
