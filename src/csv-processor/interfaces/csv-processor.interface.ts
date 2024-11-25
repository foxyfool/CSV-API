export interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export interface EmailRecord {
  email: string;
  first_name: string;
  last_name: string;
}

export interface ProcessingResult {
  validEmails: EmailRecord[];
  emptyEmailRecords: { first_name: string; last_name: string }[];
  stats: {
    totalProcessed: number;
    validEmailsCount: number;
    emptyEmailsCount: number;
    duplicateEmailsCount: number;
  };
}

export interface ProcessingResponse extends ProcessingResult {
  timestamp: string;
}
