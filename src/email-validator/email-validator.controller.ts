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
  ) {}
  @Post('validate/:filename')
  async validateEmails(
    @Param('filename') filename: string,
    @Body('emailColumnIndex') emailColumnIndex: string,
    @Body('user_email') userEmail: string,
    @Body('total_emails') totalEmails: number,
  ) {
    this.logger.log(`Received request to validate emails in file: ${filename}`);
    this.logger.log(`Provided email column index: ${emailColumnIndex}`);

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
      const result = await this.emailValidatorService.validateEmailsInCsv({
        filename,
        emailColumnIndex: columnIndex,
        userEmail,
        totalEmails,
        fileId,
      });

      this.logger.log(
        `Email validation initiated successfully for file: ${filename}`,
      );

      return {
        success: true,
        message: result.message,
        file_id: fileId,
        status: result.status,
        filename: filename,
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
    const { data, error } = await this.supabase
      .from('files')
      .select('*')
      .eq('file_id', fileId)
      .single();

    if (error) {
      throw new BadRequestException('Failed to fetch file status');
    }

    return {
      status: data.status, // Will be 'In Queue', 'Validating', or 'Completed'
      stats: data.stats, // Contains counts of valid/invalid emails
      progress: (data.stats.processed / data.stats.total_emails) * 100, // Percentage complete
    };
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
