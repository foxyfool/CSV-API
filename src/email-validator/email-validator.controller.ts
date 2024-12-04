import {
  Controller,
  Post,
  Param,
  BadRequestException,
  Body,
  Logger,
  Get,
  Inject,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { EmailValidatorService } from './email-validator.service';
import { v4 as uuidv4 } from 'uuid';
import { SupabaseClient } from '@supabase/supabase-js';

@Controller('email-validator')
export class EmailValidatorController {
  private readonly logger = new Logger(EmailValidatorController.name);

  constructor(
    private readonly emailValidatorService: EmailValidatorService,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
    @InjectQueue('email-validation') private readonly emailQueue: Queue,
  ) {}

  @Post('validate/:filename')
  async validateEmails(
    @Param('filename') filename: string,
    @Body('emailColumnIndex') emailColumnIndex: string,
    @Body('user_email') userEmail: string,
    @Body('total_emails') totalEmails: number,
  ) {
    const isQueueReady = await this.emailQueue.isReady();

    if (!isQueueReady) {
      throw new BadRequestException('Email validation queue is not ready');
    }

    try {
      const columnIndex = this.validateColumnIndex(emailColumnIndex);

      if (!userEmail || !totalEmails) {
        throw new BadRequestException(
          'User email and total emails are required',
        );
      }

      this.logger.log(
        `Starting email validation for file: ${filename} on column index: ${columnIndex}`,
      );

      const fileId = uuidv4();

      // Create initial file record
      await this.supabase.from('files').insert({
        file_id: fileId,
        created_at: new Date(),
        user_email: userEmail,
        status: 'In Queue',
        object_storage_id: `uploads/${filename}`,
        total_emails: totalEmails,
      });

      // Add job to queue instead of direct processing
      const job = await this.emailQueue.add(
        'validate',
        {
          filename,
          emailColumnIndex: columnIndex,
          userEmail,
          totalEmails,
          fileId,
        },
        {
          jobId: fileId,
          removeOnComplete: false, // Keep job data for status checking
        },
      );

      this.logger.log(
        `Email validation job queued successfully for file: ${filename}`,
      );

      return {
        success: true,
        message: 'Validation job queued successfully',
        file_id: fileId,
        status: 'In Queue',
        filename: filename,
        job_id: job.id,
      };
    } catch (error) {
      this.logger.error(
        `Error occurred during email validation: ${error.message}`,
      );
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        this.getReadableErrorMessage(error.message),
      );
    }
  }

  @Get('status/:fileId')
  async checkValidationStatus(@Param('fileId') fileId: string) {
    try {
      const job = await this.emailQueue.getJob(fileId);

      // Get file status from database
      const { data, error } = await this.supabase
        .from('files')
        .select('*')
        .eq('file_id', fileId)
        .single();

      if (error) {
        throw new BadRequestException('Failed to fetch file status');
      }

      // Get job progress
      const progress = job ? await job.progress() : 0;

      let queuePosition = null;
      if (job && (await job.isWaiting())) {
        const waiting = await this.emailQueue.getWaiting();
        queuePosition = waiting.findIndex((j) => j.id === job.id) + 1;
      }

      return {
        status: data.status,
        stats: data.stats,
        progress: progress,
        queue_position: queuePosition,
        total_emails: data.total_emails,
        processed_emails: data.stats?.processed || 0,
      };
    } catch (error) {
      throw new BadRequestException('Failed to fetch validation status');
    }
  }

  private validateColumnIndex(emailColumnIndex: string): number {
    const columnIndex = parseInt(emailColumnIndex, 10);
    if (isNaN(columnIndex) || columnIndex < 0) {
      this.logger.error('Invalid email column index provided.');
      throw new BadRequestException('Invalid email column index');
    }
    return columnIndex;
  }

  private getReadableErrorMessage(errorMessage: string): string {
    if (errorMessage.includes('Failed to fetch file')) {
      return 'The specified CSV file could not be found. Please ensure the file exists and try again.';
    }
    if (errorMessage.includes('Column index')) {
      return 'The specified email column could not be found in the CSV file. Please verify the column index.';
    }
    if (errorMessage.includes('Insufficient credits')) {
      return 'You do not have enough credits to process this many emails. Please add more credits and try again.';
    }
    return errorMessage;
  }
}
