// أخطاء "متوقعة" من منطق الشغل (مش bugs): كل واحد معاه كود HTTP ورسالة تظهر للمستخدم.
// الـ error handler العام في app.ts بيحوّلها لرد JSON بدل 500
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, "VALIDATION_ERROR", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, "NOT_FOUND", message);
  }
}

export class InsufficientCreditsError extends AppError {
  constructor(
    public readonly required: number,
    public readonly balance: number
  ) {
    super(402, "INSUFFICIENT_CREDITS", `Not enough credits — this needs ${required}, you have ${balance}.`);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string) {
    super(503, "SERVICE_UNAVAILABLE", message);
  }
}
