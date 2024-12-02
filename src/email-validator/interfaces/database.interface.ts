export interface SupabaseUser {
  user_id: string;
  user_email: string;
  credits: number;
}

export interface FileRecord {
  file_id: string;
  created_at: Date;
  user_id: string;
  user_email: string;
  stats: {
    valid_emails: number;
    invalid_emails: number;
    unverifiable_emails: number;
    total_emails: number;
  };
  status: 'In Queue' | 'Validating' | 'Completed';
  credits_consumed: number;
  sheet_id?: string;
  sheet_import?: boolean;
  object_storage_id?: string;
}
