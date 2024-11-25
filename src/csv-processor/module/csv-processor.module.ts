import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CsvProcessorController } from '../controller/csv-processor.controller';
import { CsvProcessorService } from '../service/csv-processor.service';
import { createClient } from '@supabase/supabase-js';

@Module({
  controllers: [CsvProcessorController],
  providers: [
    {
      provide: 'SUPABASE_CLIENT',
      useFactory: (configService: ConfigService) => {
        const supabaseUrl = configService.get<string>('supabase.url');
        const supabaseKey = configService.get<string>('supabase.key');

        if (!supabaseUrl || !supabaseKey) {
          throw new Error('Supabase configuration is missing');
        }

        return createClient(supabaseUrl, supabaseKey);
      },
      inject: [ConfigService],
    },
    CsvProcessorService,
  ],
})
export class CsvProcessorModule {}
