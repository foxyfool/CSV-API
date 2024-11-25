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
import { Response } from 'express';
import { CsvProcessorService } from '../service/csv-processor.service';

@Controller('csv-processor')
export class CsvProcessorController {
  constructor(private readonly csvProcessorService: CsvProcessorService) {}

  @Post('preview')
  @UseInterceptors(FileInterceptor('file'))
  async previewCsv(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 1024 * 1024 * 10 }), // 10MB max
          new FileTypeValidator({ fileType: 'text/csv' }),
        ],
      }),
    )
    file: Express.Multer.File,
    @Body('emailColumnIndex') emailColumnIndex: string,
  ) {
    try {
      const columnIndex = parseInt(emailColumnIndex, 10);
      if (isNaN(columnIndex) || columnIndex < 0) {
        throw new BadRequestException('Invalid email column index');
      }

      const stats = await this.csvProcessorService.previewCSV(
        file.buffer,
        columnIndex,
      );

      return {
        success: true,
        stats,
        filename: file.originalname,
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to preview CSV file: ${error.message}`,
      );
    }
  }

  @Post('process')
  @UseInterceptors(FileInterceptor('file'))
  async processAndStoreCsv(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 1024 * 1024 * 10 }),
          new FileTypeValidator({ fileType: 'text/csv' }),
        ],
      }),
    )
    file: Express.Multer.File,
    @Body('emailColumnIndex') emailColumnIndex: string,
    @Body('removeEmptyEmails') removeEmptyEmails?: string,
  ) {
    try {
      const columnIndex = parseInt(emailColumnIndex, 10);
      if (isNaN(columnIndex) || columnIndex < 0) {
        throw new BadRequestException('Invalid email column index');
      }

      const processedCsv = await this.csvProcessorService.processAndStoreCSV(
        file.buffer,
        file.originalname,
        {
          emailColumnIndex: columnIndex,
          removeEmptyEmails: removeEmptyEmails === 'true',
        },
      );

      return {
        success: true,
        message: 'CSV processed and stored successfully',
        filename: file.originalname,
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to process CSV file: ${error.message}`,
      );
    }
  }

  @Get('download/:filename')
  async downloadProcessedFile(
    @Param('filename') filename: string,
    @Res() res: Response,
  ) {
    const file = await this.csvProcessorService.downloadProcessedFile(filename);
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
