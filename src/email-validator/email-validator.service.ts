import {
  Injectable,
  Logger,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import * as Papa from 'papaparse';
import { Worker } from 'worker_threads';
import * as path from 'path';

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
    if (emailColumnIndex >= headers.length) {
      throw new BadRequestException(
        `Invalid email column index. Max index allowed: ${headers.length - 1}`,
      );
    }

    const potentialEmailColumns = headers.reduce((acc, header, index) => {
      if (
        header.toLowerCase().includes('email') ||
        this.containsEmailPattern(header)
      ) {
        acc.push(index);
      }
      return acc;
    }, [] as number[]);

    if (!potentialEmailColumns.includes(emailColumnIndex)) {
      throw new BadRequestException(
        `Column ${emailColumnIndex} doesn't appear to contain emails. Suggested columns: ${potentialEmailColumns.join(', ')}`,
      );
    }
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
    const { data: user, error } = await this.supabase
      .from('users')
      .select('user_id, user_email, credits')
      .eq('user_email', userEmail)
      .single();

    if (error || !user) {
      throw new BadRequestException('User not found');
    }

    if (user.credits < requiredCredits) {
      throw new BadRequestException(
        `Insufficient credits. Required: ${requiredCredits}, Available: ${user.credits}`,
      );
    }

    return user;
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

      if (user.credits < params.totalEmails) {
        throw new BadRequestException(
          `Insufficient credits. You need ${params.totalEmails} credits but have ${user.credits}.`,
        );
      }

      let stats = { valid: 0, invalid: 0, unverifiable: 0, processed: 0 };

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

      const emailsContent = new TextDecoder().decode(
        await emailsData.arrayBuffer(),
      );
      const fullContent = new TextDecoder().decode(
        await fullData.arrayBuffer(),
      );

      const emailsResult = Papa.parse(emailsContent, {
        delimiter: ',',
        skipEmptyLines: true,
        header: false,
      });

      const fullResult = Papa.parse(fullContent, {
        delimiter: ',',
        skipEmptyLines: true,
        header: false,
      });

      const emailsToProcess = emailsResult.data
        .slice(1)
        .map((row: string[]) => row[0]?.trim())
        .filter(Boolean);

      const emailChunks = this.splitEmailsIntoChunks(
        emailsToProcess,
        this.MAX_WORKERS,
      );

      const workerPromises = emailChunks.map((chunk, index) =>
        this.createWorker(chunk, index + 1),
      );

      const results = await Promise.all(workerPromises);
      const validationResults = results.flat();

      const processedRows: string[][] = [];
      const fullRecords = fullResult.data as string[][];

      // Add headers
      const headerRow = [...fullRecords[0]];
      headerRow.splice(params.emailColumnIndex, 0, 'Email', 'Email_Validation');
      processedRows.push(headerRow);

      // Process data rows
      fullRecords.slice(1).forEach((record, index) => {
        if (index < validationResults.length) {
          const result = validationResults[index];
          const newRow = [...record];
          newRow.splice(
            params.emailColumnIndex,
            0,
            result.email,
            result.status,
          );

          if (result.status === 'valid') stats.valid++;
          else if (result.status === 'invalid') stats.invalid++;
          else stats.unverifiable++;

          stats.processed++;
          processedRows.push(newRow);
        }
      });

      const finalCsv = Papa.unparse(processedRows);

      const { error: uploadError } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .upload(`uploads/${params.filename}`, Buffer.from(finalCsv), {
          contentType: 'text/csv',
          upsert: true,
        });

      if (uploadError) {
        throw new Error(`Failed to update file: ${uploadError.message}`);
      }

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
      throw error;
    }
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

  private createWorker(emails: string[], workerId: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        path.resolve(__dirname, 'email-validator.worker.js'),
        {
          workerData: { emails, workerId },
        },
      );

      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0)
          reject(new Error(`Worker stopped with exit code ${code}`));
      });
    });
  }
}
