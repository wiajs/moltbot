/**
 * 因为 Bun.serve 在声明时就已经完成了端口绑定，原来的重试和监听逻辑废弃。
 * 将它变成空函数，避免其他未被发现的旧代码调用时抛出 undefined 错误。
 */

// Bun 原生 serve 会在创建时自动绑定端口，这里保留签名的空壳以防止外部调用报错
export async function listenGatewayHttpServer(_params: {
  httpServer: unknown;
  bindHost: string;
  port: number;
}) {
  return Promise.resolve();
}
