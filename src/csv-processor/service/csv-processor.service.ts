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

@Injectable()
export class CsvProcessorService {
  private readonly logger = new Logger(CsvProcessorService.name);
  private readonly BUCKET_NAME = 'csv-files';
  private readonly pipelineAsync = promisify(pipeline);

  constructor(
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  // Create a buffer to stream converter that can be reused
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
  ): Promise<string> {
    // Create a fresh stream for validation
    const input = this.createStreamFromBuffer(buffer);

    return new Promise<string>((resolve, reject) => {
      let isResolved = false;

      const headerValidator = new Transform({
        objectMode: true,
        transform(row: string[], encoding: string, callback: Function) {
          if (isResolved) {
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
          resolve(columnName);
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
    const columnName = await this.validateEmailColumn(buffer, emailColumnIndex);

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
  ): Promise<void> {
    try {
      // Validate the email column first
      await this.validateEmailColumn(buffer, options.emailColumnIndex);

      // Create a fresh stream for processing
      const input = this.createStreamFromBuffer(buffer);

      const processedRows: string[][] = [];
      let headerProcessed = false;

      const processRow = new Transform({
        objectMode: true,
        transform(chunk: string[], encoding: string, callback: Function) {
          if (!headerProcessed) {
            processedRows.push(chunk);
            headerProcessed = true;
            callback();
            return;
          }

          if (
            !Array.isArray(chunk) ||
            chunk.length <= options.emailColumnIndex
          ) {
            callback(
              new Error(
                `No data found at column index ${options.emailColumnIndex}`,
              ),
            );
            return;
          }

          const email = (
            chunk[options.emailColumnIndex]?.toString() || ''
          ).trim();
          const isEmptyEmail =
            !email ||
            email.toLowerCase() === 'null' ||
            email.toLowerCase() === 'undefined';

          if (!isEmptyEmail || !options.removeEmptyEmails) {
            processedRows.push(chunk);
          }

          callback();
        },
      });

      await this.pipelineAsync(input, this.createParser(), processRow);

      const processedCsv = Buffer.from(
        processedRows.map((row) => row.join(',')).join('\n'),
      );

      const safeFilename = originalFilename.replace(/\.[^/.]+$/, '');
      const uploadFilename = `uploads/${safeFilename}.csv`;

      const { error: uploadError } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .upload(uploadFilename, processedCsv, {
          contentType: 'text/csv',
          upsert: true,
        });

      if (uploadError) {
        throw new Error(`Failed to upload file: ${uploadError.message}`);
      }
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
