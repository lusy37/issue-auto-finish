/** 审核操作非法时由 API 翻译为 409。 */
export class GateActionError extends Error {
  constructor(message: string, public readonly code: 'invalid-state' | 'reject-not-allowed') {
    super(message);
    this.name = 'GateActionError';
  }
}
