import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CsvProcessorModule } from './csv-processor/module/csv-processor.module';
import { configuration } from './config/configuration';
import { validationSchema } from './config/env.validation';

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
    CsvProcessorModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
