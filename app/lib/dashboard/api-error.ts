export class DashboardApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** For 502 action_failed responses, the audit row id of the failed attempt. */
  readonly auditId?: string;

  constructor(status: number, code: string, message: string, auditId?: string) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
    this.code = code;
    this.auditId = auditId;
  }
}
