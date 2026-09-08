import { z } from 'zod';

export const OtpRequestSchema = z.object({
  phone: z.string().min(10).max(15),
});
export type OtpRequest = z.infer<typeof OtpRequestSchema>;

export const OtpVerifySchema = z.object({
  requestId: z.string().uuid(),
  otp: z.string().length(6),
});
export type OtpVerify = z.infer<typeof OtpVerifySchema>;

export const PairConnectorSchema = z.object({
  pairCode: z.string().length(6),
  machineName: z.string(),
  os: z.string(),
  tallyVersion: z.string(),
  appVersion: z.string(),
});
export type PairConnector = z.infer<typeof PairConnectorSchema>;

export const IngestPayloadSchema = z.object({
  kind: z.enum(['ledger', 'voucher', 'company', 'group', 'stock_item', 'voucher_type']),
  companyGuid: z.string(),
  alterId: z.number(),
  data: z.any(),
});
export type IngestPayload = z.infer<typeof IngestPayloadSchema>;
