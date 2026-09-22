export class ApiFailure extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export function unauthenticated() {
  return new ApiFailure(401, "UNAUTHENTICATED", "登录已失效，请重新登录。");
}
