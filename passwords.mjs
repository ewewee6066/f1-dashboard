import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const parameters = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
let active = 0;
export function validPassword(value) {
  const common = new Set(['123456789012345', '1234567890123456', 'password123456789', 'password12345678', 'qwertyuiopasdfgh', 'abcdefghijklmnop']);
  return typeof value === 'string' && [...value].length >= 15 && [...value].length <= 128 && Buffer.byteLength(value) <= 512 && !/^(.)\1*$/su.test(value) && !common.has(value.toLowerCase());
}
async function digest(value, salt) {
  if (active >= 2) { const error = new Error('登录服务繁忙，请稍后重试'); error.status = 503; throw error; }
  active++;
  try { return await derive(value, salt, 64, parameters); }
  finally { active--; }
}
export async function hashPassword(value) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$131072$8$1$${salt}$${(await digest(value, salt)).toString('hex')}`;
}
export async function verifyPassword(value, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  const valid = parts.length === 6 && parts.slice(0, 4).join('$') === 'scrypt$131072$8$1' && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{128}$/.test(parts[5]);
  // Perform the same expensive work for unknown emails and accounts without a password.
  const result = await digest(value, valid ? parts[4] : '00000000000000000000000000000000');
  return timingSafeEqual(result, Buffer.from(valid ? parts[5] : '0'.repeat(128), 'hex')) && valid;
}
