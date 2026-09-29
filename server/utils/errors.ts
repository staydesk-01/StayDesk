export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
  static badRequest(msg = "Bad request", code?: string) {
    return new AppError(400, msg, code);
  }
  static unauthorized(msg = "Authentication required") {
    return new AppError(401, msg, "unauthorized");
  }
  static forbidden(msg = "You do not have permission to do that") {
    return new AppError(403, msg, "forbidden");
  }
  static notFound(msg = "Not found") {
    return new AppError(404, msg, "not_found");
  }
  static conflict(msg = "Conflict") {
    return new AppError(409, msg, "conflict");
  }
}
