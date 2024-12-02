export interface EmailValidationResponse {
  email: string;
  email_mx: string;
  email_status: 'valid' | 'invalid';
  provider: string;
}

export interface ValidationStats {
  total: number;
  valid: number;
  invalid: number;
  noEmail: number;
  error: number;
}

export interface ValidationJob {
  filename: string;
  emailColumnIndex: number;
  userEmail: string;
  totalEmails: number;
  fileId: string;
}

export interface ValidationResult {
  email: string;
  status: 'valid' | 'invalid';
  mx: string;
  provider: string;
}
