/** 已记录证据不足或额度耗尽时，自动执行必须停止。 */
export class RecoveryError extends Error {
  readonly manual = true;
}
