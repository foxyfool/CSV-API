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
import e from 'express';

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
    fullFilename: string;
    emailsFilename: string;
  }): Promise<{ message: string; status: string }> {
    try {
      const user = await this.verifyUserCredits(
        params.userEmail,
        params.totalEmails,
      );
      let stats = { valid: 0, invalid: 0, unverifiable: 0, processed: 0 };

      // Fetch both files
      const [{ data: emailsData }, { data: fullData }] = await Promise.all([
        this.supabase.storage
          .from(this.BUCKET_NAME)
          .download(`uploads/${params.emailsFilename}`),
        this.supabase.storage
          .from(this.BUCKET_NAME)
          .download(`uploads/${params.fullFilename}`),
      ]);

      if (!emailsData || !fullData) {
        throw new Error('Failed to fetch files');
      }

      // Parse both files
      const emailsBuffer = Buffer.from(await emailsData.arrayBuffer());
      const fullBuffer = Buffer.from(await fullData.arrayBuffer());

      const emailsRecords = parse(emailsBuffer.toString(), {
        delimiter: ',',
        trim: true,
        skip_empty_lines: true,
        columns: false,
      });

      const fullRecords = parse(fullBuffer.toString(), {
        delimiter: ',',
        trim: true,
        skip_empty_lines: true,
        columns: false,
      });

      // Process emails
      const emailsToProcess: string[] = [];
      let skipFirstRow = true;

      for await (const record of emailsRecords) {
        if (skipFirstRow) {
          skipFirstRow = false;
          continue;
        }
        if (record[0] && record[0].trim()) {
          emailsToProcess.push(record[0].trim());
        }
      }

      // Process emails using workers
      const emailChunks = this.splitEmailsIntoChunks(
        emailsToProcess,
        this.MAX_WORKERS,
      );
      const workerPromises = emailChunks.map((chunk, index) =>
        this.createWorker(chunk, index + 1),
      );

      let validationResults: any[] = [];
      try {
        const results = await Promise.all(workerPromises);
        validationResults = results.flat();
      } catch (error) {
        throw error;
      }

      // Prepare final file content
      const processedRows: string[] = [];
      skipFirstRow = true;
      let validationIndex = 0;

      for await (const fullRecord of fullRecords) {
        if (skipFirstRow) {
          // Add headers for email and validation
          fullRecord.splice(params.emailColumnIndex, 0, 'Email');
          fullRecord.splice(params.emailColumnIndex + 1, 0, 'Email_Validation');
          processedRows.push(fullRecord.join(','));
          skipFirstRow = false;
          continue;
        }

        if (validationIndex < validationResults.length) {
          const result = validationResults[validationIndex];
          // Add email and validation result
          fullRecord.splice(params.emailColumnIndex, 0, result.email);
          fullRecord.splice(params.emailColumnIndex + 1, 0, result.status);

          if (result.status === 'valid') stats.valid++;
          else if (result.status === 'invalid') stats.invalid++;
          else stats.unverifiable++;

          stats.processed++;
          validationIndex++;
        }

        processedRows.push(fullRecord.join(','));
      }

      // Write back to original file
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

      // Update database records and cleanup
      await Promise.all([
        this.supabase.from('files').insert({
          file_id: params.fileId,
          created_at: new Date(),
          user_id: user.user_id,
          user_email: params.userEmail,
          stats,
          status: 'Completed',
          credits_consumed: params.totalEmails,
          object_storage_id: `uploads/${params.filename}`,
        }),
        this.supabase
          .from('users')
          .update({ credits: user.credits - params.totalEmails })
          .eq('user_id', user.user_id),
        // Cleanup split files
        this.supabase.storage
          .from(this.BUCKET_NAME)
          .remove([
            `uploads/${params.fullFilename}`,
            `uploads/${params.emailsFilename}`,
          ]),
      ]);

      return {
        message: 'Validation completed successfully',
        status: 'Completed',
      };
    } catch (error) {
      console.error(`[Validation] Error occurred: ${error.message}`);
      throw error;
    }
  }
}
