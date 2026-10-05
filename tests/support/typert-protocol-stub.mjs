const REMOTE_METHODS = Symbol.for("deepseek-worker-test/remote-methods");

function addRemoteMarker(context, exportName) {
  context.addInitializer(function initializer() {
    const prototype = Object.getPrototypeOf(this);
    const methods = prototype[REMOTE_METHODS] ?? [];
    const method = String(context.name);
    if (!methods.some((item) => item.method === method && item.exportName === exportName)) {
      Object.defineProperty(prototype, REMOTE_METHODS, {
        configurable: true,
        value: [...methods, { method, ...(exportName === undefined ? {} : { exportName }) }],
      });
    }
  });
}

export function Remote(optionOrMethod, context) {
  if (typeof optionOrMethod === "string") {
    return (_method, nextContext) => addRemoteMarker(nextContext, optionOrMethod);
  }
  if (typeof optionOrMethod === "object") {
    return (_method, nextContext) => addRemoteMarker(nextContext, undefined);
  }
  addRemoteMarker(context, undefined);
}

export function remoteMethods(service) {
  return Object.getPrototypeOf(service)?.[REMOTE_METHODS] ?? [];
}

export class TypertRemoteService {
  constructor(ctx, serviceKey, options = {}) {
    this.ctx = ctx;
    this.name = serviceKey;
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey,
      namespace: options.namespace ?? serviceKey,
    });
    ctx.registerService(serviceKey, this);
  }
}
