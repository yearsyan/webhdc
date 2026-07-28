export interface HdcErrorOptions extends ErrorOptions {
  code?: string;
}

export class HdcError extends Error {
  readonly code: string;

  constructor(message: string, options: HdcErrorOptions = {}) {
    super(message, options);
    this.name = 'HdcError';
    this.code = options.code ?? 'HDC_ERROR';
  }
}

export class HdcUnsupportedError extends HdcError {
  constructor(message = '当前浏览器不支持 WebUSB') {
    super(message, { code: 'WEBUSB_UNSUPPORTED' });
    this.name = 'HdcUnsupportedError';
  }
}

export class HdcProtocolError extends HdcError {
  constructor(message: string, options: HdcErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'HDC_PROTOCOL_ERROR' });
    this.name = 'HdcProtocolError';
  }
}

export class HdcTimeoutError extends HdcError {
  constructor(message = 'HDC 操作超时') {
    super(message, { code: 'HDC_TIMEOUT' });
    this.name = 'HdcTimeoutError';
  }
}

export class HdcDisconnectedError extends HdcError {
  constructor(message = 'HDC 设备已断开') {
    super(message, { code: 'HDC_DISCONNECTED' });
    this.name = 'HdcDisconnectedError';
  }
}
