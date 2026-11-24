// Tiny stack VM for make.fun tiny-stack-vm-01. Runs every /input/<id>/program.bin
// with /input/<id>/input.bin, writes /output/<id>/stdout.bin + exit.txt.
// From the ISA spec: 32-bit wrapping ints, 256-value data stack, 64-address
// call stack, 256 words of memory, traps 2..11, 1,000,000 steps, 65,536 output.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const OK = new Uint8Array(256); // real opcodes
const IL = new Uint8Array(256); // immediate lengths
for (let i = 0; i <= 7; i++) OK[i] = 1;
for (let i = 0x10; i <= 0x22; i++) OK[i] = 1;
for (let i = 0x30; i <= 0x34; i++) OK[i] = 1;
for (let i = 0x40; i <= 0x41; i++) OK[i] = 1;
for (let i = 0x50; i <= 0x53; i++) OK[i] = 1;
IL[0x01] = 1; IL[0x02] = 4;
IL[0x30] = 2; IL[0x31] = 2; IL[0x32] = 2; IL[0x33] = 2;

// Returns [output (latin1 string), exit code]. A trap ends the run at once;
// output written before it is kept.
function run(p, inp) {
  const s = []; // data stack, <= 256
  const c = []; // call stack, <= 64
  const m = new Int32Array(256);
  let o = '';
  let pc = 0, ip = 0, steps = 0;
  const n = p.length;
  for (;;) {
    if (steps >= 1000000) return [o, 10]; // step limit
    if (pc < 0 || pc >= n) return [o, 9]; // pc outside the program
    const op = p[pc];
    if (!OK[op]) return [o, 5]; // unknown opcode
    const L = IL[op];
    if (pc + 1 + L > n) return [o, 9]; // immediate cut off by the end
    steps++;
    const nx = pc + 1 + L;
    switch (op) {
      case 0x00: return [o, 0]; // HALT
      case 0x01: // PUSH8, sign-extended
        if (s.length >= 256) return [o, 3];
        s.push(p[pc + 1] < 128 ? p[pc + 1] : p[pc + 1] - 256);
        pc = nx; break;
      case 0x02: // PUSH32, little-endian signed
        if (s.length >= 256) return [o, 3];
        s.push(p[pc + 1] | (p[pc + 2] << 8) | (p[pc + 3] << 16) | (p[pc + 4] << 24));
        pc = nx; break;
      case 0x03: // POP
        if (s.length < 1) return [o, 2];
        s.pop(); pc = nx; break;
      case 0x04: // DUP
        if (s.length < 1) return [o, 2];
        if (s.length >= 256) return [o, 3];
        s.push(s[s.length - 1]); pc = nx; break;
      case 0x05: // SWAP
        if (s.length < 2) return [o, 2];
        { const t = s[s.length - 1]; s[s.length - 1] = s[s.length - 2]; s[s.length - 2] = t; }
        pc = nx; break;
      case 0x06: // OVER
        if (s.length < 2) return [o, 2];
        if (s.length >= 256) return [o, 3];
        s.push(s[s.length - 2]); pc = nx; break;
      case 0x07: // ROT ( a b c -- b c a )
        if (s.length < 3) return [o, 2];
        { const a = s[s.length - 3]; s[s.length - 3] = s[s.length - 2]; s[s.length - 2] = s[s.length - 1]; s[s.length - 1] = a; }
        pc = nx; break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: { // binary ops ( a b -- r ), b on top
        if (s.length < 2) return [o, 2];
        const b = s.pop(), a = s.pop();
        let r;
        switch (op) {
          case 0x10: r = (a + b) | 0; break;
          case 0x11: r = (a - b) | 0; break;
          case 0x12: r = Math.imul(a, b); break; // low 32 bits of the exact product
          case 0x13: if (b === 0) return [o, 4]; r = (a / b) | 0; break; // DIV, truncates toward zero; INT_MIN/-1 -> INT_MIN via |0
          case 0x14: if (b === 0) return [o, 4]; r = (a % b) | 0; break; // MOD, sign of a; x % -1 is 0
          case 0x15: if (b === 0) return [o, 4]; r = ((a >>> 0) / (b >>> 0)) | 0; break; // DIVU
          case 0x16: if (b === 0) return [o, 4]; r = ((a >>> 0) % (b >>> 0)) | 0; break; // MODU
          case 0x18: r = a & b; break;
          case 0x19: r = a | b; break;
          case 0x1a: r = a ^ b; break;
          case 0x1c: r = a << (b & 31); break; // SHL
          case 0x1d: r = a >> (b & 31); break; // SHR, arithmetic
          case 0x1e: r = (a >>> (b & 31)) | 0; break; // SHRU, logical
          case 0x20: r = a === b ? 1 : 0; break;
          case 0x21: r = a < b ? 1 : 0; break;
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
        }
        s.push(r); pc = nx; break;
      }
      case 0x17: // NEG, wraps
        if (s.length < 1) return [o, 2];
        s[s.length - 1] = (-s[s.length - 1]) | 0; pc = nx; break;
      case 0x1b: // NOT
        if (s.length < 1) return [o, 2];
        s[s.length - 1] = ~s[s.length - 1]; pc = nx; break;
      case 0x30: { // JMP: next instruction + signed 16-bit offset
        let off = p[pc + 1] | (p[pc + 2] << 8);
        if (off >= 32768) off -= 65536;
        pc = nx + off; break;
      }
      case 0x31: case 0x32: { // JZ / JNZ
        if (s.length < 1) return [o, 2];
        const v = s.pop();
        let off = p[pc + 1] | (p[pc + 2] << 8);
        if (off >= 32768) off -= 65536;
        pc = (op === 0x31 ? v === 0 : v !== 0) ? nx + off : nx; break;
      }
      case 0x33: // CALL: push next address, jump to unsigned immediate
        if (c.length >= 64) return [o, 7];
        c.push(nx); pc = p[pc + 1] | (p[pc + 2] << 8); break;
      case 0x34: // RET
        if (c.length === 0) return [o, 8];
        pc = c.pop(); break;
      case 0x40: // LOAD
        if (s.length < 1) return [o, 2];
        { const a = s[s.length - 1]; if (a < 0 || a > 255) return [o, 6]; s[s.length - 1] = m[a]; }
        pc = nx; break;
      case 0x41: // STORE ( v addr -- )
        if (s.length < 2) return [o, 2];
        { const a = s.pop(), v = s.pop(); if (a < 0 || a > 255) return [o, 6]; m[a] = v; }
        pc = nx; break;
      case 0x50: // PRINT, decimal ASCII
        if (s.length < 1) return [o, 2];
        { const t = String(s.pop()); if (o.length + t.length > 65536) return [o, 11]; o += t; }
        pc = nx; break;
      case 0x51: // PUTC, one byte
        if (s.length < 1) return [o, 2];
        if (o.length + 1 > 65536) return [o, 11];
        o += String.fromCharCode(s.pop() & 255);
        pc = nx; break;
      case 0x52: // IN, -1 once the input is used up
        if (s.length >= 256) return [o, 3];
        s.push(ip < inp.length ? inp[ip++] : -1);
        pc = nx; break;
      default: // EXIT, code v AND 255
        if (s.length < 1) return [o, 2];
        return [o, s.pop() & 255];
    }
  }
}

for (const id of readdirSync(IN).sort()) {
  const [out, code] = run(readFileSync(join(IN, id, 'program.bin')), readFileSync(join(IN, id, 'input.bin')));
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, 'stdout.bin'), Buffer.from(out, 'latin1'));
  writeFileSync(join(OUT, id, 'exit.txt'), String(code) + '\n');
}
