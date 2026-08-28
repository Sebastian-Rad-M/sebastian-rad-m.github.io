import type { Type } from "./ast.js";

export function getByteSize(type: Type): number {
  switch (type) {
    case "U0": return 0;
    case "I8":
    case "U8": return 1;
    case "I16":
    case "U16": return 2;
    case "I32":
    case "U32": return 4;
    case "I64":
    case "U64":
    case "F64": return 8;
    default:
      throw new Error(`Unknown byte size for type: ${type}`);
  }
}

/**
 * In HolyC, pointer arithmetic automatically multiplies the offset by the 
 * size of the underlying type.
 * e.g., if ptr is an I64* (which points to 8 bytes), ptr + 1 advances 8 bytes.
 */
export function getPointerOffset(baseType: Type, offsetElements: number): number {
  return getByteSize(baseType) * offsetElements;
}
