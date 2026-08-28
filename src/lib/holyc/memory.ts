export class MemoryModel {
  public memory: WebAssembly.Memory;
  private heapPtr: number;

  public readonly STACK_SIZE = 64 * 1024; // Page 0: 64KB Stack
  public readonly STATIC_DATA_SIZE = 64 * 1024; // Page 1: 64KB Static Strings/Globals
  public readonly HEAP_START = this.STACK_SIZE + this.STATIC_DATA_SIZE; // 0x20000

  constructor(initialPages: number = 10, maxPages: number = 256) {
    this.memory = new WebAssembly.Memory({ initial: initialPages, maximum: maxPages });
    this.heapPtr = this.HEAP_START; 
  }

  /**
   * Bump allocator for MAlloc
   * @param size Number of bytes to allocate
   * @returns A BigInt pointer to the allocated linear memory
   */
  public MAlloc(size: number | bigint): bigint {
    const allocSize = typeof size === 'bigint' ? Number(size) : size;
    const ptr = this.heapPtr;
    
    this.heapPtr += allocSize;
    
    if (this.heapPtr % 8 !== 0) {
      this.heapPtr += 8 - (this.heapPtr % 8);
    }
    
    if (this.heapPtr > this.memory.buffer.byteLength) {
      const pagesNeeded = Math.ceil((this.heapPtr - this.memory.buffer.byteLength) / 65536);
      this.memory.grow(pagesNeeded);
    }

    if (allocSize > 0) {
      new Uint8Array(this.memory.buffer, ptr, allocSize).fill(0);
    }

    return BigInt(ptr);
  }

  /**
   * Bump allocator Free (No-Op)
   */
  public Free(ptr: number | bigint) {
    // A standard bump allocator does not reclaim memory.
  }

  public getImportObject() {
    return {
      env: {
        memory: this.memory,
        MAlloc: this.MAlloc.bind(this),
        Free: this.Free.bind(this),
      }
    };
  }

  public readI64(ptr: number): bigint {
    const view = new BigInt64Array(this.memory.buffer, ptr, 1);
    return view[0]!;
  }

  public writeI64(ptr: number, value: bigint) {
    const view = new BigInt64Array(this.memory.buffer, ptr, 1);
    view[0] = value;
  }
}
