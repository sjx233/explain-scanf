import parseHexFloat from "@webassemblyjs/floating-point-hex-parser";
import { DeclarationSpecifier, Expression, FloatingConstant, Layer, TypeSpecifier } from "./c-ast";
import { findIndex } from "./util";

const emptySet = new Set<string>();
const whitespace = new Set(" \t\n\r\v\f");
const whitespaceRE = /^[ \t\n\r\v\f]+/;
const convValidateRE = /^%(?:(?:\d+\$)?(?:|hh|h|l|ll|j|z|t)n|(?:\d+\$|\*?)(?:[1-9]\d*)?(?:(?:|hh|h|l|ll|j|z|t)[diouxX]|(?:|l|L)[aAeEfFgG]|m?(?:l?(?:[cs]|\[(?:\^|(?!\^))[^\]]+\])|[CS])|p))/;
const convParseRE = /^%(\d+\$|\*?)(\d*)(m?)(|hh|h|l|ll|j|z|t|L)([diouxXaAeEfFgGcsCSpn]|\[(?:\^|(?!\^))[^\]]+\])/;
const scanlistRE = /^\[(\^?)(.[^\]]*)\]$/;
const intBases = new Map<string, number>([
  ["o", 8],
  ["d", 10],
  ["u", 10],
  ["x", 16],
  ["X", 16]
]);
const intTypes = new Map<string, { signed: TypeSpecifier[]; unsigned: TypeSpecifier[]; }>([
  ["hh", { signed: ["signed", "char"], unsigned: ["unsigned", "char"] }],
  ["h", { signed: ["short", "int"], unsigned: ["unsigned", "short", "int"] }],
  ["", { signed: ["int"], unsigned: ["unsigned", "int"] }],
  ["l", { signed: ["long", "int"], unsigned: ["unsigned", "long", "int"] }],
  ["ll", { signed: ["long", "long", "int"], unsigned: ["unsigned", "long", "long", "int"] }],
  ["j", { signed: ["intmax_t"], unsigned: ["uintmax_t"] }],
  ["z", { signed: ["signed", "size_t"], unsigned: ["size_t"] }],
  ["t", { signed: ["ptrdiff_t"], unsigned: ["unsigned", "ptrdiff_t"] }]
]);
const floatTypes = new Map<string, TypeSpecifier[]>([
  ["", ["float"]],
  ["l", ["double"]],
  ["L", ["long", "double"]]
]);

function truncate(s: string, length: number): string {
  return length ? s.substring(0, length) : s;
}

function intType(length: string, unsigned: boolean): TypeSpecifier[] {
  const type = intTypes.get(length);
  if (!type)
    throw new Error(`Unknown int type '${length}'`);
  return unsigned ? type.unsigned : type.signed;
}

function floatType(length: string): TypeSpecifier[] {
  const type = floatTypes.get(length);
  if (!type)
    throw new Error(`Unknown float type '${length}'`);
  return type;
}

export interface IntegerConvSpec {
  type: "integer";
  base: number;
  dataType: TypeSpecifier[];
}

export interface FloatConvSpec {
  type: "float";
  dataType: TypeSpecifier[];
}

export interface StringConvSpec {
  type: "string";
  malloc: boolean;
  terminate: boolean;
  wide: boolean;
  scanset: Set<string>;
  negated: boolean;
}

export interface PointerConvSpec {
  type: "pointer";
}

export interface ByteCountConvSpec {
  type: "bytecount";
  dataType: TypeSpecifier[];
}

export type ConvSpec =
  | IntegerConvSpec
  | FloatConvSpec
  | StringConvSpec
  | PointerConvSpec
  | ByteCountConvSpec;

export interface WhitespaceDirective {
  type: "whitespace";
  implicit: boolean;
}

export interface LiteralDirective {
  type: "literal";
  ch: string;
}

export interface ConversionDirective {
  type: "conversion";
  start: number;
  end: number;
  position: number;
  width: number;
  spec: ConvSpec;
}

export type FormatDirective =
  | WhitespaceDirective
  | LiteralDirective
  | ConversionDirective;

function getConvSpec(spec: string, length: string, malloc: boolean): ConvSpec {
  switch (spec) {
    case "d":
    case "i":
    case "o":
    case "u":
    case "x":
    case "X":
      return { type: "integer", base: intBases.get(spec) ?? 0, dataType: intType(length, spec !== "d" && spec !== "i") };
    case "a":
    case "A":
    case "e":
    case "E":
    case "f":
    case "F":
    case "g":
    case "G":
      return { type: "float", dataType: floatType(length) };
    case "s":
    case "S":
    case "c":
    case "C":
      return {
        type: "string",
        malloc,
        terminate: spec === "s" || spec === "S",
        wide: length === "l" || spec === "S" || spec === "C",
        scanset: spec === "s" || spec === "S" ? whitespace : emptySet,
        negated: true
      };
    case "p":
      return { type: "pointer" };
    case "n":
      return { type: "bytecount", dataType: intType(length, false) };
    default: {
      const scanlistMatch = scanlistRE.exec(spec);
      if (!scanlistMatch)
        throw new Error("Invalid conversion specifier");
      return {
        type: "string",
        malloc,
        terminate: true,
        wide: length === "l",
        scanset: new Set(scanlistMatch[2]),
        negated: Boolean(scanlistMatch[1])
      };
    }
  }
}

export function parseFormat(format: string): FormatDirective[] | undefined {
  const length = format.length;
  const result: FormatDirective[] = [];
  let nextPos = 0;
  for (let index = 0; index < length;) {
    const remaining = format.substring(index);
    const whitespaceMatch = whitespaceRE.exec(remaining);
    if (whitespaceMatch) {
      result.push({ type: "whitespace", implicit: false });
      index += whitespaceMatch[0].length;
      continue;
    }
    if (convValidateRE.test(remaining)) {
      const conversionMatch = convParseRE.exec(remaining);
      if (!conversionMatch)
        throw new Error("Failed to match conversion");
      const position = (pos => {
        switch (pos) {
          case "":
            if (nextPos === -1)
              return undefined;
            return nextPos++;
          case "*":
            return -1;
          default:
            if (nextPos > 0)
              return undefined;
            nextPos = -1;
            return parseInt(pos, 10) - 1;
        }
      })(conversionMatch[1]);
      if (position === undefined)
        return undefined;
      const spec = conversionMatch[5];
      const length = conversionMatch[4];
      const malloc = Boolean(conversionMatch[3]);
      const width = conversionMatch[2] ? parseInt(conversionMatch[2], 10) : spec === "c" || spec === "C" ? 1 : 0;
      if (spec[0] !== "[" && spec !== "c" && spec !== "C" && spec !== "n")
        result.push({ type: "whitespace", implicit: true });
      const convLength = conversionMatch[0].length;
      result.push({ type: "conversion", start: index, end: index + convLength, position, width, spec: getConvSpec(spec, length, malloc) });
      index += convLength;
      continue;
    }
    const ch = format[index++];
    if (ch === "%" && format[index++] !== "%")
      return undefined;
    result.push({ type: "whitespace", implicit: true }, { type: "literal", ch });
  }
  return result;
}

export interface Range {
  start: number;
  end: number;
}

export interface Conversion {
  index: Range;
  match: Range | null;
  position: number;
}

export interface Argument {
  specifiers: DeclarationSpecifier[];
  type: Layer[];
  initializer: Expression;
  ref: boolean;
}

export interface ScanfResult {
  ret: number;
  length: number;
  convs: Conversion[];
  args: Argument[];
}

const matchingFailure: unique symbol = Symbol("matchingFailure");
const inputFailure: unique symbol = Symbol("inputFailure");
export const unimplemented: unique symbol = Symbol("unimplemented");

export function sscanf(buf: string, format: FormatDirective[]): ScanfResult | typeof unimplemented | undefined {
  const convs: Conversion[] = [];
  const args: Argument[] = [];
  let ret = 0;
  let lastOffset = 0;
  let offset = 0;
  let i = 0;
  const count = format.length;
  scan: while (i < count) {
    const directive = format[i];
    switch (directive.type) {
      case "whitespace": {
        const match = whitespaceRE.exec(buf.substring(offset));
        if (match)
          offset += match[0].length;
        if (!directive.implicit)
          lastOffset = offset;
        break;
      }
      case "literal": {
        if (offset >= buf.length) {
          if (ret === 0)
            ret = -1;
          break scan;
        }
        if (buf[offset] !== directive.ch)
          break scan;
        lastOffset = ++offset;
        break;
      }
      case "conversion": {
        const { start, end, position, width, spec } = directive;
        const arg = ((): Argument | typeof matchingFailure | typeof inputFailure | typeof unimplemented => {
          const str = truncate(buf.substring(offset), width);
          const failure = str ? matchingFailure : inputFailure;
          switch (spec.type) {
            case "integer": {
              const result = parseIntSeq(str, spec.base);
              if (!result)
                return failure;
              offset += result.length;
              return {
                specifiers: spec.dataType,
                type: [],
                initializer: { type: "integer_constant", value: result.value },
                ref: true
              };
            }
            case "float": {
              const result = parseFloatSeq(str);
              if (!result)
                return failure;
              offset += result.length;
              return {
                specifiers: spec.dataType,
                type: [],
                initializer: { type: "floating_constant", value: result.value },
                ref: true
              };
            }
            case "string": {
              const length = findIndex(str, c => spec.scanset.has(c) === spec.negated);
              if (!length)
                return failure;
              offset += length;
              const result = str.substring(0, length);
              const size = (spec.wide ? length : new TextEncoder().encode(result).length) + (spec.terminate ? 1 : 0);
              return {
                specifiers: spec.wide ? ["wchar_t"] : ["char"],
                type: spec.malloc ? [{ type: "pointer" }] : size === 1 ? [] : [{ type: "array", size }],
                initializer: spec.malloc ? { type: "function_call", name: spec.wide ? "wcsdup" : "strdup", args: [{ type: "string_literal", prefix: spec.wide ? "L" : "", value: result }] } : { type: size === 1 ? "character_constant" : "string_literal", prefix: spec.wide ? "L" : "", value: result },
                ref: spec.malloc || size === 1
              };
            }
            case "pointer":
              return unimplemented;
            case "bytecount":
              return {
                specifiers: spec.dataType,
                type: [],
                initializer: { type: "integer_constant", value: BigInt(offset) },
                ref: true
              };
          }
        })();
        if (arg === inputFailure) {
          if (ret === 0)
            ret = -1;
          break scan;
        }
        if (arg === matchingFailure)
          break scan;
        if (arg === unimplemented)
          return unimplemented;
        if (position !== -1) {
          if (spec.type !== "bytecount")
            ret++;
          if (args[position])
            return unimplemented;
          args[position] = arg;
        }
        convs.push({
          index: { start, end },
          match: { start: lastOffset, end: offset },
          position
        });
        lastOffset = offset;
        break;
      }
    }
    i++;
  }
  while (i < count) {
    const directive = format[i];
    if (directive.type === "conversion")
      convs.push({
        index: { start: directive.start, end: directive.end },
        match: null,
        position: directive.position
      });
    i++;
  }
  return { ret, length: offset, convs, args };
}

interface IntSeq {
  value: bigint;
  length: number;
}

const intSeqREs = [
  /^([+-]?)([1-9]\d*|0[xX][0-9A-Fa-f]+|0[0-7]*)/,
  undefined,
  /^([+-]?)([01]+)/,
  /^([+-]?)([0-2]+)/,
  /^([+-]?)([0-3]+)/,
  /^([+-]?)([0-4]+)/,
  /^([+-]?)([0-5]+)/,
  /^([+-]?)([0-6]+)/,
  /^([+-]?)([0-7]+)/,
  /^([+-]?)([0-8]+)/,
  /^([+-]?)(\d+)/,
  /^([+-]?)([0-9aA]+)/,
  /^([+-]?)([0-9abAB]+)/,
  /^([+-]?)([0-9a-cA-C]+)/,
  /^([+-]?)([0-9a-dA-D]+)/,
  /^([+-]?)([0-9a-eA-E]+)/,
  /^([+-]?)(?:0[xX])?([0-9a-fA-F]+)/,
  /^([+-]?)([0-9a-gA-G]+)/,
  /^([+-]?)([0-9a-hA-H]+)/,
  /^([+-]?)([0-9a-iA-I]+)/,
  /^([+-]?)([0-9a-jA-J]+)/,
  /^([+-]?)([0-9a-kA-K]+)/,
  /^([+-]?)([0-9a-lA-L]+)/,
  /^([+-]?)([0-9a-mA-M]+)/,
  /^([+-]?)([0-9a-nA-N]+)/,
  /^([+-]?)([0-9a-oA-O]+)/,
  /^([+-]?)([0-9a-pA-P]+)/,
  /^([+-]?)([0-9a-qA-Q]+)/,
  /^([+-]?)([0-9a-rA-R]+)/,
  /^([+-]?)([0-9a-sA-S]+)/,
  /^([+-]?)([0-9a-tA-T]+)/,
  /^([+-]?)([0-9a-uA-U]+)/,
  /^([+-]?)([0-9a-vA-V]+)/,
  /^([+-]?)([0-9a-wA-W]+)/,
  /^([+-]?)([0-9a-xA-X]+)/,
  /^([+-]?)([0-9a-yA-Y]+)/,
  /^([+-]?)([0-9a-zA-Z]+)/
];

function parseIntSeq(str: string, base: number): IntSeq | undefined {
  const re = intSeqREs[base];
  if (!re)
    return undefined;
  const match = re.exec(str);
  if (!match)
    return undefined;
  const length = match[0].length;
  const sign = match[1] === "-" ? -1n : 1n;
  let l = match[2].toLowerCase();
  if (base === 0)
    if (l[0] !== "0")
      base = 10;
    else if (l[1] !== "x")
      base = 8;
    else {
      base = 16;
      l = l.substring(2);
    }
  let value = 0n;
  for (const c of l)
    value = value * BigInt(base) + BigInt("0123456789abcdefghijklmnopqrstuvwxyz".indexOf(c));
  return { value: sign * value, length };
}

interface FloatSeq {
  value: FloatingConstant["value"];
  length: number;
}

const floatSeqRE = /^([+-]?)(0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?![0-9a-fA-F])(?:[pP][+-]?\d+|(?![pP]))|(?:\d+(?:\.\d*)?|\.\d+)(?!\d)(?:[eE][+-]?\d+|(?![eE]))|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?|[nN][aN][nN](?:\([0-9A-Za-z_]*\))?)/;

function parseFloatSeq(str: string): FloatSeq | undefined {
  const match = floatSeqRE.exec(str);
  if (!match)
    return undefined;
  const length = match[0].length;
  const sign = match[1] === "-" ? -1 : 1;
  const magnitude = match[2];
  const l = magnitude.toLowerCase();
  if (l.startsWith("nan"))
    return { value: { sign, magnitude: NaN, payload: magnitude.length === 3 ? undefined : magnitude.slice(4, -1) }, length };
  if (l.startsWith("inf"))
    return { value: { sign, magnitude: Infinity }, length };
  return { value: { sign, magnitude: l.startsWith("0x") ? parseHexFloat(l) : parseFloat(l) }, length };
}
