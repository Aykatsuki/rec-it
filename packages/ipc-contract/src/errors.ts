export type IpcErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNKNOWN_CHANNEL'
  | 'INVALID_INPUT'
  | 'INVALID_OUTPUT'
  | 'HANDLER_ERROR'
  | 'TIMEOUT'
  | 'DISCONNECTED';

export interface IpcErrorShape {
  code: IpcErrorCode;
  message: string;
  issues?: { path: string; message: string }[];
}

export class IpcError extends Error {
  readonly code: IpcErrorCode;
  readonly issues: IpcErrorShape['issues'];

  constructor(shape: IpcErrorShape) {
    super(shape.message);
    this.name = 'IpcError';
    this.code = shape.code;
    this.issues = shape.issues;
  }

  toShape(): IpcErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.issues ? { issues: this.issues } : {}),
    };
  }
}
