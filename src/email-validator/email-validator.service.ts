import { Injectable, Logger, Inject } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { parse, Parser, Options } from 'csv-parse';
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
        { timeout: 10000 },
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

  private sanitizeCSVContent(content: Buffer): Buffer {
    let text = content.toString('utf-8');

    // Replace problematic quotes with escaped quotes
    text = text.replace(/(?<=,|\n|^)([^,\n"]*?)(?<!\\)"(?![,\n])/g, '$1\\"');

    return Buffer.from(text);
  }

  private preprocessRecord(record: Record<string, any>): Record<string, any> {
    const processed: Record<string, any> = {};

    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string') {
        // Clean up string values
        let cleanValue = value
          .replace(/(?<!\\)"/g, '\\"')
          .replace(/\\{2,}"/g, '\\"')
          .trim();

        processed[key] = cleanValue;
      } else {
        processed[key] = value;
      }
    }

    return processed;
  }

  async validateEmailsInCsv(
    filename: string,
    emailColumnIndex: number,
  ): Promise<Buffer> {
    console.log(`[validateEmailsInCsv] Starting process for file: ${filename}`);

    try {
      const { data: fileData, error: fetchError } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .download(`uploads/${filename}`);

      if (fetchError) {
        throw new Error(`Failed to fetch file: ${fetchError.message}`);
      }

      const originalBuffer = Buffer.from(await fileData.arrayBuffer());
      const sanitizedBuffer = this.sanitizeCSVContent(originalBuffer);

      const records: any[] = [];
      let headers: string[] = [];
      let isFirstRow = true;
      let processedCount = 0;

      const parserOptions: Options = {
        skipEmptyLines: true,
        trim: true,
        quote: '"',
        escape: '\\',
        relaxQuotes: true,
        relaxColumnCount: true,
        columns: true,
        cast: true,
      };

      const parser: Parser = parse(parserOptions);

      const processFile = async () => {
        try {
          parser.on('readable', async () => {
            let record;
            while ((record = parser.read()) !== null) {
              if (isFirstRow) {
                headers = Object.keys(record);
                isFirstRow = false;
                records.push([...headers, 'Result']);
                continue;
              }

              const processedRecord = this.preprocessRecord(record);
              const email = processedRecord[
                Object.keys(processedRecord)[emailColumnIndex]
              ]
                ?.toString()
                .trim();

              let validationResult: EmailValidationResponse;
              if (
                email &&
                email !== '' &&
                !['null', 'undefined'].includes(email.toLowerCase())
              ) {
                validationResult = await this.validateEmail(email);
              } else {
                validationResult = {
                  email: email || '',
                  email_status: 'invalid',
                  email_mx: 'no_email',
                  provider: 'none',
                };
              }

              const status =
                validationResult.email_status === 'valid' ? 'valid' : 'invalid';

              const rowValues = headers.map(
                (header) => processedRecord[header]?.toString() || '',
              );
              records.push([...rowValues, status]);

              processedCount++;
              if (processedCount % 5 === 0) {
                console.log(
                  `[processFile] Processed ${processedCount} records`,
                );
              }
            }
          });

          return new Promise((resolve, reject) => {
            parser.on('end', resolve);
            parser.on('error', reject);
          });
        } catch (error) {
          console.error('[processFile] Error processing record:', error);
          throw error;
        }
      };

      parser.write(sanitizedBuffer);
      parser.end();
      await processFile();

      const processedCsv = Buffer.from(
        records
          .map((row) => {
            return row
              .map((field) => {
                if (
                  typeof field === 'string' &&
                  (field.includes(',') || field.includes('"'))
                ) {
                  return `"${field.replace(/"/g, '""')}"`;
                }
                return field;
              })
              .join(',');
          })
          .join('\n'),
      );

      const { error: uploadError } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .upload(`uploads/${filename}`, processedCsv, {
          contentType: 'text/csv',
          upsert: true,
        });

      if (uploadError) {
        throw new Error(
          `Failed to upload validated file: ${uploadError.message}`,
        );
      }

      return processedCsv;
    } catch (error) {
      console.error(`[validateEmailsInCsv] Error in process:`, error);
      throw error;
    }
  }
}
