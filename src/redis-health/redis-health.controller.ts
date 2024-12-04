import { Controller, Get } from '@nestjs/common';
import { RedisHealthService } from './redis-health.service';

@Controller('health')
export class RedisHealthController {
  constructor(private readonly redisHealthService: RedisHealthService) {}

  @Get('redis')
  async checkRedisHealth() {
    return this.redisHealthService.checkHealth();
  }
}
