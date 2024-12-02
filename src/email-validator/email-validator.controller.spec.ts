import { Test, TestingModule } from '@nestjs/testing';
import { EmailValidatorController } from './email-validator.controller';

describe('EmailValidatorController', () => {
  let controller: EmailValidatorController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EmailValidatorController],
    }).compile();

    controller = module.get<EmailValidatorController>(EmailValidatorController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
