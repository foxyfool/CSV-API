import { Test, TestingModule } from '@nestjs/testing';
import { EmailValidatorService } from './email-validator.service';

describe('EmailValidatorService', () => {
  let service: EmailValidatorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EmailValidatorService],
    }).compile();

    service = module.get<EmailValidatorService>(EmailValidatorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
