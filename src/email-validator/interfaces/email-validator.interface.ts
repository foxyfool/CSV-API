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
