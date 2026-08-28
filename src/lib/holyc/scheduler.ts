import { MemoryModel } from "./memory.js";

interface Task {
  id: number;
  asyncifyBufferPtr: number;
  status: "running" | "sleeping" | "ready" | "done";
  invoke: () => void;
  isFirstRun: boolean;
}

export class TaskManager {
  private tasks: Task[] = [];
  private currentTask: Task | null = null;
  private nextTaskId = 1;
  public instance?: WebAssembly.Instance;

  constructor(private memory: MemoryModel) {}

  public setInstance(instance: WebAssembly.Instance) {
    this.instance = instance;
  }
  
  public spawnMain(invoke: () => void) {
      this.createTask(invoke);
      this.schedule();
  }

  private createTask(invoke: () => void): Task {
    const ptrBigInt = this.memory.MAlloc(1032);
    const ptr = Number(ptrBigInt);
    const view = new DataView(this.memory.memory.buffer);
    view.setUint32(ptr, ptr + 8, true);
    view.setUint32(ptr + 4, ptr + 1032, true);
    
    const task: Task = {
      id: this.nextTaskId++,
      asyncifyBufferPtr: ptr,
      status: "ready",
      invoke,
      isFirstRun: true
    };
    this.tasks.push(task);
    return task;
  }

  public schedule() {
     const loop = () => {
         const readyTasks = this.tasks.filter(t => t.status === "ready");
         if (readyTasks.length === 0) {
            if (this.tasks.some(t => t.status === "sleeping")) {
                setTimeout(loop, 10);
            }
            return;
         }
         
         const task = readyTasks[0]!;
         this.tasks = this.tasks.filter(t => t !== task);
         this.tasks.push(task); // round-robin
         
         this.currentTask = task;
         task.status = "running";
         
         const exports = this.instance!.exports as any;
         
         console.log(`[Scheduler] Resuming Task ${task.id} (isFirstRun: ${task.isFirstRun})`);
         if (!task.isFirstRun) {
             exports.asyncify_start_rewind(task.asyncifyBufferPtr);
         }
         
         try {
             task.invoke();
         } catch(e: any) {
             console.error(`[Scheduler] Task ${task.id} failed:`, e);
         }
         
         if (!task.isFirstRun) {
             exports.asyncify_stop_rewind();
         }
         
         if (task.status === "running") {
             console.log(`[Scheduler] Task ${task.id} completed.`);
             task.status = "done";
             this.tasks = this.tasks.filter(t => t !== task);
             this.memory.Free(task.asyncifyBufferPtr);
         } else {
             console.log(`[Scheduler] Task ${task.id} yielded (Status: ${task.status}).`);
             exports.asyncify_stop_unwind();
         }
         
         task.isFirstRun = false;
         this.currentTask = null;
         
         setTimeout(loop, 0);
     };
     loop();
  }

  public Yield(): void {
    if (this.currentTask) {
        const exports = this.instance!.exports as any;
        if (exports.asyncify_get_state() === 2) {
            exports.asyncify_stop_rewind();
            return;
        }
        
        console.log(`[Scheduler] Task ${this.currentTask.id} requested Yield.`);
        this.currentTask.status = "ready";
        exports.asyncify_start_unwind(this.currentTask.asyncifyBufferPtr);
    }
  }

  public Sleep(ms: bigint): void {
    if (this.currentTask) {
        const exports = this.instance!.exports as any;
        if (exports.asyncify_get_state() === 2) {
            exports.asyncify_stop_rewind();
            return;
        }

        const task = this.currentTask;
        task.status = "sleeping";
        exports.asyncify_start_unwind(task.asyncifyBufferPtr);
        setTimeout(() => {
            task.status = "ready";
        }, Number(ms));
    }
  }

  private readString(ptr: number): string {
    const buffer = new Uint8Array(this.memory.memory.buffer);
    let end = ptr;
    while (buffer[end] !== 0) {
      end++;
    }
    return new TextDecoder().decode(buffer.slice(ptr, end));
  }

  public Spawn(funcPtr: bigint, arg: bigint, namePtr: bigint): bigint {
      const fnIndex = Number(funcPtr);
      const name = this.readString(Number(namePtr));
      
      const task = this.createTask(() => {
          const exports = this.instance!.exports as any;
          const fn = exports.table.get(fnIndex);
          if (fn) fn(arg);
      });
      
      return BigInt(task.id);
  }

  public getImports() {
      return {
        Yield: this.Yield.bind(this),
        Sleep: this.Sleep.bind(this),
        Spawn: this.Spawn.bind(this)
      };
  }
}
