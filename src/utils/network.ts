import os from 'node:os';

/** 获取本机第一个非回环 IPv4 地址，无则返回 'localhost' */
export function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

/** 将 0.0.0.0 / 127.0.0.1 / localhost 替换为真实 IP，用于面向用户展示的 URL */
export function resolveDisplayHost(host: string): string {
  if (host === '0.0.0.0' || host === '127.0.0.1' || host === 'localhost') {
    return getLocalIP();
  }
  return host;
}
