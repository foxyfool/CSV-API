import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { EmailValidatorProcessor } from './email-validator.processor';
import { EmailValidatorController } from './email-validator.controller';
import { EmailValidatorService } from './email-validator.service';
import { createClient } from '@supabase/supabase-js';
import { RedisOptions } from 'ioredis';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const redisUrl = configService.get<string>('REDIS_URL');
        let username = '';
        let password = '';
        let host = '';
        let port = '';

        // Parse Redis URL
        if (redisUrl) {
          const match = redisUrl.match(
            /rediss?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)/,
          );
          if (match) {
            username = match[1];
            password = match[2];
            host = match[3];
            port = match[4];
          }
        }

        const redisOptions: RedisOptions = {
          host: host || configService.get('redis.host'),
          port: parseInt(port) || configService.get('redis.port'),
          password: password || configService.get('redis.password'),
          username: username || 'default',
          tls: {
            rejectUnauthorized: false,
          },
          maxRetriesPerRequest: null,
        };

        return {
          redis: redisOptions,
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
