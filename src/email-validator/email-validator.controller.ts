import {
  Controller,
  Post,
  Param,
  BadRequestException,
  Body,
} from '@nestjs/common';
import { EmailValidatorService } from './email-validator.service';

@Controller('email-validator')
export class EmailValidatorController {
  constructor(private readonly emailValidatorService: EmailValidatorService) {}

  @Post('validate/:filename')
  async validateEmails(
    @Param('filename') filename: string,
    @Body('emailColumnIndex') emailColumnIndex: string,
  ) {
    console.log(`Received request to validate emails in file: ${filename}`);
    console.log(`Provided email column index: ${emailColumnIndex}`);

    try {
      const columnIndex = parseInt(emailColumnIndex, 10);
      console.log(`Parsed column index: ${columnIndex}`);

      if (isNaN(columnIndex) || columnIndex < 0) {
        console.error('Invalid email column index provided.');
        throw new BadRequestException('Invalid email column index');
      }

      console.log(
        `Starting email validation for file: ${filename} on column index: ${columnIndex}`,
      );

      await this.emailValidatorService.validateEmailsInCsv(
        filename,
        columnIndex,
      );

      console.log(
        `Email validation completed successfully for file: ${filename}`,
      );

      return {
        success: true,
        message: 'Email validation completed',
        filename: filename, // Return original filename since we're updating it
      };
    } catch (error) {
      console.error(`Error occurred during email validation: ${error.message}`);
      throw new BadRequestException(
        `Failed to validate emails: ${error.message}`,
      );
    }
  }
}
