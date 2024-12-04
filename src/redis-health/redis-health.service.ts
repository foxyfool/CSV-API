import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

@Injectable()
export class RedisHealthService implements OnModuleInit {
  private readonly logger = new Logger(RedisHealthService.name);
  private readonly redisClient;

  constructor(private configService: ConfigService) {
    // Extract username from your Redis URL if present
    const redisUrl = this.configService.get('REDIS_URL');
    let username = '';

    if (redisUrl) {
      const match = redisUrl.match(/rediss?:\/\/([^:]+):([^@]+)@/);
      if (match) {
        username = match[1];
      }
    }

    this.redisClient = createClient({
      socket: {
        host: this.configService.get('redis.host'),
        port: this.configService.get('redis.port'),
        tls: true,
      },
      username: username || 'default', // Redis username (from URL)
      password: this.configService.get('redis.password'),
    });

    this.redisClient.on('error', (err) => {
      this.logger.error('Redis Client Error:', err);
    });

    this.redisClient.on('connect', () => {
      this.logger.log('Successfully connected to Redis');
    });

    this.redisClient.on('reconnecting', () => {
      this.logger.warn('Reconnecting to Redis...');
    });
  }
  async onModuleInit() {
    await this.testConnection();
  }

  async testConnection() {
    try {
      await this.redisClient.connect();

      // Test write
      await this.redisClient.set('test_key', 'test_value');

      // Test read
      const value = await this.redisClient.get('test_key');

      // Test delete
      await this.redisClient.del('test_key');

      this.logger.log('Redis connection test completed successfully');

      // Disconnect after test
      await this.redisClient.disconnect();

      return true;
    } catch (error) {
      this.logger.error('Redis connection test failed:', error);
      throw error;
    }
  }

  async checkHealth() {
    try {
      const startTime = Date.now();

      await this.redisClient.connect();
      const pingResult = await this.redisClient.ping();
      await this.redisClient.disconnect();

      const latency = Date.now() - startTime;

      return {
        status: 'ok',
        latency: `${latency}ms`,
        ping: pingResult,
        details: {
          host: this.configService.get('redis.host'),
          port: this.configService.get('redis.port'),
        },
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message,
        details: {
          host: this.configService.get('redis.host'),
          port: this.configService.get('redis.port'),
        },
      };
    }
  }
}
