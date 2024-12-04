import { Module } from '@nestjs/common';
import { RedisHealthService } from './redis-health.service';
import { RedisHealthController } from './redis-health.controller';

@Module({
  controllers: [RedisHealthController],
  providers: [RedisHealthService],
  exports: [RedisHealthService],
})
export class RedisHealthModule {}
