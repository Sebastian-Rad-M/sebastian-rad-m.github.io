import { MemoryModel } from "./memory.js";

export interface RuntimeOptions {
  stdout?: (text: string) => void;
  canvasCtx?: any; 
}

export class Runtime {
  public memory: MemoryModel;
  private options: RuntimeOptions;

  constructor(options: RuntimeOptions = {}) {
    this.memory = new MemoryModel();
    this.options = {
      stdout: options.stdout || ((text) => process.stdout.write(text)),
      canvasCtx: options.canvasCtx || null
    };
  }

  /**
   * Reads a null-terminated string from Wasm memory at the given pointer.
   */
  private readString(ptr: number): string {
    const buffer = new Uint8Array(this.memory.memory.buffer);
    let end = ptr;
    while (buffer[end] !== 0) {
      end++;
    }
    const stringBytes = buffer.slice(ptr, end);
    return new TextDecoder().decode(stringBytes);
  }

  /**
   * Print host function
   * Reads the string at string_ptr and outputs it to stdout
   */
  public Print(string_ptr: bigint, ...args: bigint[]): void {
    const ptr = Number(string_ptr);
    let text = this.readString(ptr);

    // Substitute format specifiers strictly left-to-right, consuming
    // arguments in order (order-dependent scanning produced wrong output).
    let argIdx = 0;
    text = text.replace(/%[dXcsf]/g, (spec: string): string => {
      const arg = args[argIdx++];
      if (arg === undefined) return spec;
      switch (spec) {
        case "%d": return arg.toString();
        case "%X": return BigInt.asUintN(64, arg).toString(16).toUpperCase();
        case "%c": return String.fromCharCode(Number(BigInt.asUintN(32, arg)));
        case "%s": return this.readString(Number(arg));
        case "%f": {
          const floatVal = new Float64Array(new BigInt64Array([arg]).buffer)[0];
          return floatVal!.toFixed(6);
        }
        default: return spec;
      }
    });

    if (this.options.stdout) {
      this.options.stdout(text);
    }
  }

  /**
   * HolyC Graphic Line host function
   * Draws a line from (x1, y1) to (x2, y2)
   */
  public GrLine(x1: bigint, y1: bigint, x2: bigint, y2: bigint): void {
    if (this.options.canvasCtx) {
      this.options.canvasCtx.beginPath();
      this.options.canvasCtx.moveTo(Number(x1), Number(y1));
      this.options.canvasCtx.lineTo(Number(x2), Number(y2));
      this.options.canvasCtx.stroke();
    } else {
      console.log(`[Graphics] GrLine(${x1}, ${y1}, ${x2}, ${y2})`);
    }
  }

  public getImportObject(): WebAssembly.Imports {
    return {
      env: {
        memory: this.memory.memory,
        // i64 wasm boundary -> BigInt in and out; matches MemoryModel.MAlloc.
        MAlloc: this.memory.MAlloc.bind(this.memory),
        Free: this.memory.Free.bind(this.memory),
        Print0: (ptr: bigint) => this.Print(ptr),
        Print1: (ptr: bigint, a: bigint) => this.Print(ptr, a),
        Print2: (ptr: bigint, a: bigint, b: bigint) => this.Print(ptr, a, b),
        Print3: (ptr: bigint, a: bigint, b: bigint, c: bigint) => this.Print(ptr, a, b, c),
        Print4: (ptr: bigint, a: bigint, b: bigint, c: bigint, d: bigint) => this.Print(ptr, a, b, c, d),
        GrLine: this.GrLine.bind(this)
      }
    };
  }
}
