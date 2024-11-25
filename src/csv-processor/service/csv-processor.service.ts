import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import * as csv from 'csv-parse';
import { Transform, pipeline } from 'stream';
import { promisify } from 'util';
import { Readable } from 'stream';
import { ProcessingResult } from '../interfaces/csv-processor.interface';
@Injectable()
export class CsvProcessorService {
  private readonly logger = new Logger(CsvProcessorService.name);

  private readonly BUCKET_NAME = 'csv-files';
  private readonly RESULTS_FOLDER = 'results';

  constructor(
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  async onModuleInit() {
    await this.ensureBucketExists();
  }

  private async ensureBucketExists() {
    try {
      const { data: buckets } = await this.supabase.storage.listBuckets();

      const bucketExists = buckets?.some(
        (bucket) => bucket.name === this.BUCKET_NAME,
      );

      if (!bucketExists) {
        const { data, error } = await this.supabase.storage.createBucket(
          this.BUCKET_NAME,
          {
            public: false,
            fileSizeLimit: 10485760, // 10MB
          },
        );

        if (error) {
          throw error;
        }

        this.logger.log(`Created bucket: ${this.BUCKET_NAME}`);
      }

      await Promise.all([
        this.supabase.storage
          .from(this.BUCKET_NAME)
          .upload('uploads/.keep', new Uint8Array(0), {
            upsert: true,
          }),
        this.supabase.storage
          .from(this.BUCKET_NAME)
          .upload(`${this.RESULTS_FOLDER}/.keep`, new Uint8Array(0), {
            upsert: true,
          }),
      ]);
    } catch (error) {
      this.logger.error(`Failed to ensure bucket exists: ${error.message}`);
      throw error;
    }
  }

  async processAndStoreCSV(
    fileBuffer: Buffer,
    originalFilename: string,
    emailColumn: string = 'email',
    firstNameColumn: string = 'first_name',
    lastNameColumn: string = 'last_name',
  ): Promise<ProcessingResult> {
    try {
      await this.ensureBucketExists();

      const safeFilename = originalFilename.replace(/\.[^/.]+$/, '');

      const uploadFilename = `uploads/${safeFilename}.csv`;
      const { error: uploadError } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .upload(uploadFilename, fileBuffer, {
          contentType: 'text/csv',
          cacheControl: '3600',
          upsert: true,
        });

      if (uploadError) {
        throw new Error(`Failed to upload file: ${uploadError.message}`);
      }

      const result = await this.processCSVBuffer(
        fileBuffer,
        emailColumn,
        firstNameColumn,
        lastNameColumn,
      );

      const resultFilename = `${this.RESULTS_FOLDER}/${safeFilename}-results.json`;
      await this.supabase.storage
        .from(this.BUCKET_NAME)
        .upload(resultFilename, JSON.stringify(result), {
          contentType: 'application/json',
          cacheControl: '3600',
          upsert: true,
        });

      return result;
    } catch (error) {
      this.logger.error(`Error processing CSV: ${error.message}`);
      throw error;
    }
  }

  async getBucketPublicUrl(path: string): Promise<string | null> {
    try {
      const { data } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .getPublicUrl(path);

      return data.publicUrl;
    } catch (error) {
      this.logger.error(`Error getting public URL: ${error.message}`);
      return null;
    }
  }

  async listFiles(): Promise<string[]> {
    try {
      const { data, error } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .list('uploads');

      if (error) throw error;

      return data.map((file) => file.name);
    } catch (error) {
      this.logger.error(`Error listing files: ${error.message}`);
      throw error;
    }
  }

  private async processCSVBuffer(
    buffer: Buffer,
    emailColumn: string,
    firstNameColumn: string,
    lastNameColumn: string,
  ): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      validEmails: [],
      emptyEmailRecords: [],
      stats: {
        totalProcessed: 0,
        validEmailsCount: 0,
        emptyEmailsCount: 0,
        duplicateEmailsCount: 0,
      },
    };

    const emailSet = new Set<string>();
    const pipelineAsync = promisify(pipeline);

    const processRow = new Transform({
      objectMode: true,
      transform(chunk, encoding, callback) {
        result.stats.totalProcessed++;

        const email = chunk[emailColumn]?.trim();
        const firstName = chunk[firstNameColumn]?.trim();
        const lastName = chunk[lastNameColumn]?.trim();

        if (!email) {
          if (firstName || lastName) {
            result.emptyEmailRecords.push({
              first_name: firstName,
              last_name: lastName,
            });
            result.stats.emptyEmailsCount++;
          }
        } else {
          if (emailSet.has(email)) {
            result.stats.duplicateEmailsCount++;
          } else {
            emailSet.add(email);
            result.validEmails.push({
              email,
              first_name: firstName,
              last_name: lastName,
            });
            result.stats.validEmailsCount++;
          }
        }

        callback();
      },
    });

    try {
      await pipelineAsync(
        Readable.from(buffer),
        csv.parse({
          columns: true,
          skip_empty_lines: true,
          trim: true,
        }),
        processRow,
      );

      return result;
    } catch (error) {
      throw new Error(`Error processing CSV buffer: ${error.message}`);
    }
  }

  async getProcessedResults(
    filename: string,
  ): Promise<ProcessingResult | null> {
    try {
      const safeFilename = filename.replace(/\.[^/.]+$/, '');
      const resultFilename = `${this.RESULTS_FOLDER}/${safeFilename}-results.json`;

      const { data, error } = await this.supabase.storage
        .from('csv-files')
        .download(resultFilename);

      if (error) {
        throw error;
      }

      const textDecoder = new TextDecoder('utf-8');
      const jsonString = textDecoder.decode(await data.arrayBuffer());
      return JSON.parse(jsonString);
    } catch (error) {
      this.logger.error(`Error fetching results: ${error.message}`);
      return null;
    }
  }

  async getOriginalFile(filename: string): Promise<Buffer | null> {
    try {
      const safeFilename = filename.replace(/\.[^/.]+$/, '');
      const uploadFilename = `uploads/${safeFilename}.csv`;

      const { data, error } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .download(uploadFilename);

      if (error) {
        throw error;
      }

      return Buffer.from(await data.arrayBuffer());
    } catch (error) {
      this.logger.error(`Error fetching original file: ${error.message}`);
      return null;
    }
  }

  async listUploadedFiles(): Promise<string[]> {
    try {
      const { data, error } = await this.supabase.storage
        .from(this.BUCKET_NAME)
        .list('uploads');

      if (error) throw error;

      const filteredFiles = data
        .filter(
          (file) =>
            !file.name.startsWith('.') &&
            file.name !== '.emptyFolderPlaceholder' &&
            file.name !== '.keep' &&
            file.name.endsWith('.csv'),
        )
        .map((file) => file.name);

      return filteredFiles;
    } catch (error) {
      this.logger.error(`Error listing uploaded files: ${error.message}`);
      throw error;
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
