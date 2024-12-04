import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CsvProcessorModule } from './csv-processor/module/csv-processor.module';
import { configuration } from './config/configuration';
import { validationSchema } from './config/env.validation';
import { MulterModule } from '@nestjs/platform-express';
import { EmailValidatorModule } from './email-validator/email-validator.module';
import { RedisHealthModule } from './redis-health/redis-health.module';
import { RedisOptions } from 'ioredis';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
      validationOptions: {
        abortEarly: false,
      },
    }),
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
    MulterModule.register({
      dest: './uploads',
    }),
    CsvProcessorModule,
    EmailValidatorModule,
    RedisHealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
