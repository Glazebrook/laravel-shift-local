/**
 * FINDING-14 FIX: Common base error class for all shift errors.
 * CI/CD pipelines can catch ShiftBaseError to handle all shift-specific errors
 * with a single instanceof check.
 */
export class ShiftBaseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ShiftBaseError';
  }
}
