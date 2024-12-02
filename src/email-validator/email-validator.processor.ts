import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { EmailValidatorService } from './email-validator.service';

@Processor('email-validation')
export class EmailValidatorProcessor {
  private readonly logger = new Logger(EmailValidatorProcessor.name);

  constructor(private readonly emailValidatorService: EmailValidatorService) {}

  @Process('validate')
  async handleValidation(job: Job) {
    try {
      const { filename, emailColumnIndex, userEmail, totalEmails, fileId } =
        job.data;

      await job.progress(0);

      const result = await this.emailValidatorService.validateEmailsInCsv({
        filename,
        emailColumnIndex,
        userEmail,
        totalEmails,
        fileId,
      });

      await job.progress(100);
      return result;
    } catch (error) {
      this.logger.error(`Job ${job.id} failed: ${error.message}`);
      throw error;
    }
  }
}
