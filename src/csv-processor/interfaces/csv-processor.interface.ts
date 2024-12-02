export interface CsvPreviewStats {
  totalEmails: number;
  totalRows: number;
  totalEmptyEmails: number;
  totalDuplicateEmails: number;
  columnName: string;
}

export interface ProcessingOptions {
  emailColumnIndex: number;
  removeEmptyEmails?: boolean;
}
