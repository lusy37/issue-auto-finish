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
