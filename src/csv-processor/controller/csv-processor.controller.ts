import {
  Controller,
  Post,
  Get,
  Param,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Body,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CsvProcessorService } from '../service/csv-processor.service';
import { MulterFile } from '../interfaces/csv-processor.interface';
import { Response } from 'express';

@Controller('csv-processor')
export class CsvProcessorController {
  constructor(private readonly csvProcessorService: CsvProcessorService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAndProcessCsv(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 1024 * 1024 * 10 }), // 10MB max
          new FileTypeValidator({ fileType: 'text/csv' }),
        ],
      }),
    )
    file: MulterFile,
    @Body('emailColumn') emailColumn: string = 'email',
    @Body('firstNameColumn') firstNameColumn: string = 'first_name',
    @Body('lastNameColumn') lastNameColumn: string = 'last_name',
  ) {
    try {
      const result = await this.csvProcessorService.processAndStoreCSV(
        file.buffer,
        file.originalname,
        emailColumn,
        firstNameColumn,
        lastNameColumn,
      );

      return {
        success: true,
        message: 'CSV processing completed successfully',
        filename: file.originalname,
        stats: {
          totalProcessed: result.stats.totalProcessed,
          validEmailsCount: result.stats.validEmailsCount,
          emptyEmailsCount: result.stats.emptyEmailsCount,
          duplicateEmailsCount: result.stats.duplicateEmailsCount,
          fileSize: file.size,
        },
        processedData: {
          validEmails: result.validEmails,
          emptyEmailRecords: result.emptyEmailRecords,
        },
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to process CSV file: ${error.message}`,
      );
    }
  }

  @Get('results/:filename')
  async getResults(@Param('filename') filename: string) {
    const results =
      await this.csvProcessorService.getProcessedResults(filename);
    if (!results) {
      throw new BadRequestException('Results not found');
    }
    return {
      success: true,
      data: results,
    };
  }

  @Get('uploads')
  async listUploadedFiles() {
    const files = await this.csvProcessorService.listUploadedFiles();

    return {
      success: true,
      files,
      count: files.length,
      isEmpty: files.length === 0,
      message:
        files.length === 0
          ? 'No files uploaded yet'
          : `Found ${files.length} file(s)`,
    };
  }

  @Get('uploads/:filename')
  async getOriginalFile(
    @Param('filename') filename: string,
    @Res() res: Response,
  ) {
    const file = await this.csvProcessorService.getOriginalFile(filename);
    if (!file) {
      throw new BadRequestException('File not found');
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(file);
  }

  @Get('test-connection')
  async testConnection() {
    const isConnected = await this.csvProcessorService.testSupabaseConnection();
    return { connected: isConnected };
  }
}
