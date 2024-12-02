import {
  Injectable,
  Logger,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { parse } from 'csv-parse';
import axios from 'axios';
import { Worker } from 'worker_threads';
import * as path from 'path';

interface EmailValidationResponse {
  email: string;
  email_status: string;
  email_mx: string;
  provider: string;
}

interface EmailToProcess {
  email: string;
  rowIndex: number;
  record: string[];
}
@Injectable()
export class EmailValidatorService {
  private readonly BUCKET_NAME = 'csv-files';
  private readonly EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  private readonly MAX_WORKERS = 4;

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

  private createWorker(emails: string[], workerId: number): Promise<any[]> {
    console.log(
      `[Main] Creating worker ${workerId} for ${emails.length} emails`,
    );

    return new Promise((resolve, reject) => {
      const worker = new Worker(
        path.resolve(__dirname, 'email-validator.worker.js'),
        {
          workerData: { emails, workerId },
        },
      );

      worker.on('online', () => {
        console.log(
          `[Main] Worker ${workerId} is online and starting to process ${emails.length} emails`,
        );
      });

      worker.on('message', (results) => {
        console.log(
          `[Main] Worker ${workerId} completed processing ${results.length} emails`,
        );
        resolve(results);
      });

      worker.on('error', (error) => {
        console.error(
          `[Main] Worker ${workerId} encountered error: ${error.message}`,
        );
        reject(error);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          const errorMessage = `Worker ${workerId} stopped with exit code ${code}`;
          console.error(`[Main] ${errorMessage}`);
          reject(new Error(errorMessage));
        } else {
          console.log(`[Main] Worker ${workerId} finished successfully`);
        }
      });
    });
  }

  private splitEmailsIntoChunks(
    emails: string[],
    numChunks: number,
  ): string[][] {
    const result: string[][] = Array.from({ length: numChunks }, () => []);
    emails.forEach((email, index) => {
      result[index % numChunks].push(email);
    });
    return result;
  }

  async validateEmailsInCsv(params: {
    filename: string;
    emailColumnIndex: number;
    userEmail: string;
    totalEmails: number;
    fileId: string;
  }): Promise<{ message: string; status: string }> {
    console.log(`[Process] Starting validation for ${params.filename}`);

    try {
      const user = await this.verifyUserCredits(
        params.userEmail,
        params.totalEmails,
      );
      let stats = { valid: 0, invalid: 0, unverifiable: 0, processed: 0 };

      const { data: fileData, error: fetchError } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .download(`uploads/${params.filename}`);

      if (fetchError) {
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
      const emailsToProcess: EmailToProcess[] = [];
      let isFirstRow = true;
      let headers: string[] = [];

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
        if (
          !email ||
          email.trim() === '' ||
          ['null', 'undefined'].includes(email.toLowerCase())
        ) {
          record.splice(params.emailColumnIndex + 1, 0, 'invalid');
          stats.invalid++;
          processedRows.push(record.join(','));
        } else {
          emailsToProcess.push({
            email: email.trim(),
            rowIndex: emailsToProcess.length,
            record: [...record],
          });
        }
      }

      // Split emails for parallel processing
      const emailsOnly = emailsToProcess.map((item) => item.email);
      const emailChunks = this.splitEmailsIntoChunks(
        emailsOnly,
        this.MAX_WORKERS,
      );

      console.log(
        `[Process] Starting parallel validation with ${this.MAX_WORKERS} workers`,
      );

      const workerPromises = emailChunks.map((chunk, index) =>
        this.createWorker(chunk, index + 1),
      );

      const results = await Promise.all(workerPromises);
      const validationResults = results.flat();

      try {
        console.log(`[Process] Waiting for all workers to complete`);
        const results = await Promise.all(workerPromises);
        console.log(`[Process] All workers completed successfully`);
        const validationResults = results.flat();
      } catch (error) {
        console.error(`[Process] Worker error: ${error.message}`);
        throw error;
      }

      validationResults.forEach((result, index) => {
        const { record, rowIndex } = emailsToProcess[index];
        record.splice(params.emailColumnIndex + 1, 0, result.status);

        if (result.status === 'valid') stats.valid++;
        else if (result.status === 'invalid') stats.invalid++;
        else stats.unverifiable++;

        stats.processed++;
        processedRows.push(record.join(','));
      });

      // Update file in storage
      const finalCsv = processedRows.join('\n');
      const { error: uploadError } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .upload(`uploads/${params.filename}`, Buffer.from(finalCsv), {
          contentType: 'text/csv',
          upsert: true,
        });

      if (uploadError) {
        throw new Error(`Failed to update file: ${uploadError.message}`);
      }

      // Update database records
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
