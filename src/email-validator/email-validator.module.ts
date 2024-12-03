import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { EmailValidatorProcessor } from './email-validator.processor';
import { EmailValidatorController } from './email-validator.controller';
import { EmailValidatorService } from './email-validator.service';
import { createClient } from '@supabase/supabase-js';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        redis: {
          host: 'localhost',
          port: 6379,
        },
      }),
    }),
    BullModule.registerQueue({
      name: 'email-validation',
    }),
  ],
  controllers: [EmailValidatorController],
  providers: [
    EmailValidatorService,
    EmailValidatorProcessor,
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
  ],
  exports: [EmailValidatorService],
})
export class EmailValidatorModule {}
