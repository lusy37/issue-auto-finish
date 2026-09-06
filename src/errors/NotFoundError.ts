import { AppError } from './BaseError.js';

export class IssueNotFoundError extends AppError {
  public readonly issueIid: number;
  constructor(issueIid: number) {
    super('ISSUE_NOT_FOUND', `Issue ${issueIid} not found in tracker`);
    this.issueIid = issueIid;
  }
}
