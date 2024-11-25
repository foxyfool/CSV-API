import { Injectable, Logger, Inject } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import * as csv from 'csv-parse';

import axios from 'axios';
import { EmailValidationResponse } from './interfaces/email-validator.interface';

@Injectable()
export class EmailValidatorService {
  private readonly logger = new Logger(EmailValidatorService.name);
  private readonly BUCKET_NAME = 'csv-files';
  private readonly API_URL =
    'https://readytosend-api-production.up.railway.app/verify-email';

  constructor(
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {
    console.log('EmailValidatorService initialized');
  }

  private async validateEmail(email: string): Promise<EmailValidationResponse> {
    console.log(`[validateEmail] Starting validation for email: ${email}`);
    try {
      const response = await axios.get<EmailValidationResponse>(
        `${this.API_URL}?email=${email}`,
        { timeout: 5000 },
      );
      console.log(
        `[validateEmail] Successfully validated email: ${email}`,
        response.data,
      );
      return response.data;
    } catch (error) {
      console.error(
        `[validateEmail] Error validating email ${email}:`,
        error.message,
      );
      return {
        email: email,
        email_mx: 'error',
        email_status: 'invalid',
        provider: 'error',
      };
    }
  }

  async validateEmailsInCsv(
    filename: string,
    emailColumnIndex: number,
  ): Promise<Buffer> {
    console.log(`[validateEmailsInCsv] Starting process for file: ${filename}`);
    console.log(
      `[validateEmailsInCsv] Using email column index: ${emailColumnIndex}`,
    );

    try {
      console.log(`[validateEmailsInCsv] Fetching file from Supabase storage`);
      const { data: fileData, error: fetchError } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .download(`uploads/${filename}`);

      if (fetchError) {
        console.error(
          `[validateEmailsInCsv] Failed to fetch file:`,
          fetchError,
        );
        throw new Error(`Failed to fetch file: ${fetchError.message}`);
      }

      console.log(`[validateEmailsInCsv] File fetched successfully`);
      const buffer = Buffer.from(await fileData.arrayBuffer());
      console.log(
        `[validateEmailsInCsv] File converted to buffer, size: ${buffer.length} bytes`,
      );

      const records: string[][] = [];
      let headers: string[] = [];
      let isFirstRow = true;
      let processedCount = 0;
      let totalRows = 0;

      console.log(`[validateEmailsInCsv] Setting up CSV parser`);
      const parser = csv.parse({
        skipEmptyLines: false,
        trim: true,
        fromLine: 1,
      });

      console.log(`[validateEmailsInCsv] Starting CSV processing`);

      // Process the CSV content
      const processFile = async () => {
        console.log(`[processFile] Starting file processing`);

        for await (const record of parser) {
          console.log(`[processFile] Processing row ${totalRows + 1}`);

          if (isFirstRow) {
            console.log(`[processFile] Processing header row`, record);
            headers = [...record, 'Result'];
            records.push(headers);
            isFirstRow = false;
            console.log(`[processFile] Headers processed:`, headers);
            continue;
          }

          if (!Array.isArray(record) || record.length <= emailColumnIndex) {
            console.error(
              `[processFile] Invalid record or email column index out of bounds`,
              {
                recordLength: record.length,
                emailColumnIndex,
                record,
              },
            );
            continue;
          }

          const email = record[emailColumnIndex]?.toString().trim();
          console.log(`[processFile] Processing email: ${email}`);

          let validationResult: EmailValidationResponse;

          if (
            email &&
            email !== '' &&
            email.toLowerCase() !== 'null' &&
            email.toLowerCase() !== 'undefined'
          ) {
            console.log(`[processFile] Validating email: ${email}`);
            validationResult = await this.validateEmail(email);
            console.log(`[processFile] Validation result:`, validationResult);
          } else {
            console.log(
              `[processFile] Empty or invalid email, marking as invalid`,
            );
            validationResult = {
              email: email || '',
              email_status: 'invalid',
              email_mx: 'no_email',
              provider: 'none',
            };
          }

          // Simplified result - only valid or invalid
          const status =
            validationResult.email_status === 'valid' ? 'valid' : 'invalid';
          const newRecord = [...record, status];
          records.push(newRecord);

          processedCount++;
          totalRows++;

          if (processedCount % 5 === 0) {
            console.log(`[processFile] Processed ${processedCount} records`);
          }
        }

        console.log(
          `[processFile] File processing completed. Total rows processed: ${totalRows}`,
        );
      };

      console.log(`[validateEmailsInCsv] Writing buffer to parser`);
      parser.write(buffer);
      console.log(`[validateEmailsInCsv] Ending parser input`);
      parser.end();

      console.log(
        `[validateEmailsInCsv] Waiting for file processing to complete`,
      );
      await processFile();

      console.log(`[validateEmailsInCsv] Converting processed records to CSV`);
      const processedCsv = Buffer.from(
        records.map((row) => row.join(',')).join('\n'),
      );

      console.log(
        `[validateEmailsInCsv] Uploading processed file, overwriting original`,
      );

      const { error: uploadError } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .upload(`uploads/${filename}`, processedCsv, {
          contentType: 'text/csv',
          upsert: true,
        });

      if (uploadError) {
        console.error(`[validateEmailsInCsv] Upload error:`, uploadError);
        throw new Error(
          `Failed to upload validated file: ${uploadError.message}`,
        );
      }

      console.log(`[validateEmailsInCsv] Process completed successfully`);
      return processedCsv;
    } catch (error) {
      console.error(`[validateEmailsInCsv] Error in process:`, error);
      throw error;
    }
  }
}
