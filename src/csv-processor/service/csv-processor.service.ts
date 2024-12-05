import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import * as Papa from 'papaparse';
import { v4 as uuidv4 } from 'uuid';
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
    content: string,
    emailColumnIndex: number,
  ): Promise<{ columnName: string; hasInconsistentColumns: boolean }> {
    const parseResult = Papa.parse(content, {
      delimiter: ',',
      skipEmptyLines: true,
      quoteChar: '"',
      header: false,
    });

    const rows = parseResult.data as string[][];
    if (!rows.length) {
      throw new BadRequestException('CSV file is empty');
    }

    const headerRow = rows[0];
    if (!Array.isArray(headerRow) || headerRow.length <= emailColumnIndex) {
      throw new BadRequestException(
        `Column index ${emailColumnIndex} does not exist in the CSV file`,
      );
    }

    const columnName = headerRow[emailColumnIndex]?.toString() || '';
    if (!columnName.toLowerCase().includes('email')) {
      throw new BadRequestException(
        `Column at index ${emailColumnIndex} is not an email column. Found: ${columnName}`,
      );
    }

    const hasInconsistentColumns = rows.some(
      (row) => row.length !== headerRow.length,
    );

    return { columnName, hasInconsistentColumns };
  }

  async previewCSV(
    buffer: Buffer,
    emailColumnIndex: number,
  ): Promise<CsvPreviewStats> {
    const content = buffer.toString('utf8');
    const { columnName } = await this.validateEmailColumn(
      content,
      emailColumnIndex,
    );

    const parseResult = Papa.parse(content, {
      delimiter: ',',
      skipEmptyLines: true,
      quoteChar: '"',
      header: false,
    });

    const rows = parseResult.data as string[][];
    const stats: CsvPreviewStats = {
      totalEmails: 0,
      totalRows: rows.length - 1, // Excluding header
      totalEmptyEmails: 0,
      totalDuplicateEmails: 0,
      columnName,
    };

    const emailSet = new Set<string>();
    rows.slice(1).forEach((row) => {
      const email = (row[emailColumnIndex]?.toString() || '')
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
    });

    return stats;
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
      const content = buffer.toString('utf8');
      const { hasInconsistentColumns } = await this.validateEmailColumn(
        content,
        options.emailColumnIndex,
      );

      const parseResult = Papa.parse(content, {
        delimiter: ',',
        skipEmptyLines: true,
        quoteChar: '"',
        header: false,
      });

      const records = parseResult.data as string[][];
      const updatedFullRows: string[][] = [];
      const emailRows: string[][] = [];
      emailRows.push(['email']);

      records.forEach((row, index) => {
        if (index === 0) {
          updatedFullRows.push(
            row.filter((_, colIndex) => colIndex !== options.emailColumnIndex),
          );
          return;
        }

        const email = row[options.emailColumnIndex]?.toString().trim() || '';
        const isEmptyEmail =
          !email ||
          email.toLowerCase() === 'null' ||
          email.toLowerCase() === 'undefined';

        if (!isEmptyEmail || !options.removeEmptyEmails) {
          emailRows.push([email]);
          const updatedRow = row.filter(
            (_, colIndex) => colIndex !== options.emailColumnIndex,
          );
          updatedFullRows.push(updatedRow);
        }
      });

      const uuid = uuidv4();
      const safeFilename = originalFilename.replace(/\.[^/.]+$/, '');
      const fullFilename = `${safeFilename}_full_${uuid}.csv`;
      const emailsFilename = `${safeFilename}_emails_${uuid}.csv`;

      const fullCsv = Papa.unparse(updatedFullRows);
      const emailsCsv = Papa.unparse(emailRows);

      const uploadWithRetry = async (filename: string, data: Buffer) => {
        for (let i = 0; i < 3; i++) {
          const { error } = await this.supabase.storage
            .from(this.BUCKET_NAME)
            .upload(`uploads/${filename}`, data, {
              contentType: 'text/csv',
              upsert: true,
            });

          if (!error) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return;
          }

          if (i < 2) await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        throw new Error('Failed to upload file after 3 attempts');
      };

      await Promise.all([
        uploadWithRetry(fullFilename, Buffer.from(fullCsv)),
        uploadWithRetry(emailsFilename, Buffer.from(emailsCsv)),
      ]);

      const uploadResult = {
        fullFilename,
        emailsFilename,
      } as const;

      if (hasInconsistentColumns) {
        return {
          ...uploadResult,
          warning:
            'The CSV file has inconsistent column counts. The extracted emails are available, but the full file may be malformed.',
        };
      }

      return uploadResult;
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
