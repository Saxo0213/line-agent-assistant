// Precision-safe JSON parsing.
//
// LINE ids and revisions exceed 2^53 (message ids, revisions). `JSON.parse` would silently round them. The gateway
// sends them as JSON numbers in some responses, so this module implements a small strict JSON parser that keeps every
// INTEGER literal whose magnitude exceeds Number.MAX_SAFE_INTEGER as a decimal STRING, and leaves all other numbers as
// ordinary JS numbers (safe integers, fractions and exponents). Callers therefore treat ids/revisions as strings and
// small enums/codes as numbers, matching how the design brief wants them ("decimal strings").
//
// Chosen over a regex pre-pass (which mis-handles digits inside strings) and over the JSON.parse reviver source-text
// argument (not available in every runtime). Behaviour for valid JSON matches JSON.parse except for those integers.

import { ChromeE2eeError } from './errors.js';

export class PreciseJsonError extends SyntaxError {}

export function parsePreciseJson(text: string): unknown {
  const parser = new Parser(text);
  parser.skipWhitespace();
  const value = parser.readValue(0);
  parser.skipWhitespace();
  if (!parser.atEnd()) throw parser.fail('unexpected trailing characters');
  return value;
}

const MAX_DEPTH = 512;

class Parser {
  private pos = 0;
  constructor(private readonly text: string) {}

  atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  fail(message: string): PreciseJsonError {
    return new PreciseJsonError(`${message} at position ${this.pos}`);
  }

  skipWhitespace(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) this.pos += 1;
      else break;
    }
  }

  readValue(depth: number): unknown {
    if (depth > MAX_DEPTH) throw this.fail('nesting too deep');
    const c = this.text[this.pos];
    switch (c) {
      case '{':
        return this.readObject(depth);
      case '[':
        return this.readArray(depth);
      case '"':
        return this.readString();
      case 't':
        return this.readLiteral('true', true);
      case 'f':
        return this.readLiteral('false', false);
      case 'n':
        return this.readLiteral('null', null);
      default:
        if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.readNumber();
        throw this.fail('unexpected token');
    }
  }

  private readLiteral<T>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.pos)) throw this.fail('unexpected token');
    this.pos += word.length;
    return value;
  }

  private readNumber(): number | string {
    const start = this.pos;
    const t = this.text;
    if (t[this.pos] === '-') this.pos += 1;
    const first = t[this.pos];
    if (first === '0') this.pos += 1;
    else if (first !== undefined && first >= '1' && first <= '9') this.skipDigits();
    else throw this.fail('invalid number');
    let integer = true;
    if (t[this.pos] === '.') {
      integer = false;
      this.pos += 1;
      if (!this.skipDigits()) throw this.fail('invalid number');
    }
    if (t[this.pos] === 'e' || t[this.pos] === 'E') {
      integer = false;
      this.pos += 1;
      if (t[this.pos] === '+' || t[this.pos] === '-') this.pos += 1;
      if (!this.skipDigits()) throw this.fail('invalid number');
    }
    const literal = t.slice(start, this.pos);
    const asNumber = Number(literal);
    if (integer && !Number.isSafeInteger(asNumber)) return literal;
    return asNumber;
  }

  private skipDigits(): boolean {
    const t = this.text;
    const start = this.pos;
    while (this.pos < t.length && t.charCodeAt(this.pos) >= 0x30 && t.charCodeAt(this.pos) <= 0x39) this.pos += 1;
    return this.pos > start;
  }

  private readString(): string {
    const t = this.text;
    this.pos += 1; // opening quote
    let out = '';
    let chunkStart = this.pos;
    for (;;) {
      if (this.pos >= t.length) throw this.fail('unterminated string');
      const c = t.charCodeAt(this.pos);
      if (c === 0x22) {
        out += t.slice(chunkStart, this.pos);
        this.pos += 1;
        return out;
      }
      if (c < 0x20) throw this.fail('control character in string');
      if (c === 0x5c) {
        out += t.slice(chunkStart, this.pos);
        const e = t[this.pos + 1];
        this.pos += 2;
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = t.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.fail('invalid unicode escape');
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            throw this.fail('invalid escape');
        }
        chunkStart = this.pos;
        continue;
      }
      this.pos += 1;
    }
  }

  private readArray(depth: number): unknown[] {
    this.pos += 1;
    const out: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === ']') {
      this.pos += 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      out.push(this.readValue(depth + 1));
      this.skipWhitespace();
      const c = this.text[this.pos];
      this.pos += 1;
      if (c === ',') continue;
      if (c === ']') return out;
      this.pos -= 1;
      throw this.fail('expected comma or closing bracket');
    }
  }

  private readObject(depth: number): Record<string, unknown> {
    this.pos += 1;
    const out: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.text[this.pos] === '}') {
      this.pos += 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') throw this.fail('expected string key');
      const key = this.readString();
      this.skipWhitespace();
      if (this.text[this.pos] !== ':') throw this.fail('expected colon');
      this.pos += 1;
      this.skipWhitespace();
      const value = this.readValue(depth + 1);
      // __proto__ must stay an own data property, as in JSON.parse.
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
      this.skipWhitespace();
      const c = this.text[this.pos];
      this.pos += 1;
      if (c === ',') continue;
      if (c === '}') return out;
      this.pos -= 1;
      throw this.fail('expected comma or closing brace');
    }
  }
}

const PY_WS = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;
const PY_FLOAT =
  /^[+-]?(?:(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?|inf|infinity|nan)$/i;
const PY_INT = /^[+-]?[0-9](?:_?[0-9])*$/;

/**
 * Python `float(value)` as OkLine auth.py:127-136 uses it. Returns null where Python raises or where the input
 * is not a number or a string. Booleans, null and undefined give null.
 */
export function pythonFloat(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const text = value.replace(PY_WS, '');
  if (!PY_FLOAT.test(text)) return null;
  const lower = text.toLowerCase();
  const sign = lower.startsWith('-') ? -1 : 1;
  const body = lower.replace(/^[+-]/, '');
  if (body === 'inf' || body === 'infinity') return sign * Infinity;
  if (body === 'nan') return Number.NaN;
  return Number(text.replace(/_/g, ''));
}

/**
 * Python `int(value)` as OkLine e2ee.py uses it. Throws ChromeE2eeError where Python raises.
 *
 */
export function pythonInt(value: unknown): number {
  if (value === true) return 1;
  if (value === false) return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ChromeE2eeError(`cannot convert ${String(value)} to an integer`);
    return Math.trunc(value) + 0;
  }
  if (typeof value === 'string') {
    const text = value.replace(PY_WS, '');
    if (PY_INT.test(text)) return Number(text.replace(/_/g, ''));
  }
  throw new ChromeE2eeError(`invalid integer value: ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
}

/** Python truthiness of a JSON value (P7): null, false, 0, "", an empty array and an empty object are false. */
export function pythonTruthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}
