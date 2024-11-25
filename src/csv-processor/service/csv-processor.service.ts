import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import * as csv from 'csv-parse';
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

  constructor(
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  private async validateEmailColumn(
    buffer: Buffer,
    emailColumnIndex: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let headerProcessed = false;

      const parser = csv.parse({
        skipEmptyLines: true,
        trim: true,
      });

      parser.on('data', (row) => {
        if (!headerProcessed) {
          headerProcessed = true;
          if (!Array.isArray(row) || row.length <= emailColumnIndex) {
            reject(
              new BadRequestException(
                `Column index ${emailColumnIndex} does not exist in the CSV file`,
              ),
            );
            return;
          }

          const columnName = row[emailColumnIndex]?.toString() || '';
          if (!columnName.toLowerCase().includes('email')) {
            reject(
              new BadRequestException(
                `Column at index ${emailColumnIndex} is not an email column. Found: ${columnName}`,
              ),
            );
            return;
          }

          resolve(columnName);
          parser.end();
        }
      });

      parser.on('error', (error) => {
        reject(
          new BadRequestException(`Error validating CSV: ${error.message}`),
        );
      });

      parser.write(buffer);
      parser.end();
    });
  }

  async previewCSV(
    buffer: Buffer,
    emailColumnIndex: number,
  ): Promise<CsvPreviewStats> {
    // First validate and get column name
    const columnName = await this.validateEmailColumn(buffer, emailColumnIndex);

    const stats = {
      totalEmails: 0,
      totalRows: 0,
      totalEmptyEmails: 0,
      totalDuplicateEmails: 0,
      columnName: columnName, // Include column name in stats
    };

    const emailSet = new Set<string>();
    const pipelineAsync = promisify(pipeline);

    const processRow = new Transform({
      objectMode: true,
      transform(chunk, encoding, callback) {
        stats.totalRows++;

        if (!Array.isArray(chunk) || chunk.length <= emailColumnIndex) {
          callback(
            new Error(`No data found at column index ${emailColumnIndex}`),
          );
          return;
        }

        // Skip header row
        if (stats.totalRows === 1) {
          callback();
          return;
        }

        const emailValue = chunk[emailColumnIndex];
        const email = emailValue?.toString().trim() || '';

        if (
          !email ||
          email === '' ||
          email.toLowerCase() === 'null' ||
          email.toLowerCase() === 'undefined'
        ) {
          stats.totalEmptyEmails++;
        } else {
          if (emailSet.has(email.toLowerCase())) {
            stats.totalDuplicateEmails++;
          } else {
            emailSet.add(email.toLowerCase());
            stats.totalEmails++;
          }
        }

        callback();
      },
    });

    try {
      await pipelineAsync(
        Readable.from(buffer),
        csv.parse({
          skipEmptyLines: false,
          trim: true,
          from: 1,
        }),
        processRow,
      );

      // Adjust totalRows to exclude header
      stats.totalRows--;

      return stats;
    } catch (error) {
      throw new Error(`Error previewing CSV: ${error.message}`);
    }
  }

  async processAndStoreCSV(
    fileBuffer: Buffer,
    originalFilename: string,
    options: ProcessingOptions,
  ): Promise<Buffer> {
    // First validate the email column
    try {
      await this.validateEmailColumn(fileBuffer, options.emailColumnIndex);
    } catch (error) {
      throw error;
    }

    try {
      const processedRows: string[][] = [];
      const headerRow: string[] = [];
      let isHeader = true;
      const pipelineAsync = promisify(pipeline);

      const processRow = new Transform({
        objectMode: true,
        transform(chunk, encoding, callback) {
          if (isHeader) {
            headerRow.push(...chunk);
            processedRows.push(chunk);
            isHeader = false;
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

          const emailValue = chunk[options.emailColumnIndex];
          const email = emailValue?.toString().trim() || '';

          const isEmptyEmail =
            !email ||
            email === '' ||
            email.toLowerCase() === 'null' ||
            email.toLowerCase() === 'undefined';

          if (!isEmptyEmail || !options.removeEmptyEmails) {
            processedRows.push(chunk);
          }

          callback();
        },
      });

      await pipelineAsync(
        Readable.from(fileBuffer),
        csv.parse({
          skipEmptyLines: false,
          trim: true,
          from: 1,
        }),
        processRow,
      );

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

      return processedCsv;
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
