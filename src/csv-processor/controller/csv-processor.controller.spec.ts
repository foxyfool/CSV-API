import { Test, TestingModule } from '@nestjs/testing';
import { CsvProcessorController } from './csv-processor.controller';

describe('CsvProcessorController', () => {
  let controller: CsvProcessorController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CsvProcessorController],
    }).compile();

    controller = module.get<CsvProcessorController>(CsvProcessorController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
