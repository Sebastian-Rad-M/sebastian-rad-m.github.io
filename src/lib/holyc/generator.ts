import binaryen from "binaryen";
import * as AST from "./ast.js";

export class Generator {
  public module: binaryen.Module;

  private globalTypes = new Map<string, { type: binaryen.Type, className?: string, pointerDepth?: number, holycType?: string }>();
  private classLayouts = new Map<string, { size: number, align: number, members: Map<string, { offset: number, type: binaryen.Type, pointerDepth?: number, holycType?: string, isArray?: boolean }> }>();
  private functions = new Map<string, AST.FunctionDeclaration>();
  /** Function-pointer variables: var name -> target function name. */
  private fnPtrVars = new Map<string, string>();
  private stringTable: { offset: number, data: Uint8Array }[] = [];
  private functionTableMap = new Map<string, number>();
  private staticDataPtr = 0x10000;
  private currentBreakTarget: string | null = null;
  private currentContinueTarget: string | null = null;
  private currentFnReturnsValue = true;
  private nextLabelId = 0;
  private currentCatchTarget: string | null = null;
  
  //scopes is meant for scope resolution, all of these are kinda needed.
  private scopes: Map<string, { index: number, type: binaryen.Type, className?: string, isMemLocal: boolean, pointerDepth: number, holycType?: string, arraySize?: any }>[] = [];
  private currentLocalTypes: binaryen.Type[] = [];
  private currentLocalBaseIndex = 0;
  private currentLocalsWithAddressTaken = new Set<string>();

  private getLocal(name: string) {
      for (let i = this.scopes.length - 1; i >= 0; i--) {
          if (this.scopes[i]!.has(name)) return this.scopes[i]!.get(name);
      }
      return undefined;
  }

  //Allocates a fresh function-local as scratch space. Must only be called while a function body is being generated (before addFunction()).

  private allocTemp(type: binaryen.Type): number {
      const index = this.currentLocalBaseIndex + this.currentLocalTypes.length;
      this.currentLocalTypes.push(type);
      return index;
  }

  // Builds a store instruction for the given element width.
   private buildStore(bytes: number, ptr32: binaryen.ExpressionRef, val: binaryen.ExpressionRef, valType: binaryen.Type): binaryen.ExpressionRef {
      if (valType === binaryen.f64) return this.module.f64.store(0, 8, ptr32, val);
      if (bytes === 1) return this.module.i32.store8(0, 1, ptr32, this.module.i32.wrap(val));
      if (bytes === 2) return this.module.i32.store16(0, 2, ptr32, this.module.i32.wrap(val));
      if (bytes === 4) return this.module.i32.store(0, 4, ptr32, this.module.i32.wrap(val));
      return this.module.i64.store(0, 8, ptr32, val);
  }

  private resolveExprType(e: AST.Expression): { t: string, depth: number } {
      if (e.type === "Identifier") {
          const localDecl = this.getLocal(e.name);
          if (localDecl) return { t: localDecl.holycType || "", depth: localDecl.pointerDepth || 0 };
          if (this.globalTypes.has(e.name)) {
              const g = this.globalTypes.get(e.name)!;
              return { t: g.holycType || "", depth: g.pointerDepth || 0 };
          }
      }
      if (e.type === "MemberExpression") {
          const parent = this.resolveExprType(e.object);
          if (parent.t && this.classLayouts.has(parent.t)) {
              const member = this.classLayouts.get(parent.t)!.members.get(e.property);
              if (member) return { t: member.holycType || "", depth: member.pointerDepth || 0 };
          }
      }
      if (e.type === "IndexExpression") {
          const parent = this.resolveExprType(e.object);
          if (parent.depth > 0) return { t: parent.t, depth: parent.depth - 1 };
      }
      if (e.type === "UnaryExpression" && e.operator === "*") {
          const parent = this.resolveExprType(e.argument);
          if (parent.depth > 0) return { t: parent.t, depth: parent.depth - 1 };
      }
      if ((e.type === "BinaryExpression") && (e.operator === "+" || e.operator === "-")) {
          const l = this.resolveExprType(e.left);
          const r = this.resolveExprType(e.right);
          if (l.depth > 0 && r.depth === 0) return { t: l.t, depth: l.depth };
          if (r.depth > 0 && l.depth === 0 && e.operator === "+") return { t: r.t, depth: r.depth };
      }
      return { t: "", depth: 0 };
  }
  // separation of concerns? nah, i call it arround here, it's fine
  private elemByteWidth(t: string): number {
      if (t === "I8" || t === "U8") return 1;
      if (t === "I16" || t === "U16") return 2;
      if (t === "I32" || t === "U32") return 4;
      return 8;
  }

  
  private pointeeWidth(t: string, depth: number): number {
      if (depth < 1) return 8;
      if (t === "I8" || t === "U8") return 1;
      if (t === "I16" || t === "U16") return 2;
      if (t === "I32" || t === "U32") return 4;
      return 8;
  }

  // Loads the element a pointer expression points to, honoring its width/type.
  private loadPointee(t: string, depth: number, ptr32: binaryen.ExpressionRef): binaryen.ExpressionRef {
      if (t === "F64") return this.module.f64.load(0, 8, ptr32);
      const w = this.pointeeWidth(t, depth);
      if (w === 1) return this.module.i64.extend_u(this.module.i32.load8_u(0, 1, ptr32));
      if (w === 2) return this.module.i64.extend_u(this.module.i32.load16_u(0, 2, ptr32));
      if (w === 4) return this.module.i64.extend_u(this.module.i32.load(0, 4, ptr32));
      return this.module.i64.load(0, 8, ptr32);
  }

  // Typed +1 / -1 arithmetic used by ++ and -- (works for i64 and f64). 
  private arithOne(val: binaryen.ExpressionRef, type: binaryen.Type, isPlus: boolean): binaryen.ExpressionRef {
      if (type === binaryen.f64) {
          const one = this.module.f64.const(1);
          return isPlus ? this.module.f64.add(val, one) : this.module.f64.sub(val, one);
      }
      const one = this.module.i64.const(1n);
      return isPlus ? this.module.i64.add(val, one) : this.module.i64.sub(val, one);
  }

  // Lazily reserves a table slot for a function (index 0 is the null entry)
  private ensureFuncIndex(name: string): number {
      let idx = this.functionTableMap.get(name);
      if (idx === undefined) {
          idx = this.functionTableMap.size + 1;
          this.functionTableMap.set(name, idx);
      }
      return idx;
  }

  // Fills default arguments and coerces f64<->i64 to match callee params. 
  private prepareCallArgs(funcDecl: AST.FunctionDeclaration, args: binaryen.ExpressionRef[]): binaryen.ExpressionRef[] {
      const out = [...args];
      while (out.length < funcDecl.params.length) {
          const p = funcDecl.params[out.length]!;
          if (p.defaultValue) out.push(this.generateExpression(p.defaultValue));
          else out.push(this.module.i64.const(0n));
      }
      return out.map((arg, i) => {
         if (i >= funcDecl.params.length) return arg;
         const param = funcDecl.params[i]!;
         const expected = this.mapType(param.varType, param.pointerDepth);
         const actual = binaryen.getExpressionType(arg);
         if (expected === binaryen.f64 && actual === binaryen.i64) return this.module.f64.convert_s.i64(arg);
         if (expected === binaryen.i64 && actual === binaryen.f64) return this.module.i64.trunc_s.f64(arg);
         return arg;
      });
  }
  
  constructor() {
    this.module = new binaryen.Module(); 
    this.module.addFunctionImport("Print0", "env", "Print0", binaryen.createType([binaryen.i64]), binaryen.none);
    this.module.addFunctionImport("Print1", "env", "Print1", binaryen.createType([binaryen.i64, binaryen.i64]), binaryen.none);
    this.module.addFunctionImport("Print2", "env", "Print2", binaryen.createType([binaryen.i64, binaryen.i64, binaryen.i64]), binaryen.none);
    this.module.addFunctionImport("Print3", "env", "Print3", binaryen.createType([binaryen.i64, binaryen.i64, binaryen.i64, binaryen.i64]), binaryen.none);
    this.module.addFunctionImport("Print4", "env", "Print4", binaryen.createType([binaryen.i64, binaryen.i64, binaryen.i64, binaryen.i64, binaryen.i64]), binaryen.none);
    this.module.addFunctionImport("GrLine", "env", "GrLine", binaryen.createType([binaryen.i64, binaryen.i64, binaryen.i64, binaryen.i64]), binaryen.none);
    this.module.addFunctionImport("Yield", "env", "Yield", binaryen.none, binaryen.none);
    this.module.addFunctionImport("Sleep", "env", "Sleep", binaryen.createType([binaryen.i64]), binaryen.none);
    this.module.addFunctionImport("Spawn", "env", "Spawn", binaryen.createType([binaryen.i64, binaryen.i64, binaryen.i64]), binaryen.i64);
    this.module.addFunctionImport("MAlloc", "env", "MAlloc", binaryen.createType([binaryen.i64]), binaryen.i64);
    this.module.addFunctionImport("Free", "env", "Free", binaryen.createType([binaryen.i64]), binaryen.none);

}

  private mapType(type: AST.Type | string, pointerDepth: number = 0): binaryen.Type {
    if (pointerDepth > 0) return binaryen.i64;
    switch (type) {
      case "U0": return binaryen.none;
      case "I64": 
      case "U64": return binaryen.i64;
      case "F64": return binaryen.f64;
      case "I32":
      case "U32":
      case "I16":
      case "U16":
      case "I8":
      case "U8": return binaryen.i64; 
      default: 
        if (this.classLayouts.has(type as string)) return binaryen.i64;
        throw new Error(`Unsupported type: ${type}`);
    }
  }
  //godfunction.
  public generate(program: AST.Program): Uint8Array {
    const collectStrings = (expr: AST.Expression) => {
        if (expr.type === "StringLiteral") {
            const encoder = new TextEncoder();
            const data = encoder.encode(expr.value + "\0");
            this.stringTable.push({ offset: this.staticDataPtr, data });
            expr.rawValue = this.staticDataPtr.toString();
            this.staticDataPtr += data.length;
        } else if (expr.type === "BinaryExpression") {
            collectStrings(expr.left); collectStrings(expr.right);
        } else if (expr.type === "CallExpression") {
            expr.arguments.forEach(collectStrings);
        } else if (expr.type === "AssignmentExpression") {
            collectStrings(expr.left); collectStrings(expr.right);
        } else if (expr.type === "UnaryExpression") {
            collectStrings(expr.argument);
        } else if (expr.type === "MemberExpression" || expr.type === "IndexExpression") {
            collectStrings(expr.object);
            if (expr.type === "IndexExpression") collectStrings(expr.index);
        } else if (expr.type === "UpdateExpression") {
            collectStrings(expr.argument);
        } else if (expr.type === "TernaryExpression") {
            collectStrings(expr.test); collectStrings(expr.consequent); collectStrings(expr.alternate);
        } else if (expr.type === "ArrayLiteral") {
            expr.elements.forEach(collectStrings);
        }
    };
    const scanStrings = (stmt: AST.Statement) => {
        if (stmt.type === "VariableDeclaration" && stmt.initializer) collectStrings(stmt.initializer);
        if (stmt.type === "ExpressionStatement") collectStrings(stmt.expression);
        if (stmt.type === "ReturnStatement" && stmt.argument) collectStrings(stmt.argument);
        if (stmt.type === "IfStatement") { collectStrings(stmt.test); scanStrings(stmt.consequent); if (stmt.alternate) scanStrings(stmt.alternate); }
        if (stmt.type === "ForStatement") {
            if (stmt.init) scanStrings(stmt.init);
            if (stmt.test) collectStrings(stmt.test);
            if (stmt.update) collectStrings(stmt.update);
            scanStrings(stmt.body);
        }
        if (stmt.type === "WhileStatement") { collectStrings(stmt.test); scanStrings(stmt.body); }
        if (stmt.type === "SwitchStatement") {
            collectStrings(stmt.discriminant);
            for (const c of stmt.cases) {
                if (c.test) collectStrings(c.test);
                if (c.rangeEnd) collectStrings(c.rangeEnd);
                c.consequent.forEach(scanStrings);
            }
        }
        if (stmt.type === "TryStatement") {
            stmt.block.body.forEach(scanStrings);
            stmt.handler.body.forEach(scanStrings);
        }
        if (stmt.type === "BlockStatement") stmt.body.forEach(scanStrings);
        if (stmt.type === "FunctionDeclaration") stmt.body.body.forEach(scanStrings);
    };
    program.body.forEach(scanStrings);

    const segments = this.stringTable.map(s => ({
      offset: this.module.i32.const(s.offset),
      data: s.data,
      passive: false
    }));
    this.module.setMemory(10, 256, "memory", segments, false, false, "0");
    this.module.addGlobal("heap_ptr", binaryen.i32, true, this.module.i32.const(0x20000));

    const functions: AST.FunctionDeclaration[] = [];
    const globalStmts: AST.Statement[] = [];
    for (const stmt of program.body) {
      if (stmt.type === "FunctionDeclaration") {
        functions.push(stmt);
        this.functions.set(stmt.name, stmt);
      } else if (stmt.type === "VariableDeclaration") {
        const type = this.mapType(stmt.varType, stmt.pointerDepth);
        const className = this.classLayouts.has(stmt.varType) ? stmt.varType : undefined;
        this.globalTypes.set(stmt.name, { type, className, pointerDepth: stmt.pointerDepth, holycType: stmt.varType });
        let initExpr = this.module.i32.const(0);
        if (type === binaryen.i64 || type === binaryen.f64) {
          initExpr = type === binaryen.i64 ? this.module.i64.const(0n) : this.module.f64.const(0);
        }
        if (stmt.initializer && stmt.initializer.type === "NumberLiteral") {
          if (type === binaryen.i64) initExpr = this.module.i64.const(BigInt(stmt.initializer.rawValue || stmt.initializer.value));
          else if (type === binaryen.f64) initExpr = this.module.f64.const(stmt.initializer.value);
          else initExpr = this.module.i32.const(stmt.initializer.value);
        } else if (stmt.initializer && stmt.initializer.type === "StringLiteral" && stmt.initializer.rawValue !== undefined) {
          const strPtr = parseInt(stmt.initializer.rawValue);
          initExpr = type === binaryen.i64 ? this.module.i64.const(BigInt(strPtr)) : this.module.i32.const(strPtr);
        } else if (stmt.initializer) {
          throw new Error(`Unsupported initializer for global '${stmt.name}': only number and string literals are allowed at global scope`);
        }
        this.module.addGlobal(stmt.name, type, true, initExpr);
      } else if (stmt.type === "ClassDeclaration") {
        let offset = 0;
        let maxSize = 0;
        const members = new Map<string, { offset: number, type: binaryen.Type, pointerDepth?: number, holycType?: string, isArray?: boolean }>();
        let maxAlign = 1;

        for (const mem of stmt.members) {
           let memberSize = 8;
           let align = 8;
           
           if (mem.pointerDepth === 0) {
               if (mem.varType === "I8" || mem.varType === "U8") { memberSize = 1; align = 1; }
               else if (mem.varType === "I16" || mem.varType === "U16") { memberSize = 2; align = 2; }
               else if (mem.varType === "I32" || mem.varType === "U32") { memberSize = 4; align = 4; }
               else if (this.classLayouts.has(mem.varType)) {
                   const layout = this.classLayouts.get(mem.varType)!;
                   memberSize = layout.size;
                   align = layout.align || 8;
               }
           }
           
           if (!stmt.isUnion && offset % align !== 0) {
               offset += align - (offset % align);
           }

           const type = this.mapType(mem.varType, mem.pointerDepth);
           members.set(mem.name, { offset, type, pointerDepth: mem.pointerDepth, holycType: mem.varType, isArray: !!mem.arraySize });
           
           if (mem.arraySize && mem.arraySize.type === "NumberLiteral") {
                memberSize *= Number(mem.arraySize.value);
           }
           
           maxAlign = Math.max(maxAlign, align);
           maxSize = Math.max(maxSize, memberSize);
           if (!stmt.isUnion) offset += memberSize;
        }
        
        if (!stmt.isUnion && offset % maxAlign !== 0) {
            offset += maxAlign - (offset % maxAlign);
        }
        this.classLayouts.set(stmt.name, { size: stmt.isUnion ? maxSize : offset, align: maxAlign, members });
      } else {
        globalStmts.push(stmt);
      }
    }
    
    if (globalStmts.length > 0) {
      const startFunc: AST.FunctionDeclaration = {
        type: "FunctionDeclaration",
        returnType: "U0",
        name: "_start",
        params: [],
        body: { type: "BlockStatement", body: globalStmts }
      };
      functions.push(startFunc);
      this.functions.set("_start", startFunc);
    }
    
    this.module.addGlobal("__vararg_ptr", binaryen.i32, true, this.module.i32.const(0x30000));
    for (const func of functions) {
       this.generateFunction(func);
    }
    
    if (this.functionTableMap.size > 0) {
       this.module.addFunction("__null_func", binaryen.none, binaryen.none, [], this.module.unreachable());
       const tableArr = new Array(this.functionTableMap.size + 1).fill("__null_func");
       for (const [name, index] of this.functionTableMap.entries()) {
           tableArr[index] = name;
       }
       this.module.addTable("0", tableArr.length, tableArr.length);
       this.module.addActiveElementSegment("0", "0", tableArr, this.module.i32.const(0));
       this.module.addTableExport("0", "table");
    }

    if (!this.module.validate()) {
      throw new Error("Binaryen validation failed! The generated Wasm is invalid.");
    }
    this.module.runPasses(["asyncify"]);
    return this.module.emitBinary();
  }

  private generateFunction(node: AST.FunctionDeclaration) {
    const returnType = this.mapType(node.returnType);
    this.scopes = [new Map()];
    this.currentLocalTypes = [];
    this.currentLocalsWithAddressTaken.clear();
    
    const localsWithAddressTaken = this.currentLocalsWithAddressTaken;
    const scanExpression = (expr: AST.Expression) => {
      if (expr.type === "UnaryExpression" && expr.operator === "&" && expr.argument.type === "Identifier") localsWithAddressTaken.add(expr.argument.name);
      if (expr.type === "BinaryExpression") { scanExpression(expr.left); scanExpression(expr.right); }
      if (expr.type === "CallExpression") expr.arguments.forEach(scanExpression);
      if (expr.type === "AssignmentExpression") { scanExpression(expr.left); scanExpression(expr.right); }
      if (expr.type === "UpdateExpression") scanExpression(expr.argument);
      if (expr.type === "TernaryExpression") { scanExpression(expr.test); scanExpression(expr.consequent); scanExpression(expr.alternate); }
      if (expr.type === "IndexExpression") { scanExpression(expr.object); scanExpression(expr.index); }
      if (expr.type === "MemberExpression") scanExpression(expr.object);
      if (expr.type === "ArrayLiteral") expr.elements.forEach(scanExpression);
    };
    const scanStatement = (stmt: AST.Statement) => {
       if (stmt.type === "ExpressionStatement") scanExpression(stmt.expression);
       if (stmt.type === "IfStatement") { scanExpression(stmt.test); scanStatement(stmt.consequent); if (stmt.alternate) scanStatement(stmt.alternate); }
       if (stmt.type === "ReturnStatement" && stmt.argument) scanExpression(stmt.argument);
       if (stmt.type === "VariableDeclaration" && stmt.initializer) scanExpression(stmt.initializer);
       if (stmt.type === "WhileStatement") { scanExpression(stmt.test); scanStatement(stmt.body); }
       if (stmt.type === "SwitchStatement") {
          scanExpression(stmt.discriminant);
          for (const c of stmt.cases) {
             if (c.test) scanExpression(c.test);
             if (c.rangeEnd) scanExpression(c.rangeEnd);
             c.consequent.forEach(scanStatement);
          }
       }
       if (stmt.type === "TryStatement") {
          stmt.block.body.forEach(scanStatement);
          stmt.handler.body.forEach(scanStatement);
       }
       if (stmt.type === "BlockStatement") stmt.body.forEach(scanStatement);
       if (stmt.type === "ForStatement") {
          if (stmt.init) scanStatement(stmt.init);
          if (stmt.test) scanExpression(stmt.test);
          if (stmt.update) scanExpression(stmt.update);
          scanStatement(stmt.body);
       }
    };
    node.body.body.forEach(scanStatement);

    const paramTypes = node.params.map(p => this.mapType(p.varType, p.pointerDepth));
    if (node.isVararg) {
        paramTypes.push(binaryen.i64); // argc
        paramTypes.push(binaryen.i64); // argv
    }
    const wasmParamTypes = binaryen.createType(paramTypes);
    
    this.currentLocalBaseIndex = node.params.length;
    if (node.isVararg) {
        this.scopes[0]!.set("argc", { index: this.currentLocalBaseIndex++, type: binaryen.i64, pointerDepth: 0, holycType: "I64", isMemLocal: false });
        this.scopes[0]!.set("argv", { index: this.currentLocalBaseIndex++, type: binaryen.i64, pointerDepth: 1, holycType: "I64", isMemLocal: false });
    }

    const prologue: binaryen.ExpressionRef[] = [];
    node.params.forEach((p, i) => {
      const className = this.classLayouts.has(p.varType) ? p.varType : undefined;
      const addrTaken = localsWithAddressTaken.has(p.name);
      if (!className && addrTaken) {
          const slotIdx = this.currentLocalBaseIndex + this.currentLocalTypes.length;
          this.currentLocalTypes.push(binaryen.i64);
          prologue.push(
              this.module.local.set(slotIdx,
                  this.module.call("MAlloc", [this.module.i64.const(8n)], binaryen.i64)),
              this.module.i64.store(0, 8,
                  this.module.i32.wrap(this.module.local.get(slotIdx, binaryen.i64)),
                  this.module.local.get(i, paramTypes[i]!))
          );
          this.scopes[0]!.set(p.name, { index: slotIdx, type: paramTypes[i]!, isMemLocal: true, pointerDepth: p.pointerDepth, holycType: p.varType });
      } else {
          this.scopes[0]!.set(p.name, { index: i, type: paramTypes[i]!, className, isMemLocal: addrTaken, pointerDepth: p.pointerDepth, holycType: p.varType });
      }
    });

    this.currentFnReturnsValue = returnType !== binaryen.none;
    const bodyRef = this.generateStatement(node.body);
    const bodyExpr = prologue.length > 0 ? this.module.block(null, [...prologue, bodyRef]) : bodyRef;
    this.module.addFunction(node.name, wasmParamTypes, returnType, this.currentLocalTypes, bodyExpr);
    this.module.addFunctionExport(node.name, node.name);
  }

  private isUnsignedExpr(e: AST.Expression): boolean {
      const r = this.resolveExprType(e);
      return r.depth === 0 && (r.t === "U8" || r.t === "U16" || r.t === "U32" || r.t === "U64");
  }

  private generateStatement(stmt: AST.Statement): binaryen.ExpressionRef {
    switch (stmt.type) {
      case "VariableDeclaration": {
          const type = this.mapType(stmt.varType, stmt.pointerDepth);
          const className = this.classLayouts.has(stmt.varType) ? stmt.varType : undefined;
          const isMemLocal = this.currentLocalsWithAddressTaken.has(stmt.name) || !!stmt.arraySize;
          
          const index = this.currentLocalBaseIndex + this.currentLocalTypes.length;
          this.currentLocalTypes.push(type);
          
          this.scopes[this.scopes.length - 1]!.set(stmt.name, { index, type, className, isMemLocal, pointerDepth: stmt.pointerDepth, holycType: stmt.varType, arraySize: stmt.arraySize });
          
          let initExpr = 0;
          if ((className && stmt.pointerDepth === 0) || isMemLocal) {
              // Sizes are i64 per the 64-bit ABI; MAlloc returns the pointer.
              let sizeVal: binaryen.ExpressionRef = this.module.i64.const(8n);
              if (className && stmt.pointerDepth === 0) {
                  sizeVal = this.module.i64.const(BigInt(this.classLayouts.get(className)!.size));
              } else if (stmt.arraySize) {
                  const elemBytes = (stmt.pointerDepth <= 1 && (stmt.varType === "U8" || stmt.varType === "I8")) ? 1 : 8;
                  if (stmt.arraySize.type === "NumberLiteral") {
                      sizeVal = this.module.i64.const(BigInt(Number(stmt.arraySize.value) * elemBytes));
                  } else {
                      // Non-constant array size: evaluate at runtime.
                      const elems = this.generateExpression(stmt.arraySize, binaryen.i64);
                      sizeVal = this.module.i64.mul(elems, this.module.i64.const(BigInt(elemBytes)));
                  }
              }
              initExpr = this.module.local.set(
                  index,
                  this.module.call("MAlloc", [sizeVal], binaryen.i64)
              );
          }
          
          if (stmt.initializer) {
              if (stmt.initializer.type === "UnaryExpression" && stmt.initializer.operator === "&" &&
                  stmt.initializer.argument.type === "Identifier" &&
                  this.functions.has(stmt.initializer.argument.name)) {
                  this.fnPtrVars.set(stmt.name, stmt.initializer.argument.name);
              }
              if (stmt.initializer.type === "ArrayLiteral") {
                  const stores = stmt.initializer.elements.map((el, i) => {
                      const freshPtr = this.module.i32.wrap(this.module.local.get(index, binaryen.i64));
                      const val = this.generateExpression(el);
                      return this.module.i64.store(0, 8, this.module.i32.add(freshPtr, this.module.i32.const(i * 8)), val);
                  });
                  return this.module.block(null, [initExpr ? initExpr : this.module.nop(), ...stores]);
              }
              const val = this.generateExpression(stmt.initializer);
              if (initExpr) {
                 const ptr = this.module.i32.wrap(this.module.local.get(index, binaryen.i64));
                 return this.module.block(null, [
                    initExpr,
                    this.module.i64.store(0, 8, ptr, val)
                 ]);
              } else {
                 return this.module.local.set(index, val);
              }
          }
          return initExpr ? initExpr : this.module.nop();
      }
      case "ReturnStatement": {
        if (stmt.argument) {
          const val = this.generateExpression(stmt.argument);
          if (!this.currentFnReturnsValue) {
              // U0 function: keep side effects, drop the value.
              return this.module.block(null, [this.module.drop(val), this.module.return()]);
          }
          return this.module.return(val);
        }
        return this.module.return();
      }
      case "BreakStatement": {
        if (!this.currentBreakTarget) throw new Error("Break outside of switch/loop");
        return this.module.br(this.currentBreakTarget);
      }
      case "ContinueStatement": {
        if (!this.currentContinueTarget) throw new Error("Continue outside of loop");
        return this.module.br(this.currentContinueTarget);
      }
      case "SwitchStatement": {
        if (stmt.cases.length === 0) return this.module.nop();
        
        const switchBlockName = `switch_${Math.random().toString(36).substring(7)}`;
        const oldTarget = this.currentBreakTarget;
        this.currentBreakTarget = switchBlockName;
        
        // Allocate a local variable to store the evaluated discriminant
        const discLocalIndex = this.currentLocalBaseIndex + this.currentLocalTypes.length;
        this.currentLocalTypes.push(binaryen.i64);
        
        const discInit = this.module.local.set(
            discLocalIndex, 
            this.generateExpression(stmt.discriminant, binaryen.i64)
        );
        
        let defaultIndex = -1;
        const caseBlocks: string[] = [];
        for (let i = 0; i < stmt.cases.length; i++) {
            caseBlocks.push(`case_${Math.random().toString(36).substring(7)}`);
            if (stmt.cases[i]!.test === null) defaultIndex = i;
        }
        
        const routeStmts: binaryen.ExpressionRef[] = [];
        for (let i = 0; i < stmt.cases.length; i++) {
            const c = stmt.cases[i]!;
            if (c.test !== null) {
                const testVal = this.generateExpression(c.test);
                let cond: binaryen.ExpressionRef;
                if (c.rangeEnd) {
                    const endVal = this.generateExpression(c.rangeEnd);
                    cond = this.module.i32.and(
                        this.module.i64.ge_s(this.module.local.get(discLocalIndex, binaryen.i64), testVal),
                        this.module.i64.le_s(this.module.local.get(discLocalIndex, binaryen.i64), endVal)
                    );
                } else {
                    cond = this.module.i64.eq(this.module.local.get(discLocalIndex, binaryen.i64), testVal);
                }
                routeStmts.push(this.module.br(caseBlocks[i]!, cond));
            }
        }
        if (defaultIndex !== -1) {
            routeStmts.push(this.module.br(caseBlocks[defaultIndex]!));
        } else {
            routeStmts.push(this.module.br(switchBlockName));
        }
        
        let currentBlockExpr = this.module.block(caseBlocks[0]!, routeStmts);
        for (let i = 0; i < stmt.cases.length; i++) {
            const bodyStmts = stmt.cases[i]!.consequent.map(s => this.generateStatement(s));
            if (i < stmt.cases.length - 1) {
                const blockContent: binaryen.ExpressionRef[] = [ currentBlockExpr, ...bodyStmts ];
                currentBlockExpr = this.module.block(caseBlocks[i + 1]!, blockContent);
            } else {
                currentBlockExpr = this.module.block(switchBlockName, [ currentBlockExpr, ...bodyStmts ]);
            }
        }
        
        this.currentBreakTarget = oldTarget;
        return this.module.block(null, [discInit, currentBlockExpr]);
      }
      case "TryStatement": {
        const tryName = `try_${Math.random().toString(36).substring(7)}`;
        const catchName = `catch_${Math.random().toString(36).substring(7)}`;
        
        const oldCatchTarget = this.currentCatchTarget;
        this.currentCatchTarget = catchName;
        
        const tryStmts = stmt.block.body.map(s => this.generateStatement(s));
        tryStmts.push(this.module.br(tryName));
        
        this.currentCatchTarget = oldCatchTarget;
        
        const catchStmts = stmt.handler.body.map(s => this.generateStatement(s));
        
        return this.module.block(tryName, [
            this.module.block(catchName, tryStmts),
            ...catchStmts
        ]);
      }
      case "ThrowStatement": {
        if (!this.currentCatchTarget) {
            return this.module.unreachable();
        }
        return this.module.br(this.currentCatchTarget);
      }
      case "ExpressionStatement": {
        const exprRef = this.generateExpression(stmt.expression);
        const type = binaryen.getExpressionInfo(exprRef).type;
        if (type === binaryen.none || type === binaryen.unreachable) {
          return exprRef;
        }
        return this.module.drop(exprRef);
      }
      case "IfStatement": {
        const test = this.generateExpression(stmt.test);
        const consequent = this.generateStatement(stmt.consequent);
        const alternate = stmt.alternate ? this.generateStatement(stmt.alternate) : undefined;
        // Wasm if expects i32 for condition. Since HolyC is all i64, we wrap it to i32.
        const condition = this.module.i32.wrap(test);
        return this.module.if(condition, consequent, alternate);
      }
      case "BlockStatement": {
        this.scopes.push(new Map());
        const exprs = stmt.body.map(s => this.generateStatement(s));
        this.scopes.pop();
        return this.module.block(null, exprs);
      }
      case "WhileStatement": {
        const uid = this.nextLabelId++;
        const loopName = `while_loop_${uid}`;
        const blockName = `while_block_${uid}`;
        
        const oldBreak = this.currentBreakTarget;
        const oldContinue = this.currentContinueTarget;
        this.currentBreakTarget = blockName;
        this.currentContinueTarget = loopName;
        const body = this.generateStatement(stmt.body);
        this.currentBreakTarget = oldBreak;
        this.currentContinueTarget = oldContinue;
        
        const test = this.module.i32.wrap(this.generateExpression(stmt.test, binaryen.i64));
        
        const loopBody = this.module.block(blockName, [
          this.module.br(blockName, this.module.i32.eqz(test)),
          body,
          this.module.br(loopName)
        ]);
        return this.module.loop(loopName, loopBody);
      }
      case "ForStatement": {
        this.scopes.push(new Map());
        const exprs: binaryen.ExpressionRef[] = [];
        if (stmt.init) {
            // Parser wraps multi-declaration inits in a synthetic block;
            // flatten it so the loop scope (not a temporary one) holds them.
            if (stmt.init.type === "BlockStatement") stmt.init.body.forEach(s => exprs.push(this.generateStatement(s)));
            else exprs.push(this.generateStatement(stmt.init));
        }
        
        const uid = this.nextLabelId++;
        const loopName = `loop_${uid}`;
        const blockName = `block_${uid}`;
        const contName = `cont_${uid}`;
        
        const test = stmt.test ? this.module.i32.wrap(this.generateExpression(stmt.test, binaryen.i64)) : this.module.i32.const(1);
        
        let update = this.module.nop();
        if (stmt.update) {
            const updateExpr = this.generateExpression(stmt.update, binaryen.i64);
            const type = binaryen.getExpressionInfo(updateExpr).type;
            if (type !== binaryen.none && type !== binaryen.unreachable) update = this.module.drop(updateExpr);
            else update = updateExpr;
        }
        
        const oldBreak = this.currentBreakTarget;
        const oldContinue = this.currentContinueTarget;
        this.currentBreakTarget = blockName;
        this.currentContinueTarget = contName;
        const body = this.generateStatement(stmt.body);
        this.currentBreakTarget = oldBreak;
        this.currentContinueTarget = oldContinue;
        
        // `continue` branches to contName, which exits the inner block right
        // before the update expression runs (C semantics).
        const loopBody = this.module.block(blockName, [
          this.module.br(blockName, this.module.i32.eqz(test)),
          this.module.block(contName, [body]),
          update,
          this.module.br(loopName)
        ]);
        
        exprs.push(this.module.loop(loopName, loopBody));
        this.scopes.pop();
        return this.module.block(null, exprs);
      }
      default:
        throw new Error(`Code generation for statement type ${stmt.type} not implemented yet`);
    }
  }

  private generateExpression(expr: AST.Expression, expectedType?: binaryen.Type): binaryen.ExpressionRef {
    switch (expr.type) {
      case "NumberLiteral": {
        const raw = expr.rawValue || "";
        const isHex = /^0[xX]/.test(raw);
        const looksFloat = !isHex && /[.eE]/.test(raw);
        if (expectedType === binaryen.f64 || looksFloat || (!raw && !Number.isInteger(expr.value))) {
          return this.module.f64.const(expr.value);
        }
        return this.module.i64.const(raw ? BigInt(raw) : BigInt(expr.value)); 
      }
      case "StringLiteral": {
        const ptr = parseInt(expr.rawValue!);
        return this.module.i64.const(BigInt(ptr));
      }
      case "Identifier": {
        const localDecl = this.getLocal(expr.name);
        if (localDecl) {
          const { index, type, isMemLocal, className, arraySize } = localDecl;
          
          if (arraySize) {
             return this.module.local.get(index, binaryen.i64); 
          }
          
          if (isMemLocal && !className) {
             const ptr32 = this.module.i32.wrap(this.module.local.get(index, binaryen.i64));
             const load = this.module.i64.load(0, 8, ptr32);
             if (type === binaryen.f64) return this.module.f64.reinterpret(load);
             return load;
          }
          return this.module.local.get(index, type);
        }
        
        if (this.globalTypes.has(expr.name)) {
            const globalDef = this.globalTypes.get(expr.name)!;
            return this.module.global.get(expr.name, globalDef.type);
        }
        
        if (this.functions.has(expr.name) || ["Yield"].includes(expr.name)) {
            return this.generateExpression({ type: "CallExpression", callee: expr.name, arguments: [] } as AST.CallExpression);
        }

        throw new Error(`Undefined identifier: ${expr.name}`);
      }
      case "BinaryExpression": {
        
        if (expr.operator === "&&" || expr.operator === "||") {
          const isAnd = expr.operator === "&&";
          const leftRef = this.generateExpression(expr.left);
          const cond = binaryen.getExpressionType(leftRef) === binaryen.f64
              ? this.module.f64.ne(leftRef, this.module.f64.const(0))
              : this.module.i64.ne(leftRef, this.module.i64.const(0n));

          const rhsAsBool = () => {
              const r = this.generateExpression(expr.right);
              if (binaryen.getExpressionType(r) === binaryen.f64)
                  return this.module.i64.extend_u(this.module.f64.ne(r, this.module.f64.const(0)));
              return this.module.i64.extend_u(this.module.i64.ne(r, this.module.i64.const(0n)));
          };

          // a && b  ==>  if (a != 0) bool(b) else 0
          // a || b  ==>  if (a != 0) 1 else bool(b)
          const thenVal = isAnd ? rhsAsBool() : this.module.i64.const(1n);
          const elseVal = isAnd ? this.module.i64.const(0n) : rhsAsBool();
          return this.module.if(cond, thenVal, elseVal);
        }

        let left = this.generateExpression(expr.left);
        let right = this.generateExpression(expr.right);
        let isF64 = binaryen.getExpressionType(left) === binaryen.f64 || binaryen.getExpressionType(right) === binaryen.f64;
        
        if (isF64) {
           if (binaryen.getExpressionType(left) === binaryen.i64) left = this.module.f64.convert_s.i64(left);
           if (binaryen.getExpressionType(right) === binaryen.i64) right = this.module.f64.convert_s.i64(right);
        }

        if (!isF64 && (expr.operator === "+" || expr.operator === "-")) {
           const scaleFor = (e: AST.Expression): number => {
               const r = this.resolveExprType(e);
               if (r.depth >= 1) return this.pointeeWidth(r.t, r.depth);
               return 0;
           };
           const lBytes = scaleFor(expr.left);
           const rBytes = scaleFor(expr.right);
           
           if (lBytes > 1 && rBytes === 0) {
               right = this.module.i64.mul(right, this.module.i64.const(BigInt(lBytes)));
           } else if (rBytes > 1 && lBytes === 0 && expr.operator === "+") {
               left = this.module.i64.mul(left, this.module.i64.const(BigInt(rBytes)));
           }
        }
        
        const unsigned = !isF64 && (this.isUnsignedExpr(expr.left) || this.isUnsignedExpr(expr.right));

        switch (expr.operator) {
          case "<<": return this.module.i64.shl(left, right);
          case ">>": return unsigned ? this.module.i64.shr_u(left, right) : this.module.i64.shr_s(left, right);
          case "+": return isF64 ? this.module.f64.add(left, right) : this.module.i64.add(left, right);
          case "-": return isF64 ? this.module.f64.sub(left, right) : this.module.i64.sub(left, right);
          case "*": return isF64 ? this.module.f64.mul(left, right) : this.module.i64.mul(left, right);
          case "/": return isF64 ? this.module.f64.div(left, right)
                    : unsigned ? this.module.i64.div_u(left, right) : this.module.i64.div_s(left, right);
          case "%":
            if (isF64) throw new Error("Modulo on floats not supported.");
            return unsigned ? this.module.i64.rem_u(left, right) : this.module.i64.rem_s(left, right);
          case "|":
            if (isF64) throw new Error("Bitwise OR on floats not supported.");
            return this.module.i64.or(left, right);
          case "^":
            if (isF64) throw new Error("Bitwise XOR on floats not supported.");
            return this.module.i64.xor(left, right);
          case "&":
            if (isF64) throw new Error("Bitwise AND on floats not supported.");
            return this.module.i64.and(left, right);
          case "==": {
            const eq = isF64 ? this.module.f64.eq(left, right) : this.module.i64.eq(left, right);
            return this.module.i64.extend_u(eq);
          }
          case "!=": {
            const ne = isF64 ? this.module.f64.ne(left, right) : this.module.i64.ne(left, right);
            return this.module.i64.extend_u(ne);
          }
          case "<": {
            const lt = isF64 ? this.module.f64.lt(left, right)
                     : unsigned ? this.module.i64.lt_u(left, right) : this.module.i64.lt_s(left, right);
            return this.module.i64.extend_u(lt);
          }
          case "<=": {
            const le = isF64 ? this.module.f64.le(left, right)
                      : unsigned ? this.module.i64.le_u(left, right) : this.module.i64.le_s(left, right);
            return this.module.i64.extend_u(le);
          }
          case ">": {
            const gt = isF64 ? this.module.f64.gt(left, right)
                      : unsigned ? this.module.i64.gt_u(left, right) : this.module.i64.gt_s(left, right);
            return this.module.i64.extend_u(gt);
          }
          case ">=": {
            const ge = isF64 ? this.module.f64.ge(left, right)
                      : unsigned ? this.module.i64.ge_u(left, right) : this.module.i64.ge_s(left, right);
            return this.module.i64.extend_u(ge);
          }
          default: throw new Error(`Operator ${expr.operator} not implemented`);
        }
      }
      case "UnaryExpression": {
        if (expr.operator === "-") {
          const arg = this.generateExpression(expr.argument);
          const type = binaryen.getExpressionType(arg);
          if (type === binaryen.f64) return this.module.f64.neg(arg);
          return this.module.i64.sub(this.module.i64.const(0n), arg);
        }
        if (expr.operator === "!") {
          const arg = this.generateExpression(expr.argument);
          return this.module.i64.extend_u(this.module.i64.eq(arg, this.module.i64.const(0n)));
        }
        if (expr.operator === "*") {
          // Resolve the pointee type so the load width matches (e.g. *u8Ptr
          // loads a single byte instead of clobbering 8).
          const r = this.resolveExprType(expr.argument);
          const ptrExpr = this.generateExpression(expr.argument);
          const ptr32 = this.module.i32.wrap(ptrExpr);
          if (r.t === "F64") return this.module.f64.load(0, 8, ptr32);
          const w = this.elemByteWidth(r.t);
          if (w === 1) return this.module.i64.extend_u(this.module.i32.load8_u(0, 1, ptr32));
          if (w === 2) return this.module.i64.extend_u(this.module.i32.load16_u(0, 2, ptr32));
          if (w === 4) return this.module.i64.extend_u(this.module.i32.load(0, 4, ptr32));
          return this.module.i64.load(0, 8, ptr32);
        }
        if (expr.operator === "&") {
          if (expr.argument.type === "Identifier") {
             const localDecl = this.getLocal(expr.argument.name);
             if (localDecl) {
                const { index, isMemLocal, className } = localDecl;
                if (isMemLocal || className) return this.module.local.get(index, binaryen.i64);
             }
             if (this.functions.has(expr.argument.name)) {
                 let tableIndex = this.functionTableMap.get(expr.argument.name);
                 if (tableIndex === undefined) {
                     tableIndex = this.functionTableMap.size + 1;
                     this.functionTableMap.set(expr.argument.name, tableIndex);
                 }
                 return this.module.i64.const(BigInt(tableIndex));
             }
          }
          return this.module.i64.const(BigInt(0x20000));
        }
        throw new Error(`Unary operator ${expr.operator} not implemented`);
      }
      case "UpdateExpression": {
        const isPlus = expr.operator === "++";

        if (expr.argument.type !== "Identifier") {
            throw new Error(`UpdateExpression on complex target not fully implemented`);
        }
        const name = expr.argument.name;

        const localDecl = this.getLocal(name);
        if (localDecl) {
            const { index, type, isMemLocal, className } = localDecl;

            if (isMemLocal && !className) {
              
                const mkPtr = () => this.module.i32.wrap(this.module.local.get(index, binaryen.i64));
                const tmp = this.allocTemp(type);
                const oldVal = type === binaryen.f64
                    ? this.module.f64.load(0, 8, mkPtr())
                    : this.module.i64.load(0, 8, mkPtr());
                const newVal = this.arithOne(oldVal, type, isPlus);
                const stored = type === binaryen.f64
                    ? this.module.i64.reinterpret(this.module.local.get(tmp, type))
                    : this.module.local.get(tmp, type);
                const ops: binaryen.ExpressionRef[] = [
                    this.module.local.set(tmp, newVal),
                    this.module.i64.store(0, 8, mkPtr(), stored)
                ];
                if (expr.prefix) ops.push(this.module.local.get(tmp, type));
                else ops.push(this.arithOne(this.module.local.get(tmp, type), type, !isPlus));
                return this.module.block(null, ops, type);
            }

            const oldVal = this.module.local.get(index, type);
            const newVal = this.arithOne(oldVal, type, isPlus);
            const teeNewVal = this.module.local.tee(index, newVal, type);

            if (expr.prefix) return teeNewVal;
            return this.arithOne(teeNewVal, type, !isPlus);
        }

        if (this.globalTypes.has(name)) {
            const globalDef = this.globalTypes.get(name)!;
            const gt = globalDef.type;
     
            //asyncify is stupid so we must make it so we dont share subtrees
            const tmp = this.allocTemp(gt);
            const newVal = this.arithOne(this.module.global.get(name, gt), gt, isPlus);
            const ops: binaryen.ExpressionRef[] = [
                this.module.local.set(tmp, newVal),
                this.module.global.set(name, this.module.local.get(tmp, gt))
            ];
            if (expr.prefix) ops.push(this.module.local.get(tmp, gt));
            else ops.push(this.arithOne(this.module.local.get(tmp, gt), gt, !isPlus));
            return this.module.block(null, ops, gt);
        }

        throw new Error(`Undefined identifier in update expression: ${name}`);
      }
      case "MemberExpression": {
        if (expr.object.type === "Identifier" && expr.object.name === "Fs") {
            const fsBase = this.module.i32.const(0x10000);
            const memberOffset = 0;
            return this.module.i64.load(0, 8, this.module.i32.add(fsBase, this.module.i32.const(memberOffset)));
        }

        const resolved = this.resolveExprType(expr.object);
        const className = resolved.t;
        
        if (!className || !this.classLayouts.has(className)) throw new Error("Unknown class type for member access");
        const layout = this.classLayouts.get(className)!;
        const member = layout.members.get(expr.property);
        if (!member) throw new Error(`Member ${expr.property} not found`);
        
        const objectExpr = this.generateExpression(expr.object, binaryen.i64);
        const ptr32 = this.module.i32.wrap(objectExpr);
        const offsetPtr = this.module.i32.add(ptr32, this.module.i32.const(member.offset));
        
        if (member.isArray) {
            return this.module.i64.extend_u(offsetPtr);
        }
        
        if (member.type === binaryen.f64) return this.module.f64.load(0, 8, offsetPtr);
        if (member.pointerDepth === 0) {
            if (member.holycType === "U8" || member.holycType === "I8") return this.module.i64.extend_u(this.module.i32.load8_u(0, 1, offsetPtr));
            if (member.holycType === "U16" || member.holycType === "I16") return this.module.i64.extend_u(this.module.i32.load16_u(0, 2, offsetPtr));
            if (member.holycType === "U32" || member.holycType === "I32") return this.module.i64.extend_u(this.module.i32.load(0, 4, offsetPtr));
        }
        return this.module.i64.load(0, 8, offsetPtr);
      }
      case "IndexExpression": {
        const objectExpr = this.generateExpression(expr.object, binaryen.i64);
        const indexExpr = this.generateExpression(expr.index, binaryen.i64);
        
        const resolved = this.resolveExprType(expr.object);
        const holycType = resolved.t;
        const pointerDepth = resolved.depth;
        
        const ptr32 = this.module.i32.wrap(objectExpr);
        const index32 = this.module.i32.wrap(indexExpr);
        
        let bytes = 8;

        
        if (pointerDepth <= 1 && (holycType === "U8" || holycType === "I8")) bytes = 1;
        else if (pointerDepth <= 1 && (holycType === "U16" || holycType === "I16")) bytes = 2;
        else if (pointerDepth <= 1 && (holycType === "U32" || holycType === "I32")) bytes = 4;
        
        const byteOffset = bytes === 1 ? index32 : this.module.i32.mul(index32, this.module.i32.const(bytes));
        const finalPtr = this.module.i32.add(ptr32, byteOffset);
        
        if (bytes === 1) return this.module.i64.extend_u(this.module.i32.load8_u(0, 1, finalPtr));
        if (bytes === 2) return this.module.i64.extend_u(this.module.i32.load16_u(0, 2, finalPtr));
        if (bytes === 4) return this.module.i64.extend_u(this.module.i32.load(0, 4, finalPtr));
        return this.module.i64.load(0, 8, finalPtr);
      }
      case "AssignmentExpression": {
      
        const right = this.generateExpression(expr.right);
        const rightType = binaryen.getExpressionType(right);

        if (expr.left.type === "Identifier") {
          if (expr.right.type === "UnaryExpression" && expr.right.operator === "&" &&
              expr.right.argument.type === "Identifier" &&
              this.functions.has(expr.right.argument.name)) {
              this.fnPtrVars.set(expr.left.name, expr.right.argument.name);
          }
          const localDecl = this.getLocal(expr.left.name);
          if (localDecl) {
            const { index, type, isMemLocal, className } = localDecl;
            if (isMemLocal && !className) {
               const ptr32 = this.module.i32.wrap(this.module.local.get(index, binaryen.i64));
               const tmp = this.allocTemp(type);
               const stored = type === binaryen.f64
                   ? this.module.i64.reinterpret(this.module.local.get(tmp, type))
                   : this.module.local.get(tmp, type);
               return this.module.block(null, [
                 this.module.local.set(tmp, right),
                 this.module.i64.store(0, 8, ptr32, stored),
                 this.module.local.get(tmp, type)
               ], type);
            }
            return this.module.local.tee(index, right, type);
          }
          
          if (this.globalTypes.has(expr.left.name)) {
              const tmp = this.allocTemp(rightType);
              return this.module.block(null, [
                 this.module.local.set(tmp, right),
                 this.module.global.set(expr.left.name, this.module.local.get(tmp, rightType)),
                 this.module.local.get(tmp, rightType)
              ], rightType);
          }
        } else if (expr.left.type === "UnaryExpression" && expr.left.operator === "*") {
          const r = this.resolveExprType(expr.left.argument);
          const width = this.elemByteWidth(r.t);
          let valToStore = right;
          if (r.t === "F64" && rightType === binaryen.i64) {
              valToStore = this.module.f64.convert_s.i64(right);
          }
          const storedType = binaryen.getExpressionType(valToStore);

          const ptrExpr = this.generateExpression(expr.left.argument);
          const ptr32 = this.module.i32.wrap(ptrExpr);
          const tmp = this.allocTemp(storedType);
          return this.module.block(null, [
             this.module.local.set(tmp, valToStore),
             this.buildStore(width, ptr32, this.module.local.get(tmp, storedType), storedType),
             this.module.local.get(tmp, storedType)
          ], storedType);
        } else if (expr.left.type === "IndexExpression") {
            const objectExpr = this.generateExpression(expr.left.object, binaryen.i64);
            const indexExpr = this.generateExpression(expr.left.index, binaryen.i64);
            
            const resolved = this.resolveExprType(expr.left.object);
            const holycType = resolved.t;
            const pointerDepth = resolved.depth;
            
            const ptr32 = this.module.i32.wrap(objectExpr);
            const index32 = this.module.i32.wrap(indexExpr);
            let bytes = 8;
            if (pointerDepth <= 1 && (holycType === "U8" || holycType === "I8")) bytes = 1;
            else if (pointerDepth <= 1 && (holycType === "U16" || holycType === "I16")) bytes = 2;
            else if (pointerDepth <= 1 && (holycType === "U32" || holycType === "I32")) bytes = 4;
            
            const byteOffset = bytes === 1 ? index32 : this.module.i32.mul(index32, this.module.i32.const(bytes));
            const finalPtr = this.module.i32.add(ptr32, byteOffset);

            const tmp = this.allocTemp(rightType);
            const storeOp = this.buildStore(bytes, finalPtr, this.module.local.get(tmp, rightType), rightType);
            return this.module.block(null, [
               this.module.local.set(tmp, right),
               storeOp,
               this.module.local.get(tmp, rightType)
            ], rightType);
        } else if (expr.left.type === "MemberExpression") {
          if (expr.left.object.type === "Identifier" && expr.left.object.name === "Fs") {
              return right;
          }

          const resolved = this.resolveExprType(expr.left.object);
          const className = resolved.t;
          if (!className || !this.classLayouts.has(className)) throw new Error(`Unknown class type for member assignment`);
          
          const layout = this.classLayouts.get(className)!;
          const member = layout.members.get(expr.left.property)!;
          const ptr32 = this.module.i32.wrap(this.generateExpression(expr.left.object));
          const offsetPtr = this.module.i32.add(ptr32, this.module.i32.const(member.offset));
          let memberBytes = 8;
          if (rightType !== binaryen.f64 && member.pointerDepth === 0) {
              if (member.holycType === "U8" || member.holycType === "I8") memberBytes = 1;
              else if (member.holycType === "U16" || member.holycType === "I16") memberBytes = 2;
              else if (member.holycType === "U32" || member.holycType === "I32") memberBytes = 4;
          }
          const tmp = this.allocTemp(rightType);
          const storeOp = this.buildStore(memberBytes, offsetPtr, this.module.local.get(tmp, rightType), rightType);
          return this.module.block(null, [
             this.module.local.set(tmp, right),
             storeOp,
             this.module.local.get(tmp, rightType)
          ], rightType);
        }
        throw new Error(`Complex assignment not fully implemented yet`);
      }
      case "TernaryExpression": {
        const cond = this.module.i32.wrap(this.generateExpression(expr.test));
        const consequent = this.generateExpression(expr.consequent);
        const alternate = this.generateExpression(expr.alternate);
        return this.module.if(cond, consequent, alternate);
      }
      case "CallExpression": {
        let callee = expr.callee;
        
        if (callee === "sizeof" && expr.arguments.length === 1 && expr.arguments[0]!.type === "Identifier") {
            const typeName = (expr.arguments[0] as AST.Identifier).name;
            let size = 8;
            if (typeName === "I8" || typeName === "U8") size = 1;
            else if (typeName === "I16" || typeName === "U16") size = 2;
            else if (typeName === "I32" || typeName === "U32") size = 4;
            else if (this.classLayouts.has(typeName)) {
                size = this.classLayouts.get(typeName)!.size;
            }
            return this.module.i64.const(BigInt(size));
        }

        let args = expr.arguments.map(arg => this.generateExpression(arg));
        
        if (typeof callee === "object") {
    
            let resolvedFn: AST.FunctionDeclaration | undefined = undefined;
            const ce = callee as AST.Expression;
            if (ce.type === "Identifier" && this.functions.has((ce as AST.Identifier).name)) {
                resolvedFn = this.functions.get((ce as AST.Identifier).name)!;
            } else if (ce.type === "UnaryExpression" && ce.operator === "&" &&
                       ce.argument.type === "Identifier" && this.functions.has(ce.argument.name)) {
                resolvedFn = this.functions.get(ce.argument.name)!;
            }

            if (resolvedFn) {
                args = this.prepareCallArgs(resolvedFn, args);
                const paramTypes = resolvedFn.params.map(p => this.mapType(p.varType, p.pointerDepth));
                return this.module.call_indirect("0",
                    this.module.i32.const(this.ensureFuncIndex(resolvedFn.name)),
                    args, binaryen.createType(paramTypes),
                    this.mapType(resolvedFn.returnType));
            }

            const targetExpr = this.generateExpression(callee as AST.Expression);
            const target32 = this.module.i32.wrap(targetExpr);
            const paramTypes = args.map(a => binaryen.getExpressionType(a));
            const callType = binaryen.createType(paramTypes);
            return this.module.call_indirect("0", target32, args, callType, binaryen.i64);
        }

        if (callee === "Print") {
           callee = `Print${args.length - 1}`;
           args = args.map(arg => {
              const t = binaryen.getExpressionType(arg);
              if (t === binaryen.f64) return this.module.i64.reinterpret(arg);
              return arg;
           });
        }
        
        if (callee.startsWith("Print") || callee === "GrLine" || callee === "Yield" || callee === "Sleep"|| callee === "Free") {
          return this.module.call(callee, args, binaryen.none);
        }
        if (callee === "Spawn") {
          return this.module.call(callee, args, binaryen.i64);
        }
        
        if (this.getLocal(callee) || this.globalTypes.has(callee)) {
           
            const targetName = this.fnPtrVars.get(callee);
            if (targetName && this.functions.has(targetName)) {
                const fd = this.functions.get(targetName)!;
                args = this.prepareCallArgs(fd, args);
                const paramTypes = fd.params.map(p => this.mapType(p.varType, p.pointerDepth));
                return this.module.call_indirect("0",
                    this.module.i32.const(this.ensureFuncIndex(targetName)),
                    args, binaryen.createType(paramTypes),
                    this.mapType(fd.returnType));
            }

            const targetExpr = this.generateExpression({ type: "Identifier", name: callee });
            const target32 = this.module.i32.wrap(targetExpr);
            const paramTypes = args.map(a => binaryen.getExpressionType(a));
            const callType = binaryen.createType(paramTypes);
            return this.module.call_indirect("0", target32, args, callType, binaryen.i64);
        }
        
        const funcDecl = this.functions.get(callee);
        if (funcDecl) {
            // Fill defaults and coerce argument types to the callee signature.
            args = this.prepareCallArgs(funcDecl, args);
            const retType = this.mapType(funcDecl.returnType);
            
            if (funcDecl.isVararg) {
                const numFixed = funcDecl.params.length;
                const fixedArgs = args.slice(0, numFixed);
                const varargExprs = args.slice(numFixed);

                if (varargExprs.length === 0) {
                    fixedArgs.push(this.module.i64.const(0n));
                    fixedArgs.push(this.module.i64.const(0n));
                    return this.module.call(callee, fixedArgs, retType);
                }

                // Save the frame base so repeated/nested calls reuse the same
                // scratch area instead of growing forever.
                const frameBase = this.allocTemp(binaryen.i32);
                const setupStmts: binaryen.ExpressionRef[] = [
                    this.module.local.set(frameBase,
                        this.module.global.get("__vararg_ptr", binaryen.i32))
                ];
                for (let i = 0; i < varargExprs.length; i++) {
                    const argVal = varargExprs[i]!;
                    const val = binaryen.getExpressionType(argVal) === binaryen.f64 ? this.module.i64.reinterpret(argVal) : argVal;
                    const ptr = this.module.i32.add(
                        this.module.local.get(frameBase, binaryen.i32),
                        this.module.i32.const(i * 8)
                    );
                    setupStmts.push(this.module.i64.store(0, 8, ptr, val));
                }

                setupStmts.push(
                    this.module.global.set("__vararg_ptr",
                        this.module.i32.add(this.module.local.get(frameBase, binaryen.i32),
                            this.module.i32.const(varargExprs.length * 8)))
                );

                fixedArgs.push(this.module.i64.const(BigInt(varargExprs.length)));
                fixedArgs.push(this.module.i64.extend_u(this.module.local.get(frameBase, binaryen.i32)));

                if (retType !== binaryen.none) {
                    const resTmp = this.allocTemp(retType);
                    setupStmts.push(this.module.local.set(resTmp,
                        this.module.call(callee, fixedArgs, retType)));
                    setupStmts.push(
                        this.module.global.set("__vararg_ptr",
                            this.module.local.get(frameBase, binaryen.i32)));
                    setupStmts.push(this.module.local.get(resTmp, retType));
                } else {
                    setupStmts.push(this.module.call(callee, fixedArgs, retType));
                    setupStmts.push(
                        this.module.global.set("__vararg_ptr",
                            this.module.local.get(frameBase, binaryen.i32)));
                }
                return this.module.block(null, setupStmts, retType);
            }
            
            return this.module.call(callee, args, retType);
        }
        
        return this.module.call(callee, args, binaryen.i64);
      }
      default:
        throw new Error(`Code generation for expression type ${(expr as any).type} not implemented yet`);
    }
  }
}

