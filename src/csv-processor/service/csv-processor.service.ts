import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { parse, Options as CsvOptions, Parser } from 'csv-parse';
import { Transform, pipeline } from 'stream';
import { promisify } from 'util';
import { Readable } from 'stream';
import {
  CsvPreviewStats,
  ProcessingOptions,
} from '../interfaces/csv-processor.interface';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class CsvProcessorService {
  private readonly logger = new Logger(CsvProcessorService.name);
  private readonly BUCKET_NAME = 'csv-files';
  private readonly pipelineAsync = promisify(pipeline);

  constructor(
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  private createStreamFromBuffer(buffer: Buffer): Readable {
    return Readable.from(buffer);
  }

  private createParser(options: Partial<CsvOptions> = {}): Parser {
    return parse({
      skipEmptyLines: true,
      trim: true,
      ...options,
    });
  }

  private async validateEmailColumn(
    buffer: Buffer,
    emailColumnIndex: number,
  ): Promise<{ columnName: string; hasInconsistentColumns: boolean }> {
    const input = this.createStreamFromBuffer(buffer);
    let hasInconsistentColumns = false;

    return new Promise((resolve, reject) => {
      let isResolved = false;
      let headerLength = 0;

      const headerValidator = new Transform({
        objectMode: true,
        transform(row: string[], encoding: string, callback: Function) {
          if (isResolved) {
            // Check subsequent rows for inconsistent column counts
            if (row.length !== headerLength) {
              hasInconsistentColumns = true;
            }
            callback();
            return;
          }

          if (!Array.isArray(row) || row.length <= emailColumnIndex) {
            callback(
              new BadRequestException(
                `Column index ${emailColumnIndex} does not exist in the CSV file`,
              ),
            );
            return;
          }

          headerLength = row.length;
          const columnName = row[emailColumnIndex]?.toString() || '';
          if (!columnName.toLowerCase().includes('email')) {
            callback(
              new BadRequestException(
                `Column at index ${emailColumnIndex} is not an email column. Found: ${columnName}`,
              ),
            );
            return;
          }

          isResolved = true;
          resolve({ columnName, hasInconsistentColumns });
          callback();
        },
      });

      this.pipelineAsync(input, this.createParser(), headerValidator).catch(
        reject,
      );
    });
  }

  async previewCSV(
    buffer: Buffer,
    emailColumnIndex: number,
  ): Promise<CsvPreviewStats> {
    // First validate the email column
    const { columnName } = await this.validateEmailColumn(
      buffer,
      emailColumnIndex,
    );

    // Create a fresh stream for processing
    const input = this.createStreamFromBuffer(buffer);

    const stats: CsvPreviewStats = {
      totalEmails: 0,
      totalRows: 0,
      totalEmptyEmails: 0,
      totalDuplicateEmails: 0,
      columnName,
    };

    const emailSet = new Set<string>();

    const processRow = new Transform({
      objectMode: true,
      transform(chunk: string[], encoding: string, callback: Function) {
        if (stats.totalRows === 0) {
          stats.totalRows++;
          callback();
          return;
        }

        if (!Array.isArray(chunk) || chunk.length <= emailColumnIndex) {
          callback(
            new Error(`No data found at column index ${emailColumnIndex}`),
          );
          return;
        }

        stats.totalRows++;
        const email = (chunk[emailColumnIndex]?.toString() || '')
          .trim()
          .toLowerCase();

        if (!email || email === 'null' || email === 'undefined') {
          stats.totalEmptyEmails++;
        } else {
          if (emailSet.has(email)) {
            stats.totalDuplicateEmails++;
          } else {
            emailSet.add(email);
            stats.totalEmails++;
          }
        }

        callback();
      },
    });

    try {
      await this.pipelineAsync(input, this.createParser(), processRow);

      return stats;
    } catch (error) {
      throw new Error(`Error previewing CSV: ${error.message}`);
    }
  }

  async processAndStoreCSV(
    buffer: Buffer,
    originalFilename: string,
    options: ProcessingOptions,
  ): Promise<{
    fullFilename: string;
    emailsFilename: string;
    warning?: string;
  }> {
    try {
      const { columnName, hasInconsistentColumns } =
        await this.validateEmailColumn(buffer, options.emailColumnIndex);

      const input = this.createStreamFromBuffer(buffer);
      const processedFullRows: string[][] = [];
      const processedEmailRows: string[][] = [['email']];
      let headerProcessed = false;

      const processRow = new Transform({
        objectMode: true,
        transform(chunk: string[], encoding: string, callback: Function) {
          try {
            if (!headerProcessed) {
              const fullHeaders = chunk.filter(
                (_, index) => index !== options.emailColumnIndex,
              );
              processedFullRows.push(fullHeaders);
              headerProcessed = true;
              callback();
              return;
            }

            const email =
              chunk[options.emailColumnIndex]?.toString()?.trim() || '';
            const isEmptyEmail =
              !email ||
              email.toLowerCase() === 'null' ||
              email.toLowerCase() === 'undefined';

            if (!isEmptyEmail || !options.removeEmptyEmails) {
              processedEmailRows.push([email]);
              const rowWithoutEmail = chunk.filter(
                (_, index) => index !== options.emailColumnIndex,
              );
              processedFullRows.push(rowWithoutEmail);
            }

            callback();
          } catch (error) {
            // If there's an error processing a row, log it but continue
            console.warn(`Error processing row: ${error.message}`);
            callback();
          }
        },
      });

      await this.pipelineAsync(input, this.createParser(), processRow);

      const uuid = uuidv4();
      const safeFilename = originalFilename.replace(/\.[^/.]+$/, '');
      const fullFilename = `${safeFilename}_full_${uuid}.csv`;
      const emailsFilename = `${safeFilename}_emails_${uuid}.csv`;

      const fullCsv = Buffer.from(
        processedFullRows.map((row) => row.join(',')).join('\n'),
      );
      const emailsCsv = Buffer.from(
        processedEmailRows.map((row) => row.join(',')).join('\n'),
      );

      // Add retry logic for uploads
      const uploadWithRetry = async (filename: string, data: Buffer) => {
        for (let i = 0; i < 3; i++) {
          const { error } = await this.supabase.storage
            .from(this.BUCKET_NAME)
            .upload(`uploads/${filename}`, data, {
              contentType: 'text/csv',
              upsert: true,
            });

          if (!error) {
            await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for 1s after successful upload
            return;
          }

          if (i < 2) await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait between retries
        }
        throw new Error('Failed to upload file after 3 attempts');
      };

      await Promise.all([
        uploadWithRetry(fullFilename, fullCsv),
        uploadWithRetry(emailsFilename, emailsCsv),
      ]);

      const result: {
        fullFilename: string;
        emailsFilename: string;
        warning?: string;
      } = {
        fullFilename,
        emailsFilename,
      };

      if (hasInconsistentColumns) {
        result.warning =
          'The CSV file has inconsistent column counts. The extracted emails are available, but the full file may be malformed.';
      }

      return result;
    } catch (error) {
      this.logger.error(`Error processing CSV: ${error.message}`);
      throw error;
    }
  }

  async downloadProcessedFile(filename: string): Promise<Buffer | null> {
    try {
      const { data, error } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .download(`uploads/${filename}`);

      if (error) throw error;

      return Buffer.from(await data.arrayBuffer());
    } catch (error) {
      this.logger.error(`Error downloading file: ${error.message}`);
      return null;
    }
  }

  async testSupabaseConnection(): Promise<boolean> {
    try {
      const { data, error } = await this.supabase.auth.getSession();
      if (error) throw error;
      return true;
    } catch (error) {
      console.error('Supabase connection error:', error);
      return false;
    }
  }
}
