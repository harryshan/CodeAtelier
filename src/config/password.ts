/**
 * 为设置保存和 HTTP 门禁提供固定参数的密码派生与校验，不实现密码学原语。
 * 1. hashPassword 使用 Node scrypt 和随机盐产生版本可识别的验证材料。
 * 2. verifyPassword 严格解析已保存格式，再做定长 timingSafeEqual；不输出密码或派生值。
 * 异步派生避免阻塞 HTTP 主线程；格式和成本固定，不接受文件指定任意工作因子。
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const result = (await derive(password, salt, 32)) as Buffer;

  return `scrypt:${salt}:${result.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const match = /^scrypt:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(encoded);
  if (!match) {
    return false;
  }

  const result = (await derive(password, match[1]!, 32)) as Buffer;

  return timingSafeEqual(result, Buffer.from(match[2]!, "hex"));
}
