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
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get('redis.url');

        // Configure Redis connection based on environment
        const redisConfig = redisUrl
          ? { url: redisUrl }
          : {
              // For local
              host: configService.get('redis.host', 'localhost'),
              port: configService.get('redis.port', 6379),
              password: configService.get('redis.password'),
            };

        return {
          redis: redisConfig,
          defaultJobOptions: {
            removeOnComplete: false,
            attempts: configService.get('queue.maxAttempts', 3),
            timeout: configService.get('queue.timeout', 300000),
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
          },
        };
      },
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
