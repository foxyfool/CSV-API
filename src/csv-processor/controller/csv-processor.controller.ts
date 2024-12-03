import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Body,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  Get,
  Param,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Readable } from 'stream';
import { CsvProcessorService } from '../service/csv-processor.service';
import { Response } from 'express';

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
      const columnIndex = this.validateColumnIndex(emailColumnIndex);

      // Pass the buffer directly
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
      if (error instanceof BadRequestException) {
        throw error;
      }
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
      const columnIndex = this.validateColumnIndex(emailColumnIndex);

      const uniqueFilename = await this.csvProcessorService.processAndStoreCSV(
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
        filename: uniqueFilename,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        `Failed to process CSV file: ${error.message}`,
      );
    }
  }

  private validateColumnIndex(emailColumnIndex: string): number {
    const columnIndex = parseInt(emailColumnIndex, 10);
    if (isNaN(columnIndex) || columnIndex < 0) {
      throw new BadRequestException(
        'Invalid email column index. Please provide a non-negative number.',
      );
    }
    return columnIndex;
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
