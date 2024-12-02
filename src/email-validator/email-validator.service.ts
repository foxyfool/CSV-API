import {
  Injectable,
  Logger,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse';
import axios from 'axios';

interface EmailValidationResponse {
  email: string;
  email_status: string;
  email_mx: string;
  provider: string;
}

@Injectable()
export class EmailValidatorService {
  private readonly logger = new Logger(EmailValidatorService.name);
  private readonly BUCKET_NAME = 'csv-files';
  private readonly API_URL =
    'https://readytosend-api-production.up.railway.app/verify-email';
  private readonly MAX_RETRIES = 3;
  private readonly EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  constructor(
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  private validateEmailColumn(
    headers: string[],
    emailColumnIndex: number,
  ): void {
    console.log(
      `[Validation] Checking email column index: ${emailColumnIndex}`,
    );
    if (emailColumnIndex >= headers.length) {
      console.error(`[Validation] Invalid column index: ${emailColumnIndex}`);
      throw new BadRequestException(
        `Invalid email column index. Max index allowed: ${headers.length - 1}`,
      );
    }

    const potentialEmailColumns = headers.reduce((acc, header, index) => {
      const lowerHeader = header.toLowerCase();
      if (lowerHeader.includes('email') || this.containsEmailPattern(header)) {
        acc.push(index);
      }
      return acc;
    }, [] as number[]);

    if (!potentialEmailColumns.includes(emailColumnIndex)) {
      console.error(
        `[Validation] Invalid email column. Suggestions: ${potentialEmailColumns.join(', ')}`,
      );
      throw new BadRequestException(
        `Column ${emailColumnIndex} doesn't appear to contain emails. Suggested columns: ${potentialEmailColumns.join(', ')}`,
      );
    }
    console.log(`[Validation] Email column validated successfully`);
  }

  private containsEmailPattern(samples: string): boolean {
    return samples
      .split(',')
      .some((sample) => this.EMAIL_REGEX.test(sample.trim()));
  }

  private async verifyUserCredits(
    userEmail: string,
    requiredCredits: number,
  ): Promise<any> {
    try {
      console.log(
        `[Credits] Checking credits for ${userEmail}. Required: ${requiredCredits}`,
      );
      const { data: user, error } = await this.supabase
        .from('users')
        .select('user_id, user_email, credits')
        .eq('user_email', userEmail)
        .single();

      if (error || !user) {
        console.error(`[Credits] User not found: ${userEmail}`);
        throw new BadRequestException('User not found');
      }

      console.log(`[Credits] Available credits: ${user.credits}`);
      if (user.credits < requiredCredits) {
        console.error(
          `[Credits] Insufficient credits: ${user.credits}/${requiredCredits}`,
        );
        throw new BadRequestException(
          `Insufficient credits. Required: ${requiredCredits}, Available: ${user.credits}`,
        );
      }

      console.log(`[Credits] Verification successful for ${userEmail}`);
      return user;
    } catch (error) {
      console.error(`[Credits] Verification failed: ${error.message}`);
      throw error;
    }
  }

  private async validateEmail(
    email: string,
    retries = 0,
  ): Promise<EmailValidationResponse> {
    try {
      console.log(
        `[Validation] Attempting email validation: ${email} (Attempt ${retries + 1}/${this.MAX_RETRIES + 1})`,
      );
      const response = await axios.get<EmailValidationResponse>(
        `${this.API_URL}?email=${email}`,
        { timeout: 10000 },
      );
      console.log(
        `[Validation] Result for ${email}: ${response.data.email_status}`,
      );
      return response.data;
    } catch (error) {
      console.error(`[Validation] Error for ${email}: ${error.message}`);

      if (retries < this.MAX_RETRIES) {
        const delay = Math.min(Math.pow(2, retries) * 1000, 5000);
        console.log(`[Validation] Retrying after ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.validateEmail(email, retries + 1);
      }

      console.error(`[Validation] Failed after all retries: ${email}`);
      return {
        email,
        email_mx: 'error',
        email_status: 'invalid',
        provider: 'error',
      };
    }
  }

  async validateEmailsInCsv(params: {
    filename: string;
    emailColumnIndex: number;
    userEmail: string;
    totalEmails: number;
    fileId: string;
  }): Promise<{ message: string; status: string }> {
    console.log(`[Process] Starting validation for ${params.filename}`);
    console.log(`[Process] Email column index: ${params.emailColumnIndex}`);

    try {
      const user = await this.verifyUserCredits(
        params.userEmail,
        params.totalEmails,
      );
      let stats = { valid: 0, invalid: 0, unverifiable: 0, processed: 0 };

      console.log(`[File] Fetching file from storage`);
      const { data: fileData, error: fetchError } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .download(`uploads/${params.filename}`);

      if (fetchError) {
        console.error(`[File] Fetch error: ${fetchError.message}`);
        throw new Error(`Failed to fetch file: ${fetchError.message}`);
      }

      const buffer = Buffer.from(await fileData.arrayBuffer());
      const records = parse(buffer.toString(), {
        delimiter: ',',
        trim: true,
        skip_empty_lines: true,
        columns: false,
      });

      const processedRows: string[] = [];
      let isFirstRow = true;
      let headers: string[] = [];

      console.log(`[Process] Starting email validation`);
      for await (const record of records) {
        if (isFirstRow) {
          headers = record;
          this.validateEmailColumn(headers, params.emailColumnIndex);
          record.splice(params.emailColumnIndex + 1, 0, 'Email_Validation');
          processedRows.push(record.join(','));
          isFirstRow = false;
          continue;
        }

        const email = record[params.emailColumnIndex];
        console.log(`[Row] Processing email: ${email}`);

        if (
          !email ||
          email.trim() === '' ||
          ['null', 'undefined'].includes(email.toLowerCase())
        ) {
          record.splice(params.emailColumnIndex + 1, 0, 'invalid');
          stats.invalid++;
        } else {
          const validation = await this.validateEmail(email.trim());
          record.splice(
            params.emailColumnIndex + 1,
            0,
            validation.email_status,
          );

          if (validation.email_status === 'valid') stats.valid++;
          else if (validation.email_status === 'invalid') stats.invalid++;
          else stats.unverifiable++;
        }

        stats.processed++;
        processedRows.push(record.join(','));
        console.log(
          `[Progress] Processed ${stats.processed}/${params.totalEmails} emails`,
        );
      }

      console.log(`[File] Updating original file`);
      const finalCsv = processedRows.join('\n');
      const { error: uploadError } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .upload(`uploads/${params.filename}`, Buffer.from(finalCsv), {
          contentType: 'text/csv',
          upsert: true,
        });

      if (uploadError) {
        console.error(`[File] Upload error: ${uploadError.message}`);
        throw new Error(`Failed to update file: ${uploadError.message}`);
      }

      console.log(`[Database] Updating records`);
      await this.supabase.from('files').insert({
        file_id: params.fileId,
        created_at: new Date(),
        user_id: user.user_id,
        user_email: params.userEmail,
        stats,
        status: 'Completed',
        credits_consumed: params.totalEmails,
        object_storage_id: `uploads/${params.filename}`,
      });

      await this.supabase
        .from('users')
        .update({ credits: user.credits - params.totalEmails })
        .eq('user_id', user.user_id);

      console.log(`[Process] Validation completed successfully`);
      return {
        message: 'Validation completed successfully',
        status: 'Completed',
      };
    } catch (error) {
      console.error(`[Process] Error: ${error.message}`);

      if (error instanceof BadRequestException) {
        throw error;
      }

      await this.supabase.from('files').insert({
        file_id: params.fileId,
        created_at: new Date(),
        user_email: params.userEmail,
        stats: { error: error.message },
        status: 'Error',
        object_storage_id: `uploads/${params.filename}`,
      });

      throw error;
    }
  }
}
